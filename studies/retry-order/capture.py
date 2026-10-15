# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-common==1.45.1", "protobuf==7.36.2"]
# ///
"""Capture actual local lookup outcomes with an explicitly controlled timestamp tie.

The schedule is synthetic, not measured wall time. No remote collector or model
is contacted. Native SDK spans are encoded through the OTLP Protobuf encoder.
"""
import argparse
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path

from google.protobuf.json_format import MessageToDict
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Status, StatusCode, set_span_in_context


def hex_ids(value):
    if isinstance(value, dict):
        return {key: base64.b64decode(item).hex()
                if key in ('traceId', 'spanId', 'parentSpanId') else hex_ids(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [hex_ids(item) for item in value]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource({'service.name': 'controlled-retry-order'}))
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer('tracelens.retry-order', '1')
    epoch = 1792000000000000000
    root = tracer.start_span('local lookup experiment', start_time=epoch)
    context = set_span_in_context(root)
    observations = []
    for role, start, end, key in [('failed-peer', 1, 2, 'absent'), ('successful-peer', 1, 2, 'present'),
                                 ('later-call', 3, 4, 'present')]:
        span = tracer.start_span('lookup', context=context, start_time=epoch + start * 1000000,
                                 attributes={'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup'})
        try:
            result = {'present': 'local value'}[key]
        except KeyError:
            result = None
            span.set_status(Status(StatusCode.ERROR, 'Controlled local lookup failure.'))
        else:
            span.set_status(Status(StatusCode.OK))
        span.end(end_time=epoch + end * 1000000)
        observations.append({'role': role, 'spanId': f'{span.get_span_context().span_id:016x}',
                             'startTimeUnixNano': str(epoch + start * 1000000),
                             'endTimeUnixNano': str(epoch + end * 1000000),
                             'outcome': 'ERROR' if result is None else 'OK'})
    root.end(end_time=epoch + 5000000)
    spans = exporter.get_finished_spans()
    native = hex_ids(MessageToDict(encode_spans(spans), use_integers_for_enums=True))
    path = args.output / 'native.json'
    path.write_text(json.dumps(native, indent=2) + '\n')
    oracle = {'packages': {name: importlib.metadata.version(name) for name in (
        'opentelemetry-sdk', 'opentelemetry-exporter-otlp-proto-common', 'protobuf')},
        'driverSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'nativeSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'schedule': 'Synthetic, explicitly supplied SDK start/end timestamps; outcomes from local dictionary lookups.',
        'observations': observations, 'expected': {'retryCount': 0, 'unknownRetryCount': 1},
        'reason': 'The later call has equally timed ERROR and OK predecessor candidates; export order cannot select one.'}
    (args.output / 'oracle.json').write_text(json.dumps(oracle, indent=2) + '\n')
    provider.shutdown()
    print(json.dumps({'spans': len(spans), 'observations': observations}))


if __name__ == '__main__':
    main()
