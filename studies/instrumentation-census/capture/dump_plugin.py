"""pytest plugin: copy every finished span into a JSONL file.

Load with `-p dump_plugin` and PYTHONPATH pointing at this directory; set TL_DUMP to the output
file and TL_LABEL to a name for the emitter. Each line is {"emitter", "test", "doc"} where doc is
the OTLP/JSON encoding (ids as hex) of one finished span, written by the OpenTelemetry SDK's own
protobuf encoder. Nothing about the span is changed or added.

TL_HOOK=exporter (default) copies what an InMemorySpanExporter is handed; TL_HOOK=processor copies
every span that ends on an SDK TracerProvider, for test suites that use another exporter.
"""
import base64, json, os

from google.protobuf.json_format import MessageToDict
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.trace.export import SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


def _hexify(node):
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if k in ("traceId", "spanId", "parentSpanId") and isinstance(v, str):
                node[k] = base64.b64decode(v).hex()
            else:
                _hexify(v)
    elif isinstance(node, list):
        for v in node:
            _hexify(v)
    return node


_orig = InMemorySpanExporter.export


_buffer = []


def _export(self, spans):
    result = _orig(self, spans)
    _write(spans)
    return result


_seen = set()


def _write(spans):
    """Encode now, write later: some suites forbid file I/O inside the event loop.

    A span that reaches the hook through two processors (Logfire wraps its processors) is written
    once: the same trace and span id, ended at the same instant, is the same span.
    """
    spans = [s for s in spans if (s.context.trace_id, s.context.span_id, s.end_time) not in _seen]
    _seen.update((s.context.trace_id, s.context.span_id, s.end_time) for s in spans)
    if os.environ.get("TL_DUMP") and spans:
        doc = _hexify(MessageToDict(encode_spans(list(spans))))
        test = os.environ.get("PYTEST_CURRENT_TEST", "").split(" ")[0]
        _buffer.append({"emitter": os.environ.get("TL_LABEL", ""), "test": test, "doc": doc})


def _flush():
    path = os.environ.get("TL_DUMP")
    if path and _buffer:
        with open(path, "a") as fh:
            for row in _buffer:
                fh.write(json.dumps(row) + "\n")
        _buffer.clear()


def pytest_runtest_teardown(item, nextitem):
    _flush()


def pytest_sessionfinish(session, exitstatus):
    _flush()


if os.environ.get("TL_HOOK", "exporter") == "processor":
    from opentelemetry.sdk import trace as _sdk_trace

    for _cls in (_sdk_trace.SynchronousMultiSpanProcessor, _sdk_trace.ConcurrentMultiSpanProcessor):
        def _patch(cls):
            orig = cls.on_end

            def on_end(self, span):
                _write([span])
                return orig(self, span)

            cls.on_end = on_end

        _patch(_cls)
else:
    InMemorySpanExporter.export = _export
