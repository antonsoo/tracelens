# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-common==1.45.1"]
# ///
"""Capture related spans in three service exports over real loopback HTTP.

Two requests calculate SHA-256 digests, then a linked audit batch writes their
receipts. Each service has its own SDK provider/exporter. No model or external
service is called, and no span timestamp or identity is hand-authored.
"""

import argparse
import hashlib
import http.client
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Queue

from google.protobuf.json_format import MessageToDict
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.propagate import extract, inject
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.trace import Link, SpanKind


class FileExporter(SpanExporter):
    def __init__(self, path, *, lines):
        self.path, self.lines, self.spans = path, lines, []
        if lines:
            path.write_text("")

    def export(self, spans):
        self.spans.extend(spans)
        if self.lines:
            with self.path.open("a") as output:
                output.write(json.dumps(MessageToDict(encode_spans(spans))) + "\n")
        else:
            self.path.write_text(json.dumps(MessageToDict(encode_spans(self.spans)), indent=2) + "\n")
        return SpanExportResult.SUCCESS


def identity(context):
    return {"traceId": f"{context.trace_id:032x}", "spanId": f"{context.span_id:016x}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", type=Path, required=True)
    args = parser.parse_args()
    out = args.output_directory
    out.mkdir(parents=True, exist_ok=True)
    exporters, providers, tracers = {}, {}, {}
    for name, filename, lines in [("gateway", "gateway.jsonl", True),
                                  ("worker", "worker.json", False),
                                  ("audit", "audit.jsonl", True)]:
        exporter = FileExporter(out / filename, lines=lines)
        provider = TracerProvider(resource=Resource.create({"service.name": name}))
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        exporters[name], providers[name] = exporter, provider
        tracers[name] = provider.get_tracer("tracelens.multifile-capture", "1")
    jobs = Queue()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            context = extract(dict(self.headers.items()))
            with tracers["worker"].start_as_current_span("POST /digest", context=context, kind=SpanKind.SERVER) as server_span:
                with tracers["worker"].start_as_current_span("sha256", attributes={
                    "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "sha256",
                    "gen_ai.tool.call.arguments": json.dumps(payload),
                }) as tool:
                    digest = hashlib.sha256(payload["text"].encode()).hexdigest()
                    tool.set_attribute("gen_ai.tool.call.result", digest)
                jobs.put((server_span.get_span_context(), digest))
                body = json.dumps({"sha256": digest}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        def log_message(self, *_args):
            pass

    http_server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http_server.serve_forever)
    thread.start()
    receipts = []
    try:
        with tracers["gateway"].start_as_current_span("run document checks", attributes={"openinference.span.kind": "AGENT"}) as run:
            run_id = identity(run.get_span_context())
            for text in ["A document with a known digest", "A second independent document"]:
                with tracers["gateway"].start_as_current_span("POST worker/digest", kind=SpanKind.CLIENT):
                    carrier = {}
                    inject(carrier)
                    carrier["Content-Type"] = "application/json"
                    connection = http.client.HTTPConnection("127.0.0.1", http_server.server_port, timeout=5)
                    try:
                        connection.request("POST", "/digest", body=json.dumps({"text": text}), headers=carrier)
                        response = connection.getresponse()
                        assert response.status == 200
                        receipt = json.loads(response.read())
                        assert receipt["sha256"] == hashlib.sha256(text.encode()).hexdigest()
                        receipts.append(receipt)
                    finally:
                        connection.close()
    finally:
        http_server.shutdown()
        http_server.server_close()
        thread.join()
    queued = [jobs.get_nowait(), jobs.get_nowait()]
    with tracers["audit"].start_as_current_span("commit audit batch", context=Context(),
                                              links=[Link(context) for context, _ in queued]) as audit:
        audit_id = identity(audit.get_span_context())
        with tracers["audit"].start_as_current_span("write receipts"):
            (out / "receipts.json").write_text(json.dumps(receipts, indent=2) + "\n")
    oracle = []
    for name, exporter in exporters.items():
        providers[name].force_flush()
        for span in exporter.spans:
            oracle.append({**identity(span.context), "name": span.name, "service": name,
                           "parentSpanId": f"{span.parent.span_id:016x}" if span.parent else None,
                           "startTimeUnixNano": str(span.start_time), "endTimeUnixNano": str(span.end_time),
                           "links": [identity(link.context) for link in span.links],
                           "attributes": dict(span.attributes)})
        providers[name].shutdown()
    assert len(oracle) == 9
    assert {span["traceId"] for span in oracle} == {run_id["traceId"], audit_id["traceId"]}
    known = {(span["traceId"], span["spanId"]) for span in oracle}
    assert all((span["traceId"], span["parentSpanId"]) in known for span in oracle if span["parentSpanId"])
    (out / "oracle.json").write_text(json.dumps({"workload": "Controlled local HTTP and Queue work; no model calls",
        "sdk_version": "1.45.1", "run": run_id, "audit": audit_id, "spans": oracle,
        "files": [{"name": exporter.path.name, "bytes": exporter.path.stat().st_size,
                   "sha256": hashlib.sha256(exporter.path.read_bytes()).hexdigest()}
                  for exporter in exporters.values()]}, indent=2) + "\n")
    print(f"Captured {len(oracle)} SDK spans across three service files and two traces")


if __name__ == "__main__":
    main()
