# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-common==1.45.1"]
# ///
"""Capture measured sequential/parallel tool requests using a real OTel SDK.

Run: uv run scripts/capture-timing.py [--output-directory examples]
The controlled server delays are deliberate. No model, external service,
credentials, or production data are involved. Captures are observations, not
a concurrency benchmark. SDK timestamps are never replaced with planned times.
"""
import argparse
import asyncio
import base64
import json
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from google.protobuf.json_format import MessageToDict
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


def hex_ids(value):
    # OTLP JSON uses hex IDs, unlike Protobuf's general base64 JSON mapping.
    if isinstance(value, dict):
        return {key: base64.b64decode(item).hex() if key in ("traceId", "spanId", "parentSpanId")
                else hex_ids(item) for key, item in value.items()}
    if isinstance(value, list):
        return [hex_ids(item) for item in value]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", type=Path, default=Path("examples"))
    args = parser.parse_args()
    args.output_directory.mkdir(parents=True, exist_ok=True)
    delays = {"inventory": 0.12, "shipping": 0.18, "tax": 0.10}
    responses = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            name = self.path.removeprefix("/")
            if name not in delays:
                self.send_error(404)
                return
            time.sleep(delays[name])
            body = json.dumps({"tool": name, "ok": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            responses.append(name)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource.create({"service.name": "checkout-timing-capture"}))
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("tracelens.controlled-timing", "1")

    async def request(name):
        with tracer.start_as_current_span(name, attributes={"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name}) as span:
            def fetch():
                with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/{name}", timeout=5) as response:
                    assert response.status == 200
                    return json.load(response)
            value = await asyncio.to_thread(fetch)
            assert value == {"tool": name, "ok": True}
            span.set_attribute("http.response.status_code", 200)
            return value

    async def capture(mode):
        exporter.clear()
        with tracer.start_as_current_span("checkout", attributes={"gen_ai.operation.name": "invoke_agent", "capture.mode": mode}):
            with tracer.start_as_current_span("prepare"):
                await asyncio.sleep(0.025)
            with tracer.start_as_current_span("lookups"):
                if mode == "parallel":
                    values = await asyncio.gather(*(request(name) for name in delays))
                else:
                    values = [await request(name) for name in delays]
                assert {value["tool"] for value in values} == set(delays)
            with tracer.start_as_current_span("assemble"):
                await asyncio.sleep(0.035)
        spans = exporter.get_finished_spans()
        assert len(spans) == 7
        tools = [span for span in spans if span.attributes.get("gen_ai.operation.name") == "execute_tool"]
        boundaries = sorted({t for span in tools for t in (span.start_time, span.end_time)})
        peak = max(sum(span.start_time <= t < span.end_time for span in tools) for t in boundaries)
        assert peak == (3 if mode == "parallel" else 1), peak
        root = next(span for span in spans if span.parent is None)
        doc = hex_ids(MessageToDict(encode_spans(spans), use_integers_for_enums=True))
        output = args.output_directory / f"timing-{mode}.json"
        output.write_text(json.dumps(doc, indent=2) + "\n")
        print(f"{output}: {len(spans)} SDK spans, peak {peak}, elapsed {(root.end_time-root.start_time)/1e6:.3f} ms")

    try:
        for mode in ("parallel", "sequential"):
            asyncio.run(capture(mode))
        assert sorted(responses) == sorted(list(delays) * 2)
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
        provider.shutdown()


if __name__ == "__main__":
    main()
