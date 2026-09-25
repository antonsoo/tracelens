#!/usr/bin/env python3
"""
openinference_example.py

Generates a static OTLP/JSON trace export for the same "research-agent"
scenario as otel_genai_example.py (weather lookup + calculator with a
retried transient failure + a currency lookup that fails permanently), this
time instrumented per the OpenInference semantic conventions instead of the
OpenTelemetry GenAI conventions.

Telemetry is produced by the real OpenTelemetry Python SDK; the LLM/tool calls
are mocked (no API keys available in this environment).

Output: output/openinference-trace.json (real OTLP/JSON wire shape, typed
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
OUTPUT_PATH = HERE / "openinference-trace.json"


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
    return json.dumps(obj, ensure_ascii=False)


def relativize_paths(node, root: str):
    """Recorded stack traces carry absolute file paths from the build machine;
    make them repo-relative so the committed trace is machine-independent."""
    if isinstance(node, dict):
        return {k: relativize_paths(v, root) for k, v in node.items()}
    if isinstance(node, list):
        return [relativize_paths(v, root) for v in node]
    if isinstance(node, str):
        return node.replace(root, "")
    return node


def fix_ids(node):
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


def set_indexed_messages(span, prefix, messages):
    """messages: list of {"role": str, "content": str}"""
    for i, msg in enumerate(messages):
        span.set_attribute(f"{prefix}.{i}.message.role", msg["role"])
        span.set_attribute(f"{prefix}.{i}.message.content", msg["content"])


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
tracer = provider.get_tracer("tracelens.examples.openinference", "1.0.0")

PROVIDER_NAME = "openai"
MODEL_NAME = "gpt-4o-mini"
SESSION_ID = f"session-{uuid.uuid4().hex[:16]}"

USER_QUESTION = (
    "What's the current temperature in Lisbon, and what would that be in "
    "Fahrenheit? Also, roughly how many Japanese yen is 100 EUR worth right now?"
)

# ---------------------------------------------------------------------------
with tracer.start_as_current_span("invoke_agent research-agent", kind=SpanKind.INTERNAL) as root_span:
    root_span.set_attribute("openinference.span.kind", "AGENT")
    root_span.set_attribute("session.id", SESSION_ID)
    root_span.set_attribute(
        "input.value",
        USER_QUESTION,
    )
    time.sleep(0.005)

    # ---- LLM call #1: decide to call get_weather -------------------------
    weather_args = {"location": "Lisbon, Portugal", "unit": "celsius"}

    with tracer.start_as_current_span(f"chat {MODEL_NAME}", kind=SpanKind.CLIENT) as chat1:
        chat1.set_attribute("openinference.span.kind", "LLM")
        chat1.set_attribute("llm.system", PROVIDER_NAME)
        chat1.set_attribute("llm.provider", PROVIDER_NAME)
        chat1.set_attribute("llm.model_name", MODEL_NAME)
        chat1.set_attribute("llm.token_count.prompt", 187)
        chat1.set_attribute("llm.token_count.completion", 24)
        chat1.set_attribute("llm.token_count.total", 187 + 24)
        set_indexed_messages(
            chat1,
            "llm.input_messages",
            [{"role": "user", "content": USER_QUESTION}],
        )
        set_indexed_messages(
            chat1,
            "llm.output_messages",
            [
                {
                    "role": "assistant",
                    "content": jmsg(
                        {"tool_call": {"id": "call_weather_1", "name": "get_weather", "arguments": weather_args}}
                    ),
                }
            ],
        )
        time.sleep(0.03)

    # ---- execute_tool get_weather (success) -------------------------------
    weather_result = {
        "location": "Lisbon, Portugal",
        "temperature_c": 24.5,
        "condition": "Partly cloudy",
        "humidity_pct": 58,
    }
    with tracer.start_as_current_span("execute_tool get_weather", kind=SpanKind.INTERNAL) as tool1:
        tool1.set_attribute("openinference.span.kind", "TOOL")
        tool1.set_attribute("tool.name", "get_weather")
        tool1.set_attribute("tool.description", "Look up current weather conditions for a named location.")
        tool1.set_attribute("tool.parameters", jmsg(weather_args))
        tool1.set_attribute("input.value", jmsg(weather_args))
        tool1.set_attribute("input.mime_type", "application/json")
        tool1.set_attribute("output.value", jmsg(weather_result))
        tool1.set_attribute("output.mime_type", "application/json")
        time.sleep(0.02)

    # ---- LLM call #2: decide to call calculator + lookup_currency --------
    calc_args = {"expression": "24.5 * 9/5 + 32"}
    currency_args = {"from_currency": "EUR", "to_currency": "JPY", "amount": 100}

    with tracer.start_as_current_span(f"chat {MODEL_NAME}", kind=SpanKind.CLIENT) as chat2:
        chat2.set_attribute("openinference.span.kind", "LLM")
        chat2.set_attribute("llm.system", PROVIDER_NAME)
        chat2.set_attribute("llm.provider", PROVIDER_NAME)
        chat2.set_attribute("llm.model_name", MODEL_NAME)
        chat2.set_attribute("llm.token_count.prompt", 246)
        chat2.set_attribute("llm.token_count.completion", 51)
        chat2.set_attribute("llm.token_count.total", 246 + 51)
        set_indexed_messages(
            chat2,
            "llm.input_messages",
            [
                {"role": "user", "content": USER_QUESTION},
                {
                    "role": "assistant",
                    "content": jmsg(
                        {"tool_call": {"id": "call_weather_1", "name": "get_weather", "arguments": weather_args}}
                    ),
                },
                {"role": "tool", "content": jmsg(weather_result)},
            ],
        )
        set_indexed_messages(
            chat2,
            "llm.output_messages",
            [
                {
                    "role": "assistant",
                    "content": jmsg(
                        {
                            "tool_calls": [
                                {"id": "call_calc_1", "name": "calculator", "arguments": calc_args},
                                {"id": "call_currency_1", "name": "lookup_currency", "arguments": currency_args},
                            ]
                        }
                    ),
                }
            ],
        )
        time.sleep(0.03)

    # ---- execute_tool calculator -- attempt 1: transient failure ---------
    with tracer.start_as_current_span(
        "execute_tool calculator",
        kind=SpanKind.INTERNAL,
        record_exception=False,
        set_status_on_exception=False,
    ) as tool2a:
        tool2a.set_attribute("openinference.span.kind", "TOOL")
        tool2a.set_attribute("tool.name", "calculator")
        tool2a.set_attribute(
            "tool.description", "Evaluate a basic arithmetic expression and return the numeric result."
        )
        tool2a.set_attribute("tool.parameters", jmsg(calc_args))
        tool2a.set_attribute("input.value", jmsg(calc_args))
        tool2a.set_attribute("input.mime_type", "application/json")
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
        tool2b.set_attribute("openinference.span.kind", "TOOL")
        tool2b.set_attribute("tool.name", "calculator")
        tool2b.set_attribute(
            "tool.description", "Evaluate a basic arithmetic expression and return the numeric result."
        )
        tool2b.set_attribute("tool.parameters", jmsg(calc_args))
        tool2b.set_attribute("input.value", jmsg(calc_args))
        tool2b.set_attribute("input.mime_type", "application/json")
        tool2b.set_attribute("output.value", jmsg(calc_result))
        tool2b.set_attribute("output.mime_type", "application/json")
        tool2b.set_attribute("retry.attempt", 2)
        time.sleep(0.015)

    # ---- execute_tool lookup_currency -- fails permanently, not retried ---
    with tracer.start_as_current_span(
        "execute_tool lookup_currency",
        kind=SpanKind.INTERNAL,
        record_exception=False,
        set_status_on_exception=False,
    ) as tool3:
        tool3.set_attribute("openinference.span.kind", "TOOL")
        tool3.set_attribute("tool.name", "lookup_currency")
        tool3.set_attribute(
            "tool.description",
            "Look up a live conversion rate and convert an amount between two ISO 4217 currency codes.",
        )
        tool3.set_attribute("tool.parameters", jmsg(currency_args))
        tool3.set_attribute("input.value", jmsg(currency_args))
        tool3.set_attribute("input.mime_type", "application/json")
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
    final_answer = (
        "Lisbon is currently 24.5°C (76.1°F) and partly cloudy, with 58% humidity. "
        "I wasn't able to get you a live EUR→JPY rate, though -- the currency lookup failed "
        "because JPY isn't enabled on this API key's current pricing tier. If you can enable JPY "
        "on the account (or give me a rate to use), I can redo the 100 EUR conversion right away."
    )

    with tracer.start_as_current_span(f"chat {MODEL_NAME}", kind=SpanKind.CLIENT) as chat3:
        chat3.set_attribute("openinference.span.kind", "LLM")
        chat3.set_attribute("llm.system", PROVIDER_NAME)
        chat3.set_attribute("llm.provider", PROVIDER_NAME)
        chat3.set_attribute("llm.model_name", MODEL_NAME)
        chat3.set_attribute("llm.token_count.prompt", 412)
        chat3.set_attribute("llm.token_count.completion", 88)
        chat3.set_attribute("llm.token_count.total", 412 + 88)
        chat3.set_attribute("llm.token_count.prompt_details.cache_read", 256)
        set_indexed_messages(
            chat3,
            "llm.input_messages",
            [
                {"role": "user", "content": USER_QUESTION},
                {
                    "role": "assistant",
                    "content": jmsg(
                        {
                            "tool_calls": [
                                {"id": "call_calc_1", "name": "calculator", "arguments": calc_args},
                                {"id": "call_currency_1", "name": "lookup_currency", "arguments": currency_args},
                            ]
                        }
                    ),
                },
                {"role": "tool", "content": jmsg(calc_result)},
                {"role": "tool", "content": jmsg(currency_error)},
            ],
        )
        set_indexed_messages(
            chat3,
            "llm.output_messages",
            [{"role": "assistant", "content": final_answer}],
        )
        time.sleep(0.03)

    root_span.set_attribute("output.value", final_answer)

provider.shutdown()

# ---------------------------------------------------------------------------
request = encode_spans(exporter.spans)
json_text = MessageToJson(
    request,
    preserving_proto_field_name=False,
    use_integers_for_enums=True,
    indent=2,
)
payload = relativize_paths(fix_ids(json.loads(json_text)), str(HERE.parent) + "/")

OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
with open(OUTPUT_PATH, "w") as f:
    json.dump(payload, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"wrote {len(exporter.spans)} spans -> {OUTPUT_PATH}")
