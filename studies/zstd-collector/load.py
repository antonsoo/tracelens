# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-http==1.45.1", "protobuf==7.36.2", "zstandard==0.25.0"]
# ///
"""Capture a controlled local digest workload with real SDK clocks and exports.

This is an engineered load, not a production incident or an LLM run. Inputs
are generated; each SHA-256 is actually computed. Nothing is sent outside
loopback. The native Collector writes the compressed and plain controls.
"""

import argparse
import hashlib
import importlib.metadata
import io
import json
import re
import socket
import subprocess
import time
from pathlib import Path

import zstandard
from google.protobuf.json_format import MessageToDict
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

HERE = Path(__file__).resolve().parent
sha = lambda b: hashlib.sha256(b).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collector", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    work = args.out.resolve()
    binary = args.collector.resolve()
    original = json.loads((HERE / "fixtures/oracle.json").read_text())
    assert sha(binary.read_bytes()) == original["collectorBinarySha256"]
    with socket.socket() as endpoint:
        endpoint.bind(("127.0.0.1", 0))
        port = endpoint.getsockname()[1]
    config = re.sub(
        r"endpoint: 127\.0\.0\.1:\d+",
        f"endpoint: 127.0.0.1:{port}",
        (HERE / "fixtures/native/collector.yaml").read_text(),
    )
    (work / "collector.yaml").write_text(config)
    with (work / "collector.log").open("wb") as log:
        process = subprocess.Popen(
            [
                str(binary),
                "--config",
                "collector.yaml",
                "--feature-gates=exporter.file.nativeCompression",
            ],
            cwd=work,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    provider = None
    try:
        for _ in range(150):
            if process.poll() is not None:
                raise RuntimeError((work / "collector.log").read_text())
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.02)
        else:
            raise RuntimeError("Collector did not start")
        memory = InMemorySpanExporter()
        provider = TracerProvider(
            resource=Resource.create(
                {"service.name": "local-digest-load", "study.controlled": True}
            )
        )
        provider.add_span_processor(SimpleSpanProcessor(memory))
        exporter = OTLPSpanExporter(endpoint=f"http://127.0.0.1:{port}/v1/traces")
        provider.add_span_processor(
            BatchSpanProcessor(
                exporter,
                max_queue_size=10000,
                max_export_batch_size=512,
                schedule_delay_millis=10000,
            )
        )
        tracer = provider.get_tracer("tracelens.zstd-load", "1")
        data = bytes(range(256)) * 128
        with tracer.start_as_current_span(
            "digest 5000 generated documents",
            attributes={"gen_ai.operation.name": "invoke_workflow"},
        ):
            for number in range(5000):
                with tracer.start_as_current_span(
                    "sha256",
                    attributes={
                        "gen_ai.operation.name": "execute_tool",
                        "gen_ai.tool.name": "sha256",
                        "document.index": number,
                        "input.bytes": len(data) + 4,
                    },
                ) as span:
                    span.set_attribute(
                        "result.sha256", sha(data + number.to_bytes(4, "little"))
                    )
        assert provider.force_flush()
        spans = memory.get_finished_spans()
        assert len(spans) == 5001
        records = [
            {
                "traceId": f"{span.context.trace_id:032x}",
                "spanId": f"{span.context.span_id:016x}",
                "parentSpanId": f"{span.parent.span_id:016x}" if span.parent else None,
                "name": span.name,
                "start": str(span.start_time),
                "end": str(span.end_time),
                "attributes": dict(span.attributes),
            }
            for span in spans
        ]
        (work / "sdk-spans.json").write_text(
            json.dumps(records, separators=(",", ":")) + "\n"
        )
    finally:
        if provider:
            provider.shutdown()
        process.terminate()
        process.wait(timeout=10)
    assert process.returncode == 0
    files = []
    for ext in ["jsonl", "traces.otlp"]:
        name = f"traces.{ext}"
        plain = (work / name).read_bytes()
        zipped = (work / (name + ".zst")).read_bytes()
        with zstandard.ZstdDecompressor().stream_reader(
            io.BytesIO(zipped), read_across_frames=True
        ) as reader:
            decoded = reader.read()
        assert decoded == plain
        files.append(
            {
                "file": name + ".zst",
                "bytes": len(zipped),
                "sha256": sha(zipped),
                "decodedBytes": len(decoded),
                "decodedSha256": sha(decoded),
            }
        )
    # Google's independent runtime verifies every original SDK observation in
    # the actual Collector protobuf, without changing clocks or identifiers.
    from struct import unpack_from

    encoded = (work / "traces.traces.otlp").read_bytes()
    at = 0
    decoded_spans = []
    while at < len(encoded):
        (size,) = unpack_from(">I", encoded, at)
        at += 4
        request = ExportTraceServiceRequest.FromString(encoded[at : at + size])
        at += size
        for resource in request.resource_spans:
            for scope in resource.scope_spans:
                decoded_spans.extend(scope.spans)
    assert len(decoded_spans) == len(records)
    by_id = {record["spanId"]: record for record in records}
    for span in decoded_spans:
        record = by_id[span.span_id.hex()]
        assert span.trace_id.hex() == record["traceId"]
        assert (span.parent_span_id.hex() or None) == record["parentSpanId"]
        assert (
            str(span.start_time_unix_nano) == record["start"]
            and str(span.end_time_unix_nano) == record["end"]
        )
        assert span.name == record["name"]
        attrs = {a.key: MessageToDict(a.value) for a in span.attributes}
        for key, value in record["attributes"].items():
            assert attrs[key] == (
                {"intValue": str(value)}
                if type(value) is int
                else {"stringValue": value}
            )
    (work / "oracle.json").write_text(
        json.dumps(
            {
                "controlledWorkload": True,
                "actualComputations": 5000,
                "spanCount": len(records),
                "sdkClockAndAttributeValuesVerified": True,
                "sdkSpansSha256": sha((work / "sdk-spans.json").read_bytes()),
                "versions": {
                    name: importlib.metadata.version(name)
                    for name in [
                        "opentelemetry-sdk",
                        "opentelemetry-proto",
                        "protobuf",
                        "zstandard",
                    ]
                },
                "collectorBinarySha256": sha(binary.read_bytes()),
                "files": files,
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps({"spanCount": len(records), "files": files}))


if __name__ == "__main__":
    main()
