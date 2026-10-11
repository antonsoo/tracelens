# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-common==1.45.1", "protobuf==7.36.2"]
# ///
"""SDK control plus explicitly altered attribute-value counterexamples. No model calls."""
import argparse
import base64
import copy
from decimal import Decimal
import hashlib
import importlib.metadata
import json
from pathlib import Path

from google.protobuf.json_format import MessageToDict, ParseDict
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.proto.common.v1.common_pb2 import AnyValue
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.id_generator import IdGenerator


class FixedIds(IdGenerator):
    def generate_span_id(self):
        return 1

    def generate_trace_id(self):
        return 1


def hex_ids(value):
    if isinstance(value, dict):
        return {key: base64.b64decode(item).hex()
                if key in ("traceId", "spanId", "parentSpanId") else hex_ids(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [hex_ids(item) for item in value]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource({"service.name": "attribute-value-control"}),
                              id_generator=FixedIds())
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("tracelens.attribute-values", "1")
    span = tracer.start_span("SDK integer control", start_time=1_000_000, attributes={
        "gen_ai.operation.name": "chat", "gen_ai.request.model": "fixture-model",
        "gen_ai.provider.name": "fixture-provider", "gen_ai.usage.input_tokens": 1200,
        "gen_ai.usage.output_tokens": 30,
    })
    span.end(end_time=2_000_000)
    captured = exporter.get_finished_spans()
    sdk_doc = hex_ids(MessageToDict(encode_spans(captured), use_integers_for_enums=True))
    sdk_span = sdk_doc["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    cases = [
        ("SDK integer control", {"intValue": "1200"}, 1200, False),
        ("quoted double", {"doubleValue": "1200"}, 1200, False),
        ("quoted double exponent", {"double_value": "1.2e3"}, 1200, False),
        ("integer exponent", {"int_value": "1.200e3"}, 1200, False),
        ("measured zero", {"intValue": "0"}, 0, False),
        ("empty integer", {"intValue": ""}, None, True),
        ("whitespace integer", {"intValue": " "}, None, True),
        ("hexadecimal integer", {"intValue": "0x10"}, None, True),
        ("fraction hidden by rounding", {"intValue": "1.00000000000000001"}, None, True),
        ("outside int64", {"intValue": "9223372036854775808"}, None, True),
        ("unsafe unquoted integer", {"intValue": 9007199254740992}, None, True),
        ("conflicting oneof", {"intValue": "1200", "doubleValue": 0}, None, True),
        ("numeric string field", {"stringValue": 1200}, None, True),
        ("primitive numeric AnyValue", 1200, None, True),
        ("empty double", {"doubleValue": ""}, None, True),
        ("nonfinite double", {"doubleValue": "NaN"}, None, False),
        ("exact large int64", {"intValue": "9223372036854775807"}, None, False),
        ("null integer", {"intValue": None}, None, False),
        ("duplicate input count", {"intValue": "1200"}, None, True),
    ]
    records = []
    spans = []
    for i, (name, value, tokens, warning) in enumerate(cases, 1):
        variant = copy.deepcopy(sdk_span)
        variant.update(name=name, traceId=f"{i:032x}")
        for item in variant["attributes"]:
            if item["key"] == "gen_ai.usage.input_tokens":
                item["value"] = value
        if name == "duplicate input count":
            variant["attributes"].append({"key": "gen_ai.usage.input_tokens", "value": {"intValue": "0"}})
        spans.append(variant)
        try:
            proto = {"accepted": True, "canonical": MessageToDict(ParseDict(value, AnyValue()))}
        except Exception as exc:
            proto = {"accepted": False, "error": str(exc)}
        record = {"name": name, "traceId": variant["traceId"], "spanId": variant["spanId"],
                  "sourceValue": value, "expectedInputTokens": tokens, "expectedWarning": warning,
                  "expectedCostUsd": (tokens * 2 + 30 * 4) / 1e6 if tokens is not None else None,
                  "protobuf": proto}
        if name == "fraction hidden by rounding":
            exact = Decimal(value["intValue"])
            record["exactDecimal"] = {"value": str(exact), "isInteger": exact == exact.to_integral_value()}
        records.append(record)
    doc = copy.deepcopy(sdk_doc)
    doc["resourceSpans"][0]["scopeSpans"][0]["spans"] = spans
    prices = [{"id": "synthetic", "matchModel": "fixture-model", "provider": "fixture-provider",
               "inputPerMTok": 2, "outputPerMTok": 4, "sourceUrl": "", "sourceDate": "2026-10-10"}]
    files = {"sdk-control.json": sdk_doc, "capture.json": doc, "prices.json": prices}
    hashes = {}
    for name, data in files.items():
        content = (json.dumps(data, indent=2) + "\n").encode()
        (args.output / name).write_bytes(content)
        hashes[name] = hashlib.sha256(content).hexdigest()
    oracle = {"provenance": "One actual SDK span with fixed identity/time and synthetic usage. Other traces explicitly alter its typed input-token attribute; no model calls.",
              "packages": {name: importlib.metadata.version(name) for name in
                           ["opentelemetry-sdk", "opentelemetry-exporter-otlp-proto-common", "protobuf"]},
              "driverSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "sha256": hashes, "sdkInputTokens": captured[0].attributes["gen_ai.usage.input_tokens"],
              "sdkOutputTokens": captured[0].attributes["gen_ai.usage.output_tokens"], "cases": records}
    (args.output / "oracle.json").write_text(json.dumps(oracle, indent=2) + "\n")
    provider.shutdown()
    print(f"Captured 1 SDK control and {len(cases) - 1} explicitly altered variants")


if __name__ == "__main__":
    main()
