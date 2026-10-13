# /// script
# requires-python = ">=3.10"
# dependencies = ["opentelemetry-util-genai==1.2b0", "opentelemetry-sdk==1.45.1", "opentelemetry-exporter-otlp-proto-common==1.45.1", "protobuf==7.36.2"]
# ///
"""Synthetic conversation, real local digest and SDK export; no model/API call."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('output', type=Path)
p.add_argument('--mode', choices=['EVENT_ONLY', 'SPAN_ONLY', 'SPAN_AND_EVENT'], default='EVENT_ONLY')
args = p.parse_args()
os.environ['OTEL_SEMCONV_STABILITY_OPT_IN'] = 'gen_ai_latest_experimental'
os.environ['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] = args.mode

from google.protobuf.json_format import MessageToDict
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.exporter.otlp.proto.common._log_encoder import encode_logs
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import SimpleLogRecordProcessor, InMemoryLogRecordExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.util.genai.handler import TelemetryHandler
from opentelemetry.util.genai.types import InputMessage, OutputMessage, Text, TextPart, ToolCallRequest, ToolCallResponse

resource = Resource.create({'service.name': 'local-genai-event-capture'})
traces = InMemorySpanExporter()
trace_provider = TracerProvider(resource=resource)
trace_provider.add_span_processor(SimpleSpanProcessor(traces))
logs = InMemoryLogRecordExporter()
log_provider = LoggerProvider(resource=resource)
log_provider.add_log_record_processor(SimpleLogRecordProcessor(logs))
handler = TelemetryHandler(tracer_provider=trace_provider, logger_provider=log_provider,
    instrumentation_scope_name='tracelens.local-genai-capture', instrumentation_scope_version='1')
tracer = trace_provider.get_tracer('tracelens.local-workflow', '1')
with tracer.start_as_current_span('inspect a document digest', attributes={'gen_ai.operation.name': 'invoke_agent'}):
    with handler.inference('local-control', request_model='scripted-response') as turn:
        turn.system_instruction = [TextPart(content='Use the digest tool; do not invent its result.')]
        turn.input_messages = [InputMessage(role='user', parts=[Text('Compute the SHA-256 of receipt-17.')])]
        turn.output_messages = [OutputMessage(role='assistant', parts=[
            ToolCallRequest(id='digest-1', name='sha256', arguments={'text': 'receipt-17'})], finish_reason='tool_calls')]
    with tracer.start_as_current_span('sha256', attributes={'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'sha256'}):
        digest = hashlib.sha256(b'receipt-17').hexdigest()
    with handler.inference('local-control', request_model='scripted-response') as turn:
        turn.input_messages = [InputMessage(role='tool', parts=[ToolCallResponse(id='digest-1', response={'sha256':digest})])]
        turn.output_messages = [OutputMessage(role='assistant', parts=[Text('SHA-256: '+digest)], finish_reason='stop')]
spans = traces.get_finished_spans()
records = logs.get_finished_logs()
args.output.mkdir(parents=True, exist_ok=False)
encoded_spans = MessageToDict(encode_spans(spans))
encoded_logs = MessageToDict(encode_logs(records))
for name, data in [('traces.json',encoded_spans),('logs.json',encoded_logs)]:
    (args.output/name).write_text(json.dumps(data,indent=2)+'\n')
(args.output/'combined.jsonl').write_text(json.dumps(encoded_logs)+'\n'+json.dumps(encoded_spans)+'\n')
oracle = {'scope':'Synthetic conversation and actual local SHA-256 computation; real SDK instrumentation and export; no model or external service called',
    'mode':args.mode, 'versions':{name:importlib.metadata.version(name) for name in ['opentelemetry-util-genai','opentelemetry-sdk','opentelemetry-exporter-otlp-proto-common','protobuf']},
    'spanCount':len(spans), 'logCount':len(records), 'logs':[
        {'traceId':f'{r.log_record.trace_id:032x}', 'spanId':f'{r.log_record.span_id:016x}',
         'eventName':r.log_record.event_name, 'timestamp':str(r.log_record.timestamp),
         'attributes':dict(r.log_record.attributes), 'body':r.log_record.body}
        for r in records]}
(args.output/'oracle.json').write_text(json.dumps(oracle,indent=2)+'\n')
print(json.dumps({k:oracle[k] for k in ['mode','spanCount','logCount','versions']}))
trace_provider.shutdown()
log_provider.shutdown()
