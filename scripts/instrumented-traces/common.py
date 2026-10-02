"""Shared pieces for writing tests/fixtures/instrumented/: traces from real instrumentation.

Each SDK is called through a mocked HTTP transport (no network, no API key) with one of the
instrumentation libraries active, so the spans are the ones that library really writes for
an agent turn that calls a tool and then answers: attribute names, how messages and tool
calls are laid out, how tokens are counted. The conversation and the token counts are made
up. Spans are exported in memory and written as OTLP/JSON with hex ids, as a Collector's
file exporter writes them.
"""
import base64, json, importlib
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from google.protobuf.json_format import MessageToDict

exporter = InMemorySpanExporter()
provider = TracerProvider(resource=Resource.create({"service.name": "agent-demo"}))
provider.add_span_processor(SimpleSpanProcessor(exporter))
trace.set_tracer_provider(provider)

def hexify(node):
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if k in ("traceId", "spanId", "parentSpanId") and isinstance(v, str):
                node[k] = base64.b64decode(v).hex()
            else:
                hexify(v)
    elif isinstance(node, list):
        for v in node: hexify(v)
    return node

def dump(path):
    spans = exporter.get_finished_spans()
    doc = hexify(MessageToDict(encode_spans(spans)))
    json.dump(doc, open(path, "w"), indent=1)
    print(path, len(spans), "spans")

def http_for(sdk):
    for base in sdk.DefaultHttpxClient.__mro__[1:]:
        root = base.__module__.split(".")[0]
        if root.startswith("httpx"):
            return importlib.import_module(root)

def anthropic_handler(hx):
    state = {"n": 0}
    def handler(request):
        body = json.loads(request.content); state["n"] += 1
        if state["n"] == 1:
            content = [{"type": "text", "text": "I'll check the weather."}, {"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "Paris"}}]
            stop = "tool_use"
        else:
            content = [{"type": "text", "text": "It is 18°C and sunny in Paris."}]
            stop = "end_turn"
        return hx.Response(200, json={"id": f"msg_{state['n']}", "type": "message", "role": "assistant", "model": body["model"], "content": content, "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 420, "output_tokens": 37, "cache_read_input_tokens": 300, "cache_creation_input_tokens": 0}})
    return handler

def openai_handler(hx):
    state = {"n": 0}
    def handler(request):
        body = json.loads(request.content); state["n"] += 1
        if state["n"] == 1:
            message = {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\": \"Paris\"}"}}]}
            finish = "tool_calls"
        else:
            message = {"role": "assistant", "content": "It is 18°C and sunny in Paris."}
            finish = "stop"
        return hx.Response(200, json={"id": f"chatcmpl-{state['n']}", "object": "chat.completion", "created": 1, "model": body["model"], "choices": [{"index": 0, "finish_reason": finish, "message": message}], "usage": {"prompt_tokens": 420, "completion_tokens": 37, "total_tokens": 457, "prompt_tokens_details": {"cached_tokens": 300}}})
    return handler

TOOLS_A = [{"name": "get_weather", "description": "Current weather for a city", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]
TOOLS_O = [{"type": "function", "function": {"name": "get_weather", "description": "Current weather for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]

def run_anthropic():
    import anthropic
    hx = http_for(anthropic)
    client = anthropic.Anthropic(api_key="k", http_client=hx.Client(transport=hx.MockTransport(anthropic_handler(hx))), max_retries=0)
    tracer = trace.get_tracer("demo")
    with tracer.start_as_current_span("agent run"):
        messages = [{"role": "user", "content": "What's the weather in Paris?"}]
        r = client.messages.create(model="claude-opus-5-5", max_tokens=256, system="You are a weather assistant.", tools=TOOLS_A, messages=messages)
        messages += [{"role": "assistant", "content": r.content}, {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "18°C, sunny"}]}]
        client.messages.create(model="claude-opus-5-5", max_tokens=256, system="You are a weather assistant.", tools=TOOLS_A, messages=messages)

def run_openai():
    import openai
    hx = http_for(openai)
    client = openai.OpenAI(api_key="k", http_client=hx.Client(transport=hx.MockTransport(openai_handler(hx))), max_retries=0)
    tracer = trace.get_tracer("demo")
    with tracer.start_as_current_span("agent run"):
        messages = [{"role": "system", "content": "You are a weather assistant."}, {"role": "user", "content": "What's the weather in Paris?"}]
        r = client.chat.completions.create(model="gpt-6-sol", messages=messages, tools=TOOLS_O)
        messages += [r.choices[0].message, {"role": "tool", "tool_call_id": "call_1", "content": "18°C, sunny"}]
        client.chat.completions.create(model="gpt-6-sol", messages=messages, tools=TOOLS_O)
