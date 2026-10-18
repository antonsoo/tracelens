# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-proto==1.45.1", "protobuf==7.36.2"]
# ///
"""Explicit identity-width controls, checked by the actual native Collector.

Inputs start from retained SDK requests. Altered fields are labelled below;
these are constructed protocol controls, not naturally emitted bad SDK data.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import json
import socket
import subprocess
import time
from pathlib import Path

from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
    ExportLogsServiceRequest,
)
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collector", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    binary = args.collector.resolve()
    native = json.loads((HERE.parent / "otlp-binary/fixtures/oracle.json").read_text())
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    assert binary_hash == native["collectorBinarySha256"]
    sources = {
        "traces": (
            HERE.parent / "zero-identities/fixtures/valid.traces.pb"
        ).read_bytes(),
        "logs": (HERE.parent / "otlp-binary/fixtures/http-01.logs.pb").read_bytes(),
    }
    with socket.socket() as endpoint:
        endpoint.bind(("127.0.0.1", 0))
        port = endpoint.getsockname()[1]
    work = args.out / "collector"
    work.mkdir()
    config = f"""receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:{port}
exporters:
  file/traces:
    path: traces.jsonl
  file/logs:
    path: logs.jsonl
service:
  telemetry:
    logs:
      level: error
    metrics:
      level: none
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file/traces]
    logs:
      receivers: [otlp]
      exporters: [file/logs]
"""
    (work / "collector.yaml").write_text(config)
    cases = []
    declarations = [
        ("traces", "native-control", None, None),
        ("traces", "trace-short", "trace_id", 15),
        ("traces", "trace-long", "trace_id", 17),
        ("traces", "span-short", "span_id", 7),
        ("traces", "span-long", "span_id", 9),
        ("traces", "parent-short", "parent_span_id", 7),
        ("traces", "parent-long", "parent_span_id", 9),
        ("traces", "link-trace-short", "link.trace_id", 15),
        ("traces", "link-span-long", "link.span_id", 9),
        ("traces", "empty-parent-control", "parent_span_id", 0),
        ("logs", "native-control", None, None),
        ("logs", "trace-short", "trace_id", 15),
        ("logs", "trace-long", "trace_id", 17),
        ("logs", "span-short", "span_id", 7),
        ("logs", "span-long", "span_id", 9),
        ("logs", "absent-context-control", "both", 0),
    ]
    with (work / "collector.log").open("wb") as log:
        process = subprocess.Popen(
            [str(binary), "--config", "collector.yaml"],
            cwd=work,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError((work / "collector.log").read_text())
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.05)
            for signal, name, field, width in declarations:
                message = (
                    ExportTraceServiceRequest
                    if signal == "traces"
                    else ExportLogsServiceRequest
                ).FromString(sources[signal])
                value = (
                    message.resource_spans[0].scope_spans[0].spans[0]
                    if signal == "traces"
                    else message.resource_logs[0].scope_logs[0].log_records[0]
                )
                if field is not None:
                    if field == "both":
                        value.trace_id = value.span_id = b""
                    elif field.startswith("link."):
                        link = value.links.add(
                            trace_id=value.trace_id, span_id=value.span_id
                        )
                        setattr(link, field.split(".")[1], b"1" * width)
                    else:
                        setattr(value, field, b"1" * width)
                body = message.SerializeToString()
                filename = f"{name}.{signal}.pb"
                (args.out / filename).write_bytes(body)
                # The official generic Protobuf schema accepts all byte lengths.
                assert type(message).FromString(body) == message
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                try:
                    connection.request(
                        "POST",
                        f"/v1/{signal}",
                        body,
                        {"Content-Type": "application/x-protobuf"},
                    )
                    response = connection.getresponse()
                    status, reply = response.status, response.read()
                finally:
                    connection.close()
                expected = field is None or width == 0
                assert status == (200 if expected else 400), (name, status, reply)
                cases.append(
                    {
                        "file": filename,
                        "signal": signal,
                        "origin": "unaltered retained SDK request"
                        if field is None
                        else "constructed byte-field alteration",
                        "alteredField": field,
                        "width": width,
                        "sha256": hashlib.sha256(body).hexdigest(),
                        "googleWireAccepted": True,
                        "collectorStatus": status,
                        "collectorAccepted": expected,
                        "collectorResponseBase64": base64.b64encode(reply).decode(),
                    }
                )
        finally:
            process.terminate()
            process.wait(timeout=10)
    exports = []
    for signal, key, scope_key, item_key in [
        ("traces", "resourceSpans", "scopeSpans", "spans"),
        ("logs", "resourceLogs", "scopeLogs", "logRecords"),
    ]:
        path = work / f"{signal}.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines() if line]
        count = sum(
            len(scope.get(item_key, []))
            for row in rows
            for resource in row.get(key, [])
            for scope in resource.get(scope_key, [])
        )
        assert len(rows) == 2 and count == (4 if signal == "traces" else 2)
        exports.append(
            {
                "file": f"collector/{signal}.jsonl",
                "batches": len(rows),
                "records": count,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    result = {
        "scope": __doc__,
        "collectorVersion": subprocess.check_output(
            [str(binary), "--version"], text=True
        ).strip(),
        "collectorBinarySha256": binary_hash,
        "captureSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "cases": cases,
        "collectorExports": exports,
    }
    (args.out / "oracle.json").write_text(json.dumps(result, indent=2) + "\n")
    print(
        f"Native Collector: {sum(row['collectorAccepted'] for row in cases)} controls accepted, {sum(not row['collectorAccepted'] for row in cases)} wrong-width inputs refused"
    )


if __name__ == "__main__":
    main()
