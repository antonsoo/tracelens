# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-common==1.45.1", "protobuf==7.36.2"]
# ///
"""Actual SDK limits and Protobuf encoding; controlled events, IDs and times.

No service or model calls. Expected counts and retained fields come from SDK
objects before serialization, not from the viewer under examination.
"""
import argparse
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path

from google.protobuf.json_format import MessageToDict, MessageToJson
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanLimits, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.id_generator import IdGenerator


class ControlledIds(IdGenerator):
    def __init__(self, value):
        self.value = value

    def generate_span_id(self):
        return self.value

    def generate_trace_id(self):
        return self.value


def hex_ids(value):
    if isinstance(value, dict):
        return {key: base64.b64decode(item).hex()
                if key in ("traceId", "spanId", "parentSpanId") else hex_ids(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [hex_ids(item) for item in value]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    spans = []
    for index, (name, limits) in enumerate([
        ('partial event history', SpanLimits(max_attributes=3, max_events=2, max_event_attributes=2)),
        ('all events dropped', SpanLimits(max_attributes=128, max_events=0)),
        ('complete control', SpanLimits()),
    ], 1):
        exporter = InMemorySpanExporter()
        provider = TracerProvider(resource=Resource({'service.name': 'controlled-sdk-limits'}),
                                  id_generator=ControlledIds(index), span_limits=limits)
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        tracer = provider.get_tracer('tracelens.drop-capture', '1')
        span = tracer.start_span(name, context=Context(), start_time=index * 10_000_000)
        for k, v in {'capture.note': 'Controlled local fixture', 'capture.requested_events': 5,
                     'gen_ai.operation.name': 'invoke_workflow', 'gen_ai.agent.name': 'limit capture',
                     'capture.kind': name}.items():
            span.set_attribute(k, v)
        for sequence in range(1, 6):
            span.add_event(f'checkpoint {sequence}', timestamp=index * 10_000_000 + sequence * 1_000_000,
                           attributes={'diagnostic.context': 'additional detail', 'step.id': sequence, 'result': 'recorded'})
        span.end(end_time=index * 10_000_000 + 6_000_000)
        spans.extend(exporter.get_finished_spans())
        provider.shutdown()
    oracle = {'scenario': __doc__.strip(), 'packages': {name: importlib.metadata.version(name) for name in
              ['opentelemetry-sdk', 'opentelemetry-exporter-otlp-proto-common', 'protobuf']}, 'spans': []}
    for s in spans:
        oracle['spans'].append({'traceId': f'{s.context.trace_id:032x}', 'spanId': f'{s.context.span_id:016x}',
            'name': s.name, 'attemptedAttributes': 5, 'attemptedEvents': 5,
            'start': str(s.start_time), 'end': str(s.end_time),
            'attributes': dict(s.attributes), 'droppedAttributesCount': s.dropped_attributes,
            'droppedEventsCount': s.dropped_events,
            'events': [{'name': e.name, 'timeUnixNano': str(e.timestamp), 'attributes': dict(e.attributes),
                        'droppedAttributesCount': e.dropped_attributes} for e in s.events]})
    request = encode_spans(spans)
    variants = {'otlp': json.dumps(hex_ids(MessageToDict(request, use_integers_for_enums=True)), indent=2),
                'proto': MessageToJson(request), 'proto-snake': MessageToJson(request, preserving_proto_field_name=True)}
    oracle['files'] = []
    for variant, content in variants.items():
        path = args.output / f'capture.{variant}.json'
        path.write_text(content + '\n')
        oracle['files'].append({'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    oracle['driverSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    (args.output / 'oracle.json').write_text(json.dumps(oracle, indent=2) + '\n')
    print(json.dumps([{'name': s['name'], 'retainedEvents': len(s['events']), 'droppedEvents': s['droppedEventsCount'],
                       'droppedAttributes': s['droppedAttributesCount']} for s in oracle['spans']]))


if __name__ == '__main__':
    main()
