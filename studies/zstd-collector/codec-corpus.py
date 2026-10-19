# /// script
# requires-python = ">=3.10"
# dependencies = ["zstandard==0.25.0"]
# ///
"""Independent byte-codec controls, separate from the native telemetry captures."""

import hashlib
import json
import random
import struct
from pathlib import Path

import zstandard

HERE = Path(__file__).resolve().parent
OUT = HERE / "cache/codec-corpus"
OUT.mkdir(parents=True, exist_ok=True)
MAXIMUM = 25 * 1024 * 1024
rows = []
sha = lambda data: hashlib.sha256(data).hexdigest()


def save(name, encoded, decoded, description):
    (OUT / name).write_bytes(encoded)
    with zstandard.ZstdDecompressor().stream_reader(
        encoded, read_across_frames=True
    ) as reader:
        assert reader.read() == decoded
    rows.append(
        {
            "file": name,
            "description": description,
            "bytes": len(encoded),
            "sha256": sha(encoded),
            "decodedBytes": len(decoded),
            "decodedSha256": sha(decoded),
        }
    )


for length in [0, 1, 3, 8, 255, 256, 1024, 32767, 131072, 131073, 350000]:
    patterns = [
        bytes((i * 37 + 11) % 256 for i in range(length)),
        (b"local trace control " * ((length + 19) // 20))[:length],
        random.Random(271828 + length).randbytes(length),
    ]
    for pattern, data in enumerate(patterns):
        for level in [1, 3, 11]:
            for size in [False, True]:
                for checksum in [False, True]:
                    encoded = zstandard.ZstdCompressor(
                        level=level, write_content_size=size, write_checksum=checksum
                    ).compress(data)
                    name = f"{length}-{pattern}-{level}-{int(size)}-{int(checksum)}.zst"
                    save(
                        name,
                        encoded,
                        data,
                        "Constructed bytes; vary length, entropy, level, content-size declaration and checksum",
                    )

compress = zstandard.ZstdCompressor(write_checksum=True)
a, b = b"First native frame", b"Second native frame"
frames = compress.compress(a) + compress.compress(b)
save("concatenated.zst", frames, a + b, "Two complete frames")
skip = bytes.fromhex("502a4d18") + struct.pack("<I", 11) + b"ignore this"
save(
    "skippable.zst",
    skip + frames + skip,
    a + b,
    "Skippable frames before and after two data frames",
)
encoded = compress.compress(a)
assert encoded[4] & 32 and encoded[4] >> 6 == 0
wide = (
    encoded[:4] + bytes([encoded[4] | 0xC0]) + struct.pack("<Q", len(a)) + encoded[6:]
)
save(
    "eight-byte-size.zst",
    wide,
    a,
    "Valid eight-byte content-size field holding a small size",
)

source = (HERE / "fixtures/legacy/traces.traces.otlp.zst").read_bytes()
(length,) = struct.unpack_from(">I", source)
frame = source[4 : 4 + length]
(OUT / "mutation-source.zst").write_bytes(frame)
assert frame[4] & 4
no_checksum = frame[:4] + bytes([frame[4] & ~4]) + frame[5:-4]
assert zstandard.ZstdDecompressor().decompress(
    frame
) == zstandard.ZstdDecompressor().decompress(no_checksum)
(OUT / "mutation-no-checksum.zst").write_bytes(no_checksum)
mutations = []
mutation_sources = [
    {"name": "checksum", "file": "mutation-source.zst", "sha256": sha(frame)},
    {
        "name": "no-checksum",
        "file": "mutation-no-checksum.zst",
        "sha256": sha(no_checksum),
    },
]
for source_name, mutation_frame in [("checksum", frame), ("no-checksum", no_checksum)]:
    for offset in range(len(mutation_frame)):
        for bit in range(8):
            changed = bytearray(mutation_frame)
            changed[offset] ^= 1 << bit
            expected = "reject"
            value = None
            try:
                parameters = zstandard.get_frame_parameters(changed)
                if (
                    parameters.window_size > MAXIMUM
                    or parameters.dict_id
                    or (
                        parameters.content_size
                        not in [
                            zstandard.CONTENTSIZE_UNKNOWN,
                            zstandard.CONTENTSIZE_ERROR,
                        ]
                        and parameters.content_size > MAXIMUM
                    )
                ):
                    expected = "outside-supported-limits"
                else:
                    decoder = zstandard.ZstdDecompressor().decompressobj()
                    value = decoder.decompress(changed)
                    if decoder.eof and not decoder.unused_data:
                        expected = "accept"
            except zstandard.ZstdError:
                pass
            mutations.append(
                {
                    "source": source_name,
                    "offset": offset,
                    "bit": bit,
                    "expected": expected,
                    "decodedSha256": sha(value) if expected == "accept" else None,
                }
            )
(OUT / "oracle.json").write_text(
    json.dumps(
        {
            "syntheticCodecCorpus": True,
            "zstandardVersion": zstandard.__version__,
            "positiveCases": rows,
            "mutationSources": mutation_sources,
            "mutations": mutations,
        },
        indent=2,
    )
    + "\n"
)
print(
    json.dumps(
        {
            "positiveCases": len(rows),
            "singleBitMutations": len(mutations),
            "acceptedByReference": sum(
                row["expected"] == "accept" for row in mutations
            ),
        }
    )
)
