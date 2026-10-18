# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-http==1.45.1", "protobuf==7.36.2"]
# ///
"""Native SDK fault controls: an explicitly broken custom ID generator.

SDK SpanContext.is_valid is observed before serialization. This does not claim
the default SDK generator produces zero IDs. No network or model calls occur.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path

from google.protobuf.json_format import MessageToDict
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.sdk.trace.id_generator import IdGenerator


class DeclaredIds(IdGenerator):
    def __init__(self, trace_id: int, span_id: int):
        self.trace_id = trace_id
        self.span_id = span_id

    def generate_trace_id(self) -> int:
        return self.trace_id

    def generate_span_id(self) -> int:
        value = self.span_id
        self.span_id += 1
        return value


class Retain(SpanExporter):
    def __init__(self):
        self.spans = []

    def export(self, spans):
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    observations, all_spans, files = [], [], []
    valid_trace = 0xAABBCCDDEEFF00112233445566778899
    for name, trace_id, span_id, count in [
        ("zero-trace", 0, 4, 3),
        ("zero-span", valid_trace, 0, 1),
        ("both-zero", 0, 0, 1),
        ("valid", valid_trace, 1, 2),
    ]:
        exporter = Retain()
        provider = TracerProvider(
            id_generator=DeclaredIds(trace_id, span_id),
            resource=Resource({"service.name": "declared-id-generator-control"}),
        )
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        tracer = provider.get_tracer("zero-identity-study")
        for index in range(count):
            with tracer.start_as_current_span(
                f"{name}-{index + 1}",
                attributes={
                    "gen_ai.operation.name": "chat",
                    "gen_ai.request.model": "scripted-response",
                    "gen_ai.usage.input_tokens": 10 if name == "valid" else 1000,
                },
            ) as span:
                context = span.get_span_context()
                observations.append(
                    {
                        "name": f"{name}-{index + 1}",
                        "traceId": f"{context.trace_id:032x}",
                        "spanId": f"{context.span_id:016x}",
                        "sdkIsValid": context.is_valid,
                        "recording": span.is_recording(),
                    }
                )
        provider.shutdown()
        assert len(exporter.spans) == count
        all_spans.extend(exporter.spans)
        files.append((name, encode_spans(exporter.spans)))
    files.append(("mixed", encode_spans(all_spans)))
    records = []
    for name, message in files:
        for suffix, contents in [
            ("traces.pb", message.SerializeToString()),
            ("json", (json.dumps(MessageToDict(message), indent=2) + "\n").encode()),
            (
                "snake.json",
                (
                    json.dumps(
                        MessageToDict(message, preserving_proto_field_name=True),
                        indent=2,
                    )
                    + "\n"
                ).encode(),
            ),
        ]:
            path = args.out / f"{name}.{suffix}"
            path.write_bytes(contents)
            records.append(
                {
                    "file": path.name,
                    "bytes": len(contents),
                    "sha256": hashlib.sha256(contents).hexdigest(),
                }
            )
    result = {
        "scope": __doc__,
        "packages": {
            name: importlib.metadata.version(name)
            for name in ["opentelemetry-sdk", "opentelemetry-proto", "protobuf"]
        },
        "captureSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "observations": observations,
        "files": records,
    }
    (args.out / "oracle.json").write_text(json.dumps(result, indent=2) + "\n")
    print(
        f"Retained {len(all_spans)} actual SDK exports: {sum(row['sdkIsValid'] for row in observations)} valid, {sum(not row['sdkIsValid'] for row in observations)} explicitly invalid contexts"
    )


if __name__ == "__main__":
    main()
