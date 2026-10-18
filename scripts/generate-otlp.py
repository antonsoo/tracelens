# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-proto==1.45.1", "protobuf==7.36.2"]
# ///
"""Regenerate OTLP schemas from pinned official Python package descriptors.

Uses protoc-gen-es already pinned by package-lock.json. No compiler download or
build-time network fetch is needed for ordinary npm builds. Run with uv.
"""

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess

from google.protobuf.compiler import plugin_pb2
from google.protobuf.descriptor_pb2 import FileDescriptorProto
from opentelemetry.proto.collector.logs.v1 import logs_service_pb2
from opentelemetry.proto.collector.trace.v1 import trace_service_pb2


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=root / "src/core/proto")
    parser.add_argument(
        "--receipt", type=Path, default=root / "scripts/otlp-schemas.json"
    )
    args = parser.parse_args()
    descriptors = {}

    def collect(file):
        if file.name in descriptors:
            return
        for dep in file.dependencies:
            collect(dep)
        proto = FileDescriptorProto()
        file.CopyToProto(proto)
        descriptors[file.name] = proto

    for service in (trace_service_pb2.DESCRIPTOR, logs_service_pb2.DESCRIPTOR):
        collect(service)
    request = plugin_pb2.CodeGeneratorRequest(
        file_to_generate=list(descriptors),
        proto_file=list(descriptors.values()),
        parameter="target=ts,import_extension=js",
    )
    plugin = root / "node_modules/.bin/protoc-gen-es"
    completed = subprocess.run(
        [str(plugin)],
        input=request.SerializeToString(),
        capture_output=True,
        check=True,
    )
    response = plugin_pb2.CodeGeneratorResponse.FromString(completed.stdout)
    if response.error:
        raise RuntimeError(response.error)
    files = []
    for file in response.file:
        destination = args.out / file.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        content = (
            "// OTLP schema: Copyright The OpenTelemetry Authors. Apache-2.0.\n"
            "// See LICENSE-OTEL and scripts/otlp-schemas.json. Regenerate with scripts/generate-otlp.py.\n"
            + file.content.rstrip()
            + "\n"
        )
        destination.write_text(content)
        files.append(
            {
                "file": file.name,
                "bytes": len(content.encode()),
                "sha256": hashlib.sha256(content.encode()).hexdigest(),
            }
        )
    receipt = {
        "source": "Official opentelemetry-proto Python package, compiled FileDescriptorProto values",
        "packages": {
            name: importlib.metadata.version(name)
            for name in ("opentelemetry-proto", "protobuf")
        },
        "generator": json.loads(
            (root / "node_modules/@bufbuild/protoc-gen-es/package.json").read_text()
        )["version"],
        "parameters": request.parameter,
        "descriptors": [
            {
                "file": name,
                "sha256": hashlib.sha256(proto.SerializeToString()).hexdigest(),
            }
            for name, proto in descriptors.items()
        ],
        "generated": files,
    }
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    print(
        f"Generated {len(files)} OTLP schema modules from pinned official descriptors"
    )


if __name__ == "__main__":
    main()
