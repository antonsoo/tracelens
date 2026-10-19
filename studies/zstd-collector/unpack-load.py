# /// script
# requires-python = ">=3.10"
# dependencies = ["zstandard==0.25.0"]
# ///
"""Hash-check and independently expand the retained native load capture."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path

import zstandard

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    source = HERE / "load"
    oracle = json.loads((source / "oracle.json").read_text())
    sdk = gzip.decompress((source / "sdk-spans.json.gz").read_bytes())
    assert hashlib.sha256(sdk).hexdigest() == oracle["sdkSpansSha256"]
    (args.out / "sdk-spans.json").write_bytes(sdk)
    for row in oracle["files"]:
        data = (source / row["file"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == row["sha256"]
        with zstandard.ZstdDecompressor().stream_reader(
            io.BytesIO(data), read_across_frames=True
        ) as reader:
            decoded = reader.read()
        assert hashlib.sha256(decoded).hexdigest() == row["decodedSha256"]
        assert len(decoded) == row["decodedBytes"]
        (args.out / row["file"]).write_bytes(data)
        (args.out / row["file"].removesuffix(".zst")).write_bytes(decoded)
    print(
        json.dumps(
            {
                "retainedNativeFiles": len(oracle["files"]),
                "sdkSpans": len(json.loads(sdk)),
                "allHashesMatch": True,
            }
        )
    )


if __name__ == "__main__":
    main()
