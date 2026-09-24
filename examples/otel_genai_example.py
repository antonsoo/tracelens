#!/usr/bin/env python3
"""
otel_genai_example.py

Generates a static OTLP/JSON trace export for a small "research-agent" scenario
(weather lookup + calculator with a retried transient failure + a currency
lookup that fails permanently), instrumented per the OpenTelemetry GenAI
semantic conventions (status: "development", no version tag -- continuously
released; verified against github.com/open-telemetry/semantic-conventions-genai
docs/gen-ai/gen-ai-spans.md and docs/gen-ai/gen-ai-events.md, fetched
2026-09-24; base semconv v1.44.0 for error.type / server.*).

Telemetry is produced by the real OpenTelemetry Python SDK; the LLM/tool calls
are mocked (no API keys available in this environment).

Output: output/genai-semconv-trace.json (real OTLP/JSON wire shape, typed
AnyValue attribute encoding, hex trace/span ids).
"""

import base64
import json
import time
import uuid
from pathlib import Path

from google.protobuf.json_format import MessageToJson
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.trace import SpanKind, Status, StatusCode

HERE = Path(__file__).resolve().parent
OUTPUT_PATH = HERE / "genai-semconv-trace.json"


# ---------------------------------------------------------------------------
# A minimal real SpanExporter that just captures the finished ReadableSpan
# objects the SDK hands it (no network -- this replaces the OTLP/HTTP
# exporter, which would require a live collector endpoint).
# ---------------------------------------------------------------------------
class CollectingExporter(SpanExporter):
    def __init__(self):
        self.spans = []

    def export(self, spans):
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self):
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


def jmsg(obj) -> str:
    """JSON-serialize a structured message/argument object for a string attribute."""
    return json.dumps(obj, ensure_ascii=False)


def fix_ids(node):
    """protobuf JSON base64-encodes `bytes` fields by default; OTLP/JSON requires
    trace_id/span_id/parent_span_id to be lowercase hex strings instead."""
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if key in ("traceId", "spanId", "parentSpanId") and isinstance(value, str):
                node[key] = base64.b64decode(value).hex()
            else:
                fix_ids(value)
    elif isinstance(node, list):
        for item in node:
            fix_ids(item)
    return node


# ---------------------------------------------------------------------------
# Resource + provider setup
# ---------------------------------------------------------------------------
resource = Resource.create(
    {
        "service.name": "tracelens-example-agent",
        "service.version": "0.3.1",
        "deployment.environment.name": "demo",
    }
)

exporter = CollectingExporter()
provider = TracerProvider(resource=resource)
provider.add_span_processor(SimpleSpanProcessor(exporter))
tracer = provider.get_tracer("tracelens.examples.genai_semconv", "1.0.0")

PROVIDER_NAME = "openai"
REQUEST_MODEL = "gpt-4o-mini"
RESPONSE_MODEL = "gpt-4o-mini-2024-07-18"

SYSTEM_INSTRUCTIONS = [
    {
        "type": "text",
        "content": (
            "You are a helpful research assistant with access to a get_weather "
            "tool, a calculator tool, and a currency lookup tool. Use tools "
            "whenever you need real-time or computed data, and always ground "
            "your final answer in the tool results you actually received -- "
            "never guess a number a tool call failed to produce."
        ),
    }
]

USER_QUESTION = (
    "What's the current temperature in Lisbon, and what would that be in "
    "Fahrenheit? Also, roughly how many Japanese yen is 100 EUR worth right now?"
)

