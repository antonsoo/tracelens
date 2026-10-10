# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-common==1.45.1", "protobuf==7.36.2"]
# ///
"""Actual SDK/Protobuf exports with deliberately chosen case-colliding base64 IDs.

No external calls. The controlled IDs and times are fixture data, not observed
production traffic. Identity expectations come from SDK objects before encoding.
"""

import argparse
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path

from google.protobuf.json_format import MessageToDict, MessageToJson
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.id_generator import IdGenerator
from opentelemetry.trace import Link, set_span_in_context


class ControlledIds(IdGenerator):
    def __init__(self):
        self.spans = iter([1, 0x6800000000000001, 2, 3])
        self.traces = iter([1, 0x68000000000000000000000000000001])

    def generate_span_id(self):
        return next(self.spans)

    def generate_trace_id(self):
        return next(self.traces)


def hex_ids(value):
    if isinstance(value, dict):
        return {key: base64.b64decode(item).hex()
                if key in ("traceId", "spanId", "parentSpanId") else hex_ids(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [hex_ids(item) for item in value]
    return value


def identity(context):
    return {"traceId": f"{context.trace_id:032x}", "spanId": f"{context.span_id:016x}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource({"service.name": "protobuf-identity-control"}),
                              id_generator=ControlledIds())
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("tracelens.identity-control", "1")
    root = tracer.start_span("first workflow", context=Context(), start_time=1_000_000)
    child = tracer.start_span("first tool", context=set_span_in_context(root), start_time=2_000_000,
                              attributes={"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "inspect",
                                          "fixture.enabled": True, "fixture.attempt": 3,
                                          "fixture.ratio": 0.25, "fixture.ids": (1, 2)})
    child.end(end_time=3_000_000)
    root.end(end_time=4_000_000)
    other = tracer.start_span("second workflow", context=Context(), start_time=5_000_000,
                              links=[Link(child.get_span_context(), {"relation": "follows"})])
    linked = tracer.start_span("second tool", context=set_span_in_context(other), start_time=6_000_000,
                               links=[Link(root.get_span_context(), {"relation": "origin"})])
    linked.end(end_time=7_000_000)
    other.end(end_time=8_000_000)
    spans = exporter.get_finished_spans()
    assert len(spans) == 4
    groups = {"all": spans, "span-collision": spans[:2], "trace-collision": (spans[1], spans[3])}
    files = []
    for group, selected in groups.items():
        request = encode_spans(selected)
        variants = {
            "proto": MessageToJson(request),
            "proto-snake": MessageToJson(request, preserving_proto_field_name=True),
            "otlp": json.dumps(hex_ids(MessageToDict(request, use_integers_for_enums=True)), indent=2),
        }
        for format_name, data in variants.items():
            path = args.output / f"{group}.{format_name}.json"
            path.write_text(data + "\n")
            files.append({"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                          "spans": [identity(s.context) for s in selected]})
    oracle = {"scenario": "Controlled SDK IDs and timestamps, actual Protobuf serialization; no model or network calls",
              "packages": {name: importlib.metadata.version(name) for name in
                           ["opentelemetry-sdk", "opentelemetry-exporter-otlp-proto-common", "protobuf"]},
              "driver_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "files": files,
              "spans": [{**identity(s.context), "name": s.name,
                         "parentSpanId": f"{s.parent.span_id:016x}" if s.parent else None,
                         "start": str(s.start_time), "end": str(s.end_time),
                         "links": [identity(link.context) for link in s.links]} for s in spans]}
    (args.output / "oracle.json").write_text(json.dumps(oracle, indent=2) + "\n")
    provider.shutdown()
    print(f"Captured {len(spans)} SDK spans, two traces, {sum(len(s.links) for s in spans)} links, {len(files)} files")


if __name__ == "__main__":
    main()
