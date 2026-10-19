# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-proto==1.45.1", "protobuf==7.36.2", "zstandard==0.25.0"]
# ///
"""Replay pinned SDK bodies through actual legacy and native Collector codecs.

The retained conversation is scripted and its tool computes a local digest.
No model or outside telemetry endpoint is used. Compression is produced by the
Collector, not by this driver. Python zstandard and Google Protobuf decode the
results independently of TraceLens.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import io
import json
import socket
import struct
import subprocess
import time
from pathlib import Path

import zstandard
from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
    ExportLogsServiceRequest,
)
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCE = HERE.parent / "otlp-binary/fixtures"
sha = lambda b: hashlib.sha256(b).hexdigest()


def batches(data):
    out = []
    at = 0
    while at < len(data):
        (size,) = struct.unpack_from(">I", data, at)
        at += 4
        assert size <= len(data) - at
        out.append(data[at : at + size])
        at += size
    assert at == len(data)
    return out


def unzip(data):
    with zstandard.ZstdDecompressor().stream_reader(
        io.BytesIO(data), read_across_frames=True
    ) as reader:
        return reader.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collector", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    binary = args.collector.resolve()
    original = json.loads((SOURCE / "oracle.json").read_text())
    assert sha(binary.read_bytes()) == original["collectorBinarySha256"]
    bodies = []
    for row in original["requests"]:
        body = (SOURCE / row["file"]).read_bytes()
        assert sha(body) == row["sha256"]
        cls = (
            ExportTraceServiceRequest
            if row["signal"] == "traces"
            else ExportLogsServiceRequest
        )
        message = cls.FromString(body)
        bodies.append((row["signal"], body))
        assert message.ByteSize() > 0
    observations = []
    for mode in ("legacy", "native"):
        work = args.out / mode
        work.mkdir()
        with socket.socket() as endpoint:
            endpoint.bind(("127.0.0.1", 0))
            port = endpoint.getsockname()[1]
        config = f"""receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:{port}
exporters:
"""
        for signal in ("traces", "logs"):
            for format in ("json", "proto"):
                extension = "jsonl" if format == "json" else f"{signal}.otlp"
                for compressed in (False, True):
                    key = f"{signal}_{format}_{'zstd' if compressed else 'plain'}"
                    config += f"  file/{key}:\n    path: {signal}.{extension}{'.zst' if compressed else ''}\n    format: {format}\n    flush_interval: 50ms\n"
                    if compressed:
                        config += "    compression: zstd\n"
        config += "service:\n  telemetry:\n    logs:\n      level: error\n    metrics:\n      level: none\n  pipelines:\n"
        for signal in ("traces", "logs"):
            names = [
                f"file/{signal}_{format}_{suffix}"
                for format in ("json", "proto")
                for suffix in ("plain", "zstd")
            ]
            config += f"    {signal}:\n      receivers: [otlp]\n      exporters: [{', '.join(names)}]\n"
        (work / "collector.yaml").write_text(config)
        command = [str(binary), "--config", "collector.yaml"]
        if mode == "native":
            command.append("--feature-gates=exporter.file.nativeCompression")
        with (work / "collector.log").open("wb") as log:
            process = subprocess.Popen(
                command, cwd=work, stdout=log, stderr=subprocess.STDOUT
            )
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
            for signal, body in bodies:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                connection.request(
                    "POST",
                    f"/v1/{signal}",
                    body=body,
                    headers={"Content-Type": "application/x-protobuf"},
                )
                response = connection.getresponse()
                response.read()
                assert response.status == 200
                connection.close()
                # Native flush creates independently compressed frames. Use real
                # flush boundaries, without changing any source clock or ID.
                time.sleep(0.08)
        finally:
            process.terminate()
            process.wait(timeout=10)
        assert process.returncode == 0
        for signal in ("traces", "logs"):
            for format in ("json", "proto"):
                ext = "jsonl" if format == "json" else f"{signal}.otlp"
                plain = (work / f"{signal}.{ext}").read_bytes()
                source = work / f"{signal}.{ext}.zst"
                compressed = source.read_bytes()
                decoded = (
                    unzip(compressed)
                    if mode == "native"
                    else b"".join(
                        (unzip(batch) + (b"\n" if format == "json" else b""))
                        if format == "json"
                        else struct.pack(">I", len(unzip(batch))) + unzip(batch)
                        for batch in batches(compressed)
                    )
                )
                if format == "json":
                    left = [
                        json.loads(line) for line in plain.splitlines() if line.strip()
                    ]
                    right = [
                        json.loads(line)
                        for line in decoded.splitlines()
                        if line.strip()
                    ]
                else:
                    cls = (
                        ExportTraceServiceRequest
                        if signal == "traces"
                        else ExportLogsServiceRequest
                    )
                    left = [
                        MessageToDict(cls.FromString(batch)) for batch in batches(plain)
                    ]
                    right = [
                        MessageToDict(cls.FromString(batch))
                        for batch in batches(decoded)
                    ]
                assert left == right
                observations.append(
                    {
                        "mode": mode,
                        "signal": signal,
                        "format": format,
                        "file": str(source.relative_to(args.out)),
                        "bytes": len(compressed),
                        "sha256": sha(compressed),
                        "decodedBytes": len(decoded),
                        "decodedSha256": sha(decoded),
                        "batches": len(left),
                        "sameAsUncompressedCollectorOutput": True,
                    }
                )
                (work / f"decoded-{signal}.{ext}").write_bytes(decoded)
    (args.out / "oracle.json").write_text(
        json.dumps(
            {
                "collectorVersion": subprocess.check_output(
                    [str(binary), "--version"], text=True
                ).strip(),
                "collectorBinarySha256": sha(binary.read_bytes()),
                "scriptedConversation": True,
                "sourceRequests": original["requests"],
                "independentDecoder": f"Python zstandard {zstandard.__version__} and Google Protobuf",
                "observations": observations,
            },
            indent=2,
        )
        + "\n"
    )
    print(
        json.dumps(
            {
                "nativeCompressedCarriers": len(observations),
                "sameAsUncompressed": all(
                    row["sameAsUncompressedCollectorOutput"] for row in observations
                ),
            }
        )
    )


if __name__ == "__main__":
    main()