# ---------------------------------------------------------------------------
# Run the scenario
# ---------------------------------------------------------------------------
with tracer.start_as_current_span("invoke_agent research-agent", kind=SpanKind.INTERNAL) as root_span:
    root_span.set_attribute("gen_ai.operation.name", "invoke_agent")
    root_span.set_attribute("gen_ai.agent.name", "research-agent")
    root_span.set_attribute("gen_ai.provider.name", PROVIDER_NAME)
    root_span.set_attribute("gen_ai.system_instructions", jmsg(SYSTEM_INSTRUCTIONS))
    time.sleep(0.005)

    # ---- LLM call #1: decide to call get_weather -------------------------
    weather_args = {"location": "Lisbon, Portugal", "unit": "celsius"}
    messages_1_in = [{"role": "user", "parts": [{"type": "text", "content": USER_QUESTION}]}]
    messages_1_out = [
        {
            "role": "assistant",
            "parts": [
                {
                    "type": "tool_call",
                    "id": "call_weather_1",
                    "name": "get_weather",
                    "arguments": weather_args,
                }
            ],
        }
    ]

    with tracer.start_as_current_span(f"chat {REQUEST_MODEL}", kind=SpanKind.CLIENT) as chat1:
        chat1.set_attribute("gen_ai.operation.name", "chat")
        chat1.set_attribute("gen_ai.provider.name", PROVIDER_NAME)
        chat1.set_attribute("gen_ai.request.model", REQUEST_MODEL)
        chat1.set_attribute("gen_ai.response.model", RESPONSE_MODEL)
        chat1.set_attribute("gen_ai.request.temperature", 0.2)
        chat1.set_attribute("gen_ai.request.max_tokens", 1024)
        chat1.set_attribute("gen_ai.response.id", f"chatcmpl-{uuid.uuid4().hex[:24]}")
        chat1.set_attribute("gen_ai.response.finish_reasons", ["tool_calls"])
        chat1.set_attribute("gen_ai.usage.input_tokens", 187)
        chat1.set_attribute("gen_ai.usage.output_tokens", 24)
        chat1.set_attribute("gen_ai.input.messages", jmsg(messages_1_in))
        chat1.set_attribute("gen_ai.output.messages", jmsg(messages_1_out))
        time.sleep(0.03)

    # ---- execute_tool get_weather (success) -------------------------------
    weather_result = {
        "location": "Lisbon, Portugal",
        "temperature_c": 24.5,
        "condition": "Partly cloudy",
        "humidity_pct": 58,
    }
    with tracer.start_as_current_span("execute_tool get_weather", kind=SpanKind.INTERNAL) as tool1:
        tool1.set_attribute("gen_ai.operation.name", "execute_tool")
        tool1.set_attribute("gen_ai.provider.name", PROVIDER_NAME)
        tool1.set_attribute("gen_ai.tool.name", "get_weather")
        tool1.set_attribute("gen_ai.tool.call.id", "call_weather_1")
        tool1.set_attribute("gen_ai.tool.description", "Look up current weather conditions for a named location.")
        tool1.set_attribute("gen_ai.tool.type", "function")
        tool1.set_attribute("gen_ai.tool.call.arguments", jmsg(weather_args))
        tool1.set_attribute("gen_ai.tool.call.result", jmsg(weather_result))
        time.sleep(0.02)

    # ---- LLM call #2: decide to call calculator + lookup_currency --------
    calc_args = {"expression": "24.5 * 9/5 + 32"}
    currency_args = {"from_currency": "EUR", "to_currency": "JPY", "amount": 100}

    messages_2_in = messages_1_in + messages_1_out + [
        {
            "role": "tool",
            "parts": [{"type": "tool_call_response", "id": "call_weather_1", "response": weather_result}],
        }
    ]
    messages_2_out = [
        {
            "role": "assistant",
            "parts": [
                {"type": "tool_call", "id": "call_calc_1", "name": "calculator", "arguments": calc_args},
                {
                    "type": "tool_call",
                    "id": "call_currency_1",
                    "name": "lookup_currency",
                    "arguments": currency_args,
                },
            ],
        }
    ]

    with tracer.start_as_current_span(f"chat {REQUEST_MODEL}", kind=SpanKind.CLIENT) as chat2:
        chat2.set_attribute("gen_ai.operation.name", "chat")
        chat2.set_attribute("gen_ai.provider.name", PROVIDER_NAME)
        chat2.set_attribute("gen_ai.request.model", REQUEST_MODEL)
        chat2.set_attribute("gen_ai.response.model", RESPONSE_MODEL)
        chat2.set_attribute("gen_ai.request.temperature", 0.2)
        chat2.set_attribute("gen_ai.request.max_tokens", 1024)
        chat2.set_attribute("gen_ai.response.id", f"chatcmpl-{uuid.uuid4().hex[:24]}")
        chat2.set_attribute("gen_ai.response.finish_reasons", ["tool_calls"])
        chat2.set_attribute("gen_ai.usage.input_tokens", 246)
        chat2.set_attribute("gen_ai.usage.output_tokens", 51)
        chat2.set_attribute("gen_ai.input.messages", jmsg(messages_2_in))
        chat2.set_attribute("gen_ai.output.messages", jmsg(messages_2_out))
        time.sleep(0.03)

    # ---- execute_tool calculator -- attempt 1: transient failure ---------
    with tracer.start_as_current_span(
        "execute_tool calculator",
        kind=SpanKind.INTERNAL,
        record_exception=False,
        set_status_on_exception=False,
    ) as tool2a:
        tool2a.set_attribute("gen_ai.operation.name", "execute_tool")
        tool2a.set_attribute("gen_ai.provider.name", PROVIDER_NAME)
        tool2a.set_attribute("gen_ai.tool.name", "calculator")
        tool2a.set_attribute("gen_ai.tool.call.id", "call_calc_1")
        tool2a.set_attribute(
            "gen_ai.tool.description", "Evaluate a basic arithmetic expression and return the numeric result."
        )
        tool2a.set_attribute("gen_ai.tool.type", "function")
        tool2a.set_attribute("gen_ai.tool.call.arguments", jmsg(calc_args))
        tool2a.set_attribute("retry.attempt", 1)
        try:
            raise TimeoutError("calculator backend did not respond within 2000ms (upstream timeout)")
        except TimeoutError as exc:
            tool2a.set_attribute("error.type", "timeout")
            tool2a.record_exception(exc)
            tool2a.set_status(Status(StatusCode.ERROR, str(exc)))
        time.sleep(0.02)

    # ---- execute_tool calculator -- attempt 2 (retry): success -----------
    calc_result = {"expression": "24.5 * 9/5 + 32", "result": 76.1}
    with tracer.start_as_current_span("execute_tool calculator", kind=SpanKind.INTERNAL) as tool2b:
        tool2b.set_attribute("gen_ai.operation.name", "execute_tool")
        tool2b.set_attribute("gen_ai.provider.name", PROVIDER_NAME)
        tool2b.set_attribute("gen_ai.tool.name", "calculator")
        tool2b.set_attribute("gen_ai.tool.call.id", "call_calc_1")
        tool2b.set_attribute(
            "gen_ai.tool.description", "Evaluate a basic arithmetic expression and return the numeric result."
        )
        tool2b.set_attribute("gen_ai.tool.type", "function")
        tool2b.set_attribute("gen_ai.tool.call.arguments", jmsg(calc_args))
        tool2b.set_attribute("gen_ai.tool.call.result", jmsg(calc_result))
        tool2b.set_attribute("retry.attempt", 2)
        time.sleep(0.015)

    # ---- execute_tool lookup_currency -- fails permanently, not retried ---
    with tracer.start_as_current_span(
        "execute_tool lookup_currency",
        kind=SpanKind.INTERNAL,
        record_exception=False,
        set_status_on_exception=False,
    ) as tool3:
        tool3.set_attribute("gen_ai.operation.name", "execute_tool")
        tool3.set_attribute("gen_ai.provider.name", PROVIDER_NAME)
        tool3.set_attribute("gen_ai.tool.name", "lookup_currency")
        tool3.set_attribute("gen_ai.tool.call.id", "call_currency_1")
        tool3.set_attribute(
            "gen_ai.tool.description",
            "Look up a live conversion rate and convert an amount between two ISO 4217 currency codes.",
        )
        tool3.set_attribute("gen_ai.tool.type", "function")
        tool3.set_attribute("gen_ai.tool.call.arguments", jmsg(currency_args))
        try:
            raise ValueError(
                "invalid_argument: currency code 'JPY' is not enabled for this API key's pricing tier "
                "(enabled: USD, EUR, GBP)"
            )
        except ValueError as exc:
            tool3.set_attribute("error.type", "invalid_argument")
            tool3.record_exception(exc)
            tool3.set_status(Status(StatusCode.ERROR, str(exc)))
        time.sleep(0.015)

    # ---- LLM call #3: final answer -----------------------------------------
    currency_error = {
        "error": "invalid_argument",
        "message": "currency code 'JPY' is not enabled for this API key's pricing tier (enabled: USD, EUR, GBP)",
    }
    messages_3_in = messages_2_in + messages_2_out + [
        {"role": "tool", "parts": [{"type": "tool_call_response", "id": "call_calc_1", "response": calc_result}]},
        {
            "role": "tool",
            "parts": [{"type": "tool_call_response", "id": "call_currency_1", "response": currency_error}],
        },
    ]
    final_answer = (
        "Lisbon is currently 24.5°C (76.1°F) and partly cloudy, with 58% humidity. "
        "I wasn't able to get you a live EUR→JPY rate, though -- the currency lookup failed "
        "because JPY isn't enabled on this API key's current pricing tier. If you can enable JPY "
        "on the account (or give me a rate to use), I can redo the 100 EUR conversion right away."
    )
    messages_3_out = [{"role": "assistant", "parts": [{"type": "text", "content": final_answer}]}]

    with tracer.start_as_current_span(f"chat {REQUEST_MODEL}", kind=SpanKind.CLIENT) as chat3:
        chat3.set_attribute("gen_ai.operation.name", "chat")
        chat3.set_attribute("gen_ai.provider.name", PROVIDER_NAME)
        chat3.set_attribute("gen_ai.request.model", REQUEST_MODEL)
        chat3.set_attribute("gen_ai.response.model", RESPONSE_MODEL)
        chat3.set_attribute("gen_ai.request.temperature", 0.2)
        chat3.set_attribute("gen_ai.request.max_tokens", 1024)
        chat3.set_attribute("gen_ai.response.id", f"chatcmpl-{uuid.uuid4().hex[:24]}")
        chat3.set_attribute("gen_ai.response.finish_reasons", ["stop"])
        chat3.set_attribute("gen_ai.usage.input_tokens", 412)
        chat3.set_attribute("gen_ai.usage.output_tokens", 88)
        chat3.set_attribute("gen_ai.usage.cache_read.input_tokens", 256)
        chat3.set_attribute("gen_ai.input.messages", jmsg(messages_3_in))
        chat3.set_attribute("gen_ai.output.messages", jmsg(messages_3_out))
        time.sleep(0.03)

provider.shutdown()

# ---------------------------------------------------------------------------
# Encode captured real ReadableSpans to OTLP/JSON wire shape
# ---------------------------------------------------------------------------
request = encode_spans(exporter.spans)
json_text = MessageToJson(
    request,
    preserving_proto_field_name=False,  # camelCase, matches real collector output
    use_integers_for_enums=True,  # OTLP/JSON requires numeric enums (e.g. status.code == 2)
    indent=2,
)
payload = fix_ids(json.loads(json_text))

OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
with open(OUTPUT_PATH, "w") as f:
    json.dump(payload, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"wrote {len(exporter.spans)} spans -> {OUTPUT_PATH}")
