# /// script
# requires-python = ">=3.10"
# dependencies = ["zstandard==0.25.0"]
# ///
"""Independent checksum vectors and explicitly constructed damaged carriers."""

import hashlib
import io
import json
import struct
from pathlib import Path

import zstandard

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
OUT = HERE / "controls"
OUT.mkdir(exist_ok=True)
rows = []


def save(name, data, expected, alteration):
    (OUT / name).write_bytes(data)
    rows.append(
        {
            "file": name,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "expected": expected,
            "alteration": alteration,
        }
    )


for mode in ("legacy", "native"):
    data = (FIXTURES / mode / "traces.traces.otlp.zst").read_bytes()
    if mode == "legacy":
        (size,) = struct.unpack_from(">I", data)
        end = 4 + size
        assert data[8] & 4
    else:
        decoder = zstandard.ZstdDecompressor().decompressobj()
        decoder.decompress(data)
        end = len(data) - len(decoder.unused_data)
        assert decoder.eof and data[4] & 4
    corrupt = bytearray(data)
    corrupt[end - 1] ^= 1
    try:
        if mode == "legacy":
            zstandard.ZstdDecompressor().decompress(corrupt[4:end])
        else:
            with zstandard.ZstdDecompressor().stream_reader(
                io.BytesIO(corrupt)
            ) as reader:
                reader.read()
    except zstandard.ZstdError:
        pass
    else:
        raise AssertionError("Independent decoder accepted a damaged checksum")
    save(
        f"{mode}-checksum.traces.otlp.zst",
        corrupt,
        "checksum",
        "Flip one bit in the first frame's content checksum; retain later complete frames",
    )
    save(
        f"{mode}-truncated.traces.otlp.zst",
        data[:-1],
        "incomplete",
        "Remove the final encoded byte; keep the complete earlier batches",
    )
    save(
        f"{mode}-trailing.traces.otlp.zst",
        data + b"trailing",
        "trailing",
        "Append bytes outside the final frame/batch",
    )

raw = (HERE.parent / "otlp-binary/fixtures/http-01.traces.pb").read_bytes()
compress = zstandard.ZstdCompressor(write_checksum=True)
save(
    "raw.traces.pb.zst",
    compress.compress(raw),
    "accept",
    "Compress an unchanged retained native SDK request with Python zstandard",
)
# Unknown content size exercises the running output budget, not only the header.
save(
    "expansion.jsonl.zst",
    zstandard.ZstdCompressor(write_checksum=True, write_content_size=False).compress(
        b" " * (25 * 1024 * 1024 + 1)
    ),
    "expanded",
    "Synthetic 25 MiB + 1 space bytes, unknown frame content size",
)
# Valid frame magic and an over-large window request, before any block exists.
save(
    "window.jsonl.zst",
    bytes.fromhex("28b52ffd0090"),
    "window",
    "Constructed 256 MiB decoding-window header",
)
# A nonzero dictionary ID is deliberately explicit, independent of payload validity.
save(
    "dictionary.jsonl.zst",
    bytes.fromhex("28b52ffd210100010000"),
    "dictionary",
    "Constructed frame requests external dictionary 1",
)
# These eight explicitly altered checksum-free frames were accepted by the
# first lightweight-codec candidate and rejected by libzstd's reference decoder.
original = (FIXTURES / "legacy/traces.traces.otlp.zst").read_bytes()
(size,) = struct.unpack_from(">I", original)
frame = original[4 : 4 + size]
assert frame[4] & 4
plain_frame = frame[:4] + bytes([frame[4] & ~4]) + frame[5:-4]
reference = zstandard.ZstdDecompressor().decompress(plain_frame)
assert reference == zstandard.ZstdDecompressor().decompress(frame)
for offset, bit in [
    (393, 5),
    (393, 6),
    (393, 7),
    (394, 0),
    (409, 4),
    (412, 1),
    (412, 3),
    (431, 6),
]:
    data = bytearray(plain_frame)
    data[offset] ^= 1 << bit
    try:
        zstandard.ZstdDecompressor().decompress(data)
    except zstandard.ZstdError:
        pass
    else:
        raise AssertionError("Reference unexpectedly accepted altered bitstream")
    save(
        f"bitstream-{offset}-{bit}.traces.pb.zst",
        data,
        "bitstream",
        "Constructed single-bit alteration of a checksum-free native frame; reference decoder refuses it",
    )
group_files = []
for index in [1, 2]:
    payload = json.dumps(
        {
            "resourceSpans": [
                {
                    "scopeSpans": [
                        {
                            "spans": [
                                {
                                    "traceId": "8" * 32,
                                    "spanId": f"{index:016x}",
                                    "name": "constructed text-budget control",
                                    "startTimeUnixNano": "1",
                                    "endTimeUnixNano": "2",
                                    "attributes": [
                                        {
                                            "key": "constructed.payload",
                                            "value": {
                                                "stringValue": "x" * (13 * 1024 * 1024)
                                            },
                                        }
                                    ],
                                }
                            ]
                        }
                    ]
                }
            ]
        },
        separators=(",", ":"),
    ).encode()
    name = f"group-{index}.jsonl.zst"
    encoded = compress.compress(payload)
    (OUT / name).write_bytes(encoded)
    group_files.append(
        {
            "file": name,
            "bytes": len(encoded),
            "sha256": hashlib.sha256(encoded).hexdigest(),
            "decodedUnits": len(payload),
        }
    )
(OUT / "oracle.json").write_text(
    json.dumps(
        {
            "constructedControls": True,
            "groupLimit": {
                "files": group_files,
                "expected": "combined decoded text refused before parsing",
                "synthetic": True,
            },
            "zstandardVersion": zstandard.__version__,
            "cases": rows,
        },
        indent=2,
    )
    + "\n"
)
print(json.dumps({"controls": len(rows), "malformedBitstreams": 8}))
