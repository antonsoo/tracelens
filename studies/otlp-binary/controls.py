# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-proto==1.45.1", "protobuf==7.36.2"]
# ///
"""Construct labelled protocol controls, checked by Google's Protobuf runtime.

These are altered inputs derived from the retained native capture, not additional
SDK/Collector observations. No TraceLens code is imported.
"""

import argparse
import hashlib
import json
from pathlib import Path

from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.proto.common.v1.common_pb2 import AnyValue


def varint(value):
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def message(field, data):
    return varint(field * 8 + 2) + varint(len(data)) + data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    fixture = Path(__file__).parent / "fixtures/http-01.traces.pb"
    original = fixture.read_bytes()
    native = ExportTraceServiceRequest.FromString(original)
    cases = {}
    variant = ExportTraceServiceRequest.FromString(original)
    variant.resource_spans[0].scope_spans[0].spans[0].name = "tool 🧾 <receipt>"
    cases["unicode-name"] = (variant.SerializeToString(), True, "Controlled UTF-8 name")
    variant = ExportTraceServiceRequest.FromString(original)
    variant.resource_spans[0].scope_spans[0].spans[0].status.code = 99
    cases["unknown-status"] = (
        variant.SerializeToString(),
        True,
        "Unknown open-enum value stays 99",
    )
    variant = ExportTraceServiceRequest.FromString(original)
    attr = (
        variant.resource_spans[0]
        .scope_spans[0]
        .spans[0]
        .attributes.add(key="fixture.bytes")
    )
    attr.value.bytes_value = b"\x00\xff<script>"
    cases["opaque-bytes"] = (
        variant.SerializeToString(),
        True,
        "Binary AnyValue is not decoded as UTF-8",
    )
    cases["unknown-field"] = (
        original + varint(200 * 8) + varint(123),
        True,
        "Unknown root wire field, recognized fields unchanged",
    )
    # Understate a complete nested message by one byte. A shared-reader decoder
    # can consume the last field past this boundary and still return a span.
    offset, length, shift = 1, 0, 0
    while True:
        byte = original[offset]
        length |= (byte & 127) << shift
        offset += 1
        if byte < 128:
            break
        shift += 7
    assert len(varint(length - 1)) == offset - 1
    undersized = original[:1] + varint(length - 1) + original[offset:]
    cases["nested-length-overrun"] = (
        undersized,
        False,
        "Complete ResourceSpans payload with a declared length one byte too short",
    )
    cases["length-overflow"] = (
        original + varint(201 * 8 + 2) + varint(2**32),
        False,
        "Unknown length-delimited field whose length exceeds uint32",
    )
    cases["truncated-raw"] = (
        original[:-1],
        False,
        "Last byte removed inside the declared message",
    )
    cases["illegal-tag"] = (original + b"\x00", False, "Field number zero is illegal")
    source_name = native.resource_spans[0].scope_spans[0].spans[0].name.encode()
    assert original.count(source_name) == 1
    cases["invalid-utf8"] = (
        original.replace(source_name, b"\xff" + source_name[1:]),
        False,
        "Invalid first UTF-8 byte in the recorded name",
    )
    second = (fixture.parent / "http-02.traces.pb").read_bytes()
    cases["raw-merge"] = (
        original + second,
        True,
        "Protobuf repeated fields merge when serialized messages are concatenated",
    )

    # An actual repeated oneof on the wire cannot be emitted by SerializeToString
    # after parsing: the object already holds only its last selected member.
    # Wrap the deliberate duplicate bytes, then let Google parse the whole request.
    span = native.resource_spans[0].scope_spans[0].spans[0]
    resource = native.resource_spans[0].resource.SerializeToString()
    scope = native.resource_spans[0].scope_spans[0].scope.SerializeToString()
    oneof = (
        AnyValue(string_value="first").SerializeToString()
        + AnyValue(int_value=7).SerializeToString()
    )
    attribute = message(1, b"fixture.repeated_oneof") + message(2, oneof)
    span_bytes = span.SerializeToString() + message(9, attribute)
    request = message(
        1, message(1, resource) + message(2, message(1, scope) + message(2, span_bytes))
    )
    cases["oneof-last-wins"] = (
        request,
        True,
        "Two AnyValue oneof members on the wire; native Protobuf semantics select the last",
    )
    results = []
    for name, (data, expected, description) in cases.items():
        file = name + ".traces.pb"
        (args.out / file).write_bytes(data)
        try:
            decoded = ExportTraceServiceRequest.FromString(data)
            json_value = MessageToDict(decoded, use_integers_for_enums=True)
            accepted, error = True, None
            (args.out / (name + ".json")).write_text(
                json.dumps(json_value, indent=2) + "\n"
            )
        except Exception as exc:
            accepted, error = False, type(exc).__name__ + ": " + str(exc)
        assert accepted == expected, (name, accepted, expected, error)
        results.append(
            {
                "name": name,
                "file": file,
                "description": description,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "googleAccepted": accepted,
                "googleError": error,
                "jsonControl": name + ".json" if accepted else None,
            }
        )
    result = {
        "scope": __doc__.strip(),
        "sourceSha256": hashlib.sha256(original).hexdigest(),
        "driverSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "cases": results,
    }
    (args.out / "oracle.json").write_text(json.dumps(result, indent=2) + "\n")
    print(
        f"Checked {len(results)} constructed wire controls with native Google Protobuf"
    )


if __name__ == "__main__":
    main()
