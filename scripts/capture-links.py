# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-common==1.45.1"]
# ///
"""Capture a controlled queue fan-in with real SDK links and dropped-link counts.

No external services or model calls. Four jobs really pass through a Queue;
one producer uses an unsampled provider and cannot be present in the export.
The batch's three-link limit deliberately omits one of its four input links.
The oracle is read directly from SDK objects before encoding OTLP.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
from queue import Queue

from google.protobuf.json_format import MessageToDict
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.propagate import extract, inject
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanLimits, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.sampling import ALWAYS_OFF
from opentelemetry.trace import Link, TraceState, get_current_span


def hex_ids(value):
    if isinstance(value, dict):
        return {key: base64.b64decode(item).hex() if key in ("traceId", "spanId", "parentSpanId")
                else hex_ids(item) for key, item in value.items()}
    if isinstance(value, list):
        return [hex_ids(item) for item in value]
    return value


def identity(context):
    return {"traceId": f"{context.trace_id:032x}", "spanId": f"{context.span_id:016x}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", type=Path, default=Path("examples"))
    args = parser.parse_args()
    args.output_directory.mkdir(parents=True, exist_ok=True)
    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource.create({"service.name": "queue-link-capture"}),
                              span_limits=SpanLimits(max_links=3, max_link_attributes=2))
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("tracelens.controlled-links", "1")
    unsampled = TracerProvider(sampler=ALWAYS_OFF)
    queue = Queue()
    for index in range(4):
        producer = tracer if index < 3 else unsampled.get_tracer("unrecorded-producer")
        with producer.start_as_current_span(f"enqueue job {index + 1}", context=Context()):
            carrier = {}
            inject(carrier)
            carrier["tracestate"] = TraceState([("capture", "local")]).to_header()
            queue.put((index + 1, carrier))
    jobs = [queue.get_nowait() for _ in range(4)]
    contexts = [get_current_span(extract(carrier)).get_span_context() for _, carrier in jobs]
    links = [Link(context, attributes={"job.id": job[0], "queue.name": "invoices", "delivery.attempt": 1})
             for job, context in zip(jobs, contexts)]
    completed = []
    with tracer.start_as_current_span("process invoice batch", context=Context(), links=links) as batch:
        batch_id = identity(batch.get_span_context())
        for (job, _), context in zip(jobs, contexts):
            with tracer.start_as_current_span(f"process job {job}", links=[Link(context, {"job.id": job})]):
                completed.append(job)
                queue.task_done()
        with tracer.start_as_current_span("commit batch", links=[Link(batch.get_span_context(), {"relation": "commit"})]):
            assert completed == [1, 2, 3, 4]
    queue.join()
    spans = exporter.get_finished_spans()
    known = {(s.context.trace_id, s.context.span_id): s.name for s in spans}
    oracle = []
    for span in spans:
        oracle.append({**identity(span.context), "name": span.name,
                       "parentSpanId": f"{span.parent.span_id:016x}" if span.parent else None,
                       "droppedLinksCount": span.dropped_links,
                       "links": [{**identity(link.context), "attributes": dict(link.attributes or {}),
                                  "traceState": link.context.trace_state.to_header(),
                                  "droppedAttributesCount": link.dropped_attributes,
                                  "targetName": known.get((link.context.trace_id, link.context.span_id))}
                                 for link in span.links]})
    output = args.output_directory / "queue-links.json"
    output.write_text(json.dumps(hex_ids(MessageToDict(encode_spans(spans), use_integers_for_enums=True)), indent=2) + "\n")
    manifest = {"scenario": "Controlled local Queue workload; actual SDK export, no model calls",
                "sdkVersion": "1.45.1", "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                "completedJobs": completed, "batch": batch_id, "spans": oracle}
    (args.output_directory / "queue-links.oracle.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"spans": len(spans), "links": sum(len(s.links) for s in spans),
                      "droppedLinks": sum(s.dropped_links for s in spans), "completedJobs": completed}))
    provider.shutdown()
    unsampled.shutdown()


if __name__ == "__main__":
    main()
