# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-common==1.45.1", "protobuf==7.36.2"]
# ///
"""Native SDK status capture and independent Protobuf decoding of JSON variants.

A controlled local exception is recorded as a failed tool call, followed by
a successful tool call. No model, remote service or collector is contacted.
The stacktrace attribute is deliberately supplied with a path-free description.
"""
import argparse
import base64
import copy
import hashlib
import importlib.metadata
import json
from pathlib import Path

from google.protobuf.json_format import MessageToDict, ParseDict
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Status, StatusCode


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
    provider = TracerProvider(resource=Resource({'service.name': 'controlled-status-capture'}))
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer('tracelens.status-capture', '1')
    with tracer.start_as_current_span('agent run', attributes={'gen_ai.agent.name': 'status capture'}):
        with tracer.start_as_current_span('retrieve', attributes={
            'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'retrieve',
        }) as span:
            try:
                raise RuntimeError('Controlled local fixture failure.')
            except RuntimeError as exc:
                span.record_exception(exc, attributes={
                    'exception.stacktrace': 'Controlled local failure; full stack intentionally excluded.',
                })
                span.set_status(Status(StatusCode.ERROR, 'Controlled local fixture failure.'))
        with tracer.start_as_current_span('retrieve', attributes={
            'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'retrieve',
        }) as span:
            span.set_status(Status(StatusCode.OK))
    spans = list(exporter.get_finished_spans())
    native = MessageToDict(encode_spans(spans), use_integers_for_enums=True)
    error_id = next(f'{s.context.span_id:016x}' for s in spans if s.status.status_code == StatusCode.ERROR)
    oracle = {'packages': {name: importlib.metadata.version(name) for name in (
        'opentelemetry-sdk', 'opentelemetry-exporter-otlp-proto-common', 'protobuf')},
        'driverSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'spans': [{'spanId': f'{s.context.span_id:016x}', 'name': s.name,
                   'status': s.status.status_code.name, 'description': s.status.description}
                  for s in spans], 'variants': []}
    variants = [('native-integers', 2), ('native-names', 'STATUS_CODE_ERROR'),
                ('quoted-integer', '2'), ('quoted-leading-zero', '02'),
                ('quoted-signed-integer', '+2'), ('quoted-surrounding-space', ' 2 '),
                ('unknown-future-code', 3), ('invalid-name', 'garbled'),
                ('invalid-fraction', 2.5), ('invalid-boolean', False),
                ('invalid-substring-name', 'ERRORSTATUS_CODE_')]
    for name, code in variants:
        doc = copy.deepcopy(native)
        for resource in doc['resourceSpans']:
            for scope in resource['scopeSpans']:
                for raw in scope['spans']:
                    if base64.b64decode(raw['spanId']).hex() == error_id:
                        raw['status']['code'] = code
        parsed = ExportTraceServiceRequest()
        try:
            ParseDict(doc, parsed)
            outcomes = [s.status.code for r in parsed.resource_spans for sc in r.scope_spans for s in sc.spans
                        if s.span_id.hex() == error_id]
            protobuf = {'accepted': True, 'errorSpanCode': outcomes[0]}
        except Exception as exc:
            protobuf = {'accepted': False, 'exception': type(exc).__name__}
        path = args.output / f'{name}.json'
        path.write_text(json.dumps(hex_ids(doc), indent=2) + '\n')
        oracle['variants'].append({'name': name, 'file': path.name, 'inputCode': code,
                                   'protobuf': protobuf, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    provider.shutdown()
    (args.output / 'oracle.json').write_text(json.dumps(oracle, indent=2) + '\n')
    print(json.dumps(oracle['variants'], indent=2))


if __name__ == '__main__':
    main()
