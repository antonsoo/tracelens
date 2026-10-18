# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-util-genai==1.2b0", "opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-http==1.45.1", "protobuf==7.36.2"]
# ///
"""Capture native OTLP/HTTP bodies and actual Collector JSON/proto files locally.

The conversation is scripted; only the digest is computed. No model, credentials
or external service is used. Native IDs and clock times vary on recapture.
"""

import argparse
import hashlib
import http.client
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ["OTEL_SEMCONV_STABILITY_OPT_IN"] = "gen_ai_latest_experimental"
os.environ["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] = "EVENT_ONLY"

from google.protobuf.json_format import MessageToDict
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
    ExportLogsServiceRequest,
)
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import (
    SimpleLogRecordProcessor,
    InMemoryLogRecordExporter,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace import Link, Status, StatusCode
from opentelemetry.util.genai.handler import TelemetryHandler
from opentelemetry.util.genai.types import (
    InputMessage,
    OutputMessage,
    Text,
    TextPart,
    ToolCallRequest,
    ToolCallResponse,
)


def available_port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def json_safe(value):
    if type(value) is int and abs(value) > 2**53 - 1:
        return str(value)
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def identity(context):
    return {"traceId": f"{context.trace_id:032x}", "spanId": f"{context.span_id:016x}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collector", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit(
            "Output must be a new directory; retained fixtures are never replaced"
        )
    args.output.mkdir(parents=True)
    collector = args.collector.resolve()
    port = available_port()
    work = Path(tempfile.mkdtemp(prefix="otel-binary-"))
    config = f"""receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:{port}
exporters:
  file/traces_json:
    path: collector-traces.jsonl
  file/traces_proto:
    path: collector.traces.otlp
    format: proto
  file/logs_json:
    path: collector-logs.jsonl
  file/logs_proto:
    path: collector.logs.otlp
    format: proto
service:
  telemetry:
    logs:
      level: error
    metrics:
      level: none
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file/traces_json, file/traces_proto]
    logs:
      receivers: [otlp]
      exporters: [file/logs_json, file/logs_proto]
"""
    (work / "collector.yaml").write_text(config)
    requests = []
    failures = []

    class Proxy(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            signal = self.path.rsplit("/", 1)[-1]
            if signal not in ("traces", "logs"):
                self.send_error(400)
                return
            number = 1 + sum(row["signal"] == signal for row in requests)
            file = f"http-{number:02d}.{signal}.pb"
            (args.output / file).write_bytes(body)
            requests.append(
                {
                    "file": file,
                    "signal": signal,
                    "contentType": self.headers.get("Content-Type"),
                    "contentEncoding": self.headers.get("Content-Encoding"),
                    "bytes": len(body),
                    "sha256": hashlib.sha256(body).hexdigest(),
                }
            )
            upstream = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            try:
                headers = {"Content-Type": self.headers["Content-Type"]}
                if self.headers.get("Content-Encoding"):
                    headers["Content-Encoding"] = self.headers["Content-Encoding"]
                upstream.request("POST", self.path, body=body, headers=headers)
                response = upstream.getresponse()
                data = response.read()
                if response.status != 200:
                    failures.append(f"{self.path}: HTTP {response.status} {data!r}")
                self.send_response(response.status)
                self.send_header(
                    "Content-Type",
                    response.getheader("Content-Type", "application/x-protobuf"),
                )
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            finally:
                upstream.close()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    process = None
    trace_provider = log_provider = None
    captured_spans = captured_logs = None
    try:
        with (work / "collector.log").open("wb") as log:
            process = subprocess.Popen(
                [str(collector), "--config", "collector.yaml"],
                cwd=work,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        for _ in range(150):
            if process.poll() is not None:
                raise RuntimeError((work / "collector.log").read_text())
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Collector did not become ready")
        thread.start()
        endpoint = f"http://127.0.0.1:{server.server_port}/v1/"
        resource = Resource.create({"service.name": "local-otlp-binary-control"})
        traces = InMemorySpanExporter()
        trace_provider = TracerProvider(resource=resource)
        trace_provider.add_span_processor(SimpleSpanProcessor(traces))
        trace_provider.add_span_processor(
            SimpleSpanProcessor(OTLPSpanExporter(endpoint=endpoint + "traces"))
        )
        logs = InMemoryLogRecordExporter()
        log_provider = LoggerProvider(resource=resource)
        log_provider.add_log_record_processor(SimpleLogRecordProcessor(logs))
        log_provider.add_log_record_processor(
            SimpleLogRecordProcessor(OTLPLogExporter(endpoint=endpoint + "logs"))
        )
        handler = TelemetryHandler(
            tracer_provider=trace_provider,
            logger_provider=log_provider,
            instrumentation_scope_name="tracelens.binary-control",
            instrumentation_scope_version="1",
        )
        tracer = trace_provider.get_tracer("tracelens.local-workflow", "1")
        with tracer.start_as_current_span(
            "inspect a document digest",
            attributes={"gen_ai.operation.name": "invoke_agent"},
        ) as root:
            with handler.inference(
                "local-control", request_model="scripted-response"
            ) as turn:
                turn.system_instruction = [
                    TextPart(content="Use the digest tool; do not invent its result.")
                ]
                turn.input_messages = [
                    InputMessage(
                        role="user", parts=[Text("Compute the SHA-256 of receipt-17.")]
                    )
                ]
                turn.output_messages = [
                    OutputMessage(
                        role="assistant",
                        parts=[
                            ToolCallRequest(
                                id="digest-1",
                                name="sha256",
                                arguments={"text": "receipt-17"},
                            )
                        ],
                        finish_reason="tool_calls",
                    )
                ]
            with tracer.start_as_current_span(
                "sha256",
                attributes={
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": "sha256",
                    "fixture.enabled": False,
                    "fixture.zero": 0,
                    "fixture.max_int64": 9223372036854775807,
                    "fixture.min_int64": -9223372036854775808,
                    "fixture.ratio": 0.25,
                    "fixture.samples": (0, 1, 2),
                },
            ):
                digest = hashlib.sha256(b"receipt-17").hexdigest()
            with handler.inference(
                "local-control", request_model="scripted-response"
            ) as turn:
                turn.input_messages = [
                    InputMessage(
                        role="tool",
                        parts=[
                            ToolCallResponse(id="digest-1", response={"sha256": digest})
                        ],
                    )
                ]
                turn.output_messages = [
                    OutputMessage(
                        role="assistant",
                        parts=[Text("SHA-256: " + digest)],
                        finish_reason="stop",
                    )
                ]
        with tracer.start_as_current_span(
            "consume the digest",
            links=[Link(root.get_span_context(), {"relation": "follows"})],
        ):
            with tracer.start_as_current_span("verify sha256") as check:
                assert digest == hashlib.sha256(b"receipt-17").hexdigest()
                check.set_status(Status(StatusCode.OK))
        trace_provider.force_flush()
        log_provider.force_flush()
        captured_spans = traces.get_finished_spans()
        captured_logs = logs.get_finished_logs()
        assert len(captured_spans) == 6
        assert len({s.context.trace_id for s in captured_spans}) == 2
        assert len(requests) == len(captured_spans) + len(captured_logs)
        assert not failures, failures
        for request in requests:
            kind = (
                ExportTraceServiceRequest
                if request["signal"] == "traces"
                else ExportLogsServiceRequest
            )
            message = kind.FromString((args.output / request["file"]).read_bytes())
            counterpart = request["file"].removesuffix(".pb") + ".json"
            (args.output / counterpart).write_text(
                json.dumps(MessageToDict(message), indent=2) + "\n"
            )
        trace_provider.shutdown()
        trace_provider = None
        log_provider.shutdown()
        log_provider = None
        process.terminate()
        if process.wait(timeout=15) != 0:
            raise RuntimeError((work / "collector.log").read_text())
        process = None
        for name in (
            "collector-traces.jsonl",
            "collector-logs.jsonl",
            "collector.traces.otlp",
            "collector.logs.otlp",
        ):
            shutil.copyfile(work / name, args.output / name)
        artifacts = []
        for file in sorted(args.output.iterdir()):
            data = file.read_bytes()
            artifacts.append(
                {
                    "file": file.name,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        result = {
            "scope": "Scripted conversation and actual local SHA-256 computation, native Python SDK HTTP protobuf requests forwarded only to a local Collector; no model, credentials or external service used. IDs and actual timestamps change on recapture.",
            "versions": {
                name: importlib.metadata.version(name)
                for name in [
                    "opentelemetry-util-genai",
                    "opentelemetry-sdk",
                    "opentelemetry-proto",
                    "opentelemetry-exporter-otlp-proto-http",
                    "protobuf",
                ]
            },
            "collectorVersion": subprocess.check_output(
                [str(collector), "--version"], text=True
            ).strip(),
            "collectorBinarySha256": hashlib.sha256(collector.read_bytes()).hexdigest(),
            "driverSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "requests": requests,
            "files": artifacts,
            "digest": digest,
            "attributeEncoding": "Unsafe source SDK integers are decimal strings; attributeTypes retain original Python types.",
            "spans": [
                {
                    **identity(s.context),
                    "name": s.name,
                    "start": str(s.start_time),
                    "end": str(s.end_time),
                    "parentSpanId": f"{s.parent.span_id:016x}" if s.parent else None,
                    "status": s.status.status_code.name,
                    "attributes": json_safe(dict(s.attributes)),
                    "attributeTypes": {
                        key: type(value).__name__ for key, value in s.attributes.items()
                    },
                    "links": [identity(link.context) for link in s.links],
                }
                for s in captured_spans
            ],
            "logs": [
                {
                    **identity(r.log_record),
                    "timestamp": str(r.log_record.timestamp)
                    if r.log_record.timestamp is not None
                    else None,
                    "observedTimestamp": str(r.log_record.observed_timestamp)
                    if r.log_record.observed_timestamp is not None
                    else None,
                    "eventName": r.log_record.event_name,
                    "body": r.log_record.body,
                    "attributes": dict(r.log_record.attributes or {}),
                }
                for r in captured_logs
            ],
        }
        (args.output / "oracle.json").write_text(json.dumps(result, indent=2) + "\n")
        print(
            f"Captured {len(captured_spans)} spans, {len(captured_logs)} logs, {len(requests)} HTTP requests and four actual Collector files"
        )
    finally:
        if trace_provider:
            trace_provider.shutdown()
        if log_provider:
            log_provider.shutdown()
        if process:
            process.terminate()
            process.wait(timeout=15)
        if thread.is_alive():
            server.shutdown()
        server.server_close()
        shutil.rmtree(work)


if __name__ == "__main__":
    main()
