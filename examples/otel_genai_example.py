#!/usr/bin/env python3
"""
otel_genai_example.py

Generates a static OTLP/JSON trace export for an "incident-analyst" agent run,
instrumented per the OpenTelemetry GenAI semantic conventions (status:
"development", continuously released; verified against
github.com/open-telemetry/semantic-conventions-genai docs/gen-ai/gen-ai-spans.md
and docs/gen-ai/gen-ai-events.md, fetched 2026-09-24; base semconv v1.44.0 for
error.type).

The scenario (fictional company, fictional data): an engineer asks why p95
checkout latency regressed and what it cost. The agent plans, fans out three
tool calls in parallel, analyses the results, retries a trace query that timed
out, hands the cost estimate to a sub-agent (whose FX lookup fails permanently),
and writes a final answer.

Telemetry is produced by the real OpenTelemetry Python SDK: real trace/span ids,
real parent/child links, real recorded exceptions with Python stack traces, and
the real OTLP/JSON encoding. What is mocked: the model and tool calls (there are
no API keys on the build machine) and the clock. Span start/end times are passed
explicitly so the timeline has realistic durations (multi-second model calls)
without the script sleeping for half a minute; they are deterministic, so
regenerating changes only the ids.

Output: genai-semconv-trace.json (next to this script).
"""

import base64
import json
from pathlib import Path

from google.protobuf.json_format import MessageToJson
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.trace import SpanKind, Status, StatusCode

HERE = Path(__file__).resolve().parent
OUTPUT_PATH = HERE / "genai-semconv-trace.json"

# 2026-09-24T17:03:12Z, in nanoseconds. Every timestamp below is T0 + offset.
T0 = 1790269392 * 1_000_000_000


def at(seconds: float) -> int:
    return T0 + int(round(seconds * 1_000_000_000))


class CollectingExporter(SpanExporter):
    """A real SpanExporter that keeps finished spans in memory (no collector)."""

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
    """protobuf JSON base64-encodes bytes; OTLP/JSON wants hex trace/span ids."""
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


resource = Resource.create(
    {
        "service.name": "incident-analyst",
        "service.version": "2.4.0",
        "deployment.environment.name": "demo",
    }
)
exporter = CollectingExporter()
provider = TracerProvider(resource=resource)
provider.add_span_processor(SimpleSpanProcessor(exporter))
tracer = provider.get_tracer("tracelens.examples.genai_semconv", "2.0.0")

PROVIDER = "anthropic"
LEAD_MODEL = "claude-sonnet-5"
WORKER_MODEL = "claude-haiku-4-5"


def start(name, parent, t, kind=SpanKind.INTERNAL):
    ctx = trace.set_span_in_context(parent) if parent is not None else None
    return tracer.start_span(
        name, context=ctx, kind=kind, start_time=at(t), record_exception=False, set_status_on_exception=False
    )


def chat(parent, t0, t1, model, messages_in, messages_out, usage, finish, max_tokens=8192):
    span = start(f"chat {model}", parent, t0, SpanKind.CLIENT)
    span.set_attribute("gen_ai.operation.name", "chat")
    span.set_attribute("gen_ai.provider.name", PROVIDER)
    span.set_attribute("gen_ai.request.model", model)
    span.set_attribute("gen_ai.response.model", model)
    span.set_attribute("gen_ai.request.max_tokens", max_tokens)
    span.set_attribute("gen_ai.response.id", f"msg_demo_{int(t0 * 1000):07d}")
    span.set_attribute("gen_ai.response.finish_reasons", [finish])
    span.set_attribute("gen_ai.usage.input_tokens", usage["input"])
    span.set_attribute("gen_ai.usage.output_tokens", usage["output"])
    if usage.get("cache_read"):
        span.set_attribute("gen_ai.usage.cache_read.input_tokens", usage["cache_read"])
    if usage.get("cache_write"):
        span.set_attribute("gen_ai.usage.cache_write.input_tokens", usage["cache_write"])
    span.set_attribute("gen_ai.input.messages", jmsg(messages_in))
    span.set_attribute("gen_ai.output.messages", jmsg(messages_out))
    span.end(end_time=at(t1))


def tool(parent, t0, t1, name, call_id, description, args, result=None, error=None, attempt=None):
    span = start(f"execute_tool {name}", parent, t0)
    span.set_attribute("gen_ai.operation.name", "execute_tool")
    span.set_attribute("gen_ai.provider.name", PROVIDER)
    span.set_attribute("gen_ai.tool.name", name)
    span.set_attribute("gen_ai.tool.call.id", call_id)
    span.set_attribute("gen_ai.tool.description", description)
    span.set_attribute("gen_ai.tool.type", "function")
    span.set_attribute("gen_ai.tool.call.arguments", jmsg(args))
    if attempt is not None:
        span.set_attribute("retry.attempt", attempt)
    if error is not None:
        error_type, exc = error
        try:
            raise exc
        except Exception as raised:  # recorded with its real traceback
            span.set_attribute("error.type", error_type)
            span.record_exception(raised, timestamp=at(t1))
            span.set_status(Status(StatusCode.ERROR, str(raised)))
    else:
        span.set_attribute("gen_ai.tool.call.result", jmsg(result))
    span.end(end_time=at(t1))


def user(text):
    return {"role": "user", "parts": [{"type": "text", "content": text}]}


def assistant_calls(*calls):
    return {
        "role": "assistant",
        "parts": [{"type": "tool_call", "id": cid, "name": n, "arguments": a} for cid, n, a in calls],
    }


def tool_response(call_id, response):
    return {"role": "tool", "parts": [{"type": "tool_call_response", "id": call_id, "response": response}]}


def assistant_text(text):
    return {"role": "assistant", "parts": [{"type": "text", "content": text}]}


QUESTION = (
    "p95 checkout latency jumped on Tuesday afternoon. What caused it, is it fixed, "
    "and roughly what did it cost us in abandoned checkouts?"
)
SYSTEM = [
    {
        "type": "text",
        "content": (
            "You are incident-analyst, an on-call assistant for the Meridian Shop platform team. "
            "Ground every claim in tool output; say plainly when a tool failed and what that means "
            "for the answer."
        ),
    }
]

root = start("invoke_agent incident-analyst", None, 0.0)
root.set_attribute("gen_ai.operation.name", "invoke_agent")
root.set_attribute("gen_ai.agent.name", "incident-analyst")
root.set_attribute("gen_ai.provider.name", PROVIDER)
root.set_attribute("gen_ai.conversation.id", "conv_7f3c1e")
root.set_attribute("gen_ai.system_instructions", jmsg(SYSTEM))

# 1. Plan: fan out three lookups in parallel.
m1_in = [user(QUESTION)]
calls1 = [
    ("toolu_01", "search_incidents", {"query": "checkout latency", "since": "2026-09-22"}),
    ("toolu_02", "query_metrics", {"metric": "checkout.p95_ms", "from": "2026-09-22T12:00Z", "to": "2026-09-23T00:00Z", "step": "5m"}),
    ("toolu_03", "list_deploys", {"service": "checkout-api", "since": "2026-09-22"}),
]
m1_out = [assistant_calls(*calls1)]
chat(root, 0.05, 3.10, LEAD_MODEL, m1_in, m1_out, {"input": 6850, "output": 310, "cache_write": 6200}, "tool_use")

incidents = {"results": [{"id": "INC-2291", "title": "Checkout slow for EU users", "opened": "2026-09-22T14:21Z", "status": "resolved"}]}
metrics = {"metric": "checkout.p95_ms", "baseline_p95": 410, "peak_p95": 1860, "degraded_window": ["2026-09-22T14:05Z", "2026-09-22T16:40Z"]}
deploys = {"deploys": [{"id": 4127, "service": "checkout-api", "at": "2026-09-22T14:02Z", "title": "Add per-item tax recalculation"}, {"id": 4131, "service": "checkout-api", "at": "2026-09-22T16:35Z", "title": "Revert #4127"}]}
tool(root, 3.15, 3.62, "search_incidents", "toolu_01", "Full-text search over the incident tracker.", calls1[0][2], incidents)
tool(root, 3.15, 4.41, "query_metrics", "toolu_02", "Query a time series from the metrics store.", calls1[1][2], metrics)
tool(root, 3.16, 3.47, "list_deploys", "toolu_03", "List deploys for a service in a time range.", calls1[2][2], deploys)

# 2. Analyse: pull the suspect diff and the slow traces.
m2_in = m1_in + m1_out + [tool_response("toolu_01", incidents), tool_response("toolu_02", metrics), tool_response("toolu_03", deploys)]
calls2 = [
    ("toolu_04", "get_diff", {"deploy_id": 4127}),
    ("toolu_05", "query_traces", {"service": "checkout-api", "min_duration_ms": 1500, "window": metrics["degraded_window"], "limit": 50}),
]
m2_out = [assistant_calls(*calls2)]
chat(root, 4.50, 9.80, LEAD_MODEL, m2_in, m2_out, {"input": 14900, "output": 540, "cache_read": 6850}, "tool_use")

diff = {"deploy_id": 4127, "files": ["cart/tax.py"], "summary": "Tax is now recalculated per line item via tax-service (one HTTP call per item) instead of once per cart."}
tool(root, 9.85, 10.31, "get_diff", "toolu_04", "Summarise the code diff for a deploy.", calls2[0][2], diff)
tool(
    root, 9.85, 14.86, "query_traces", "toolu_05", "Search distributed traces.", calls2[1][2],
    error=("timeout", TimeoutError("trace store did not answer within 5000 ms")), attempt=1,
)
slow = {"matched": 50, "median_duration_ms": 1790, "top_span": "tax-service POST /calculate", "calls_per_checkout_p50": 14}
tool(root, 14.91, 16.22, "query_traces", "toolu_05", "Search distributed traces.", calls2[1][2], slow, attempt=2)

# 3. Delegate the cost estimate to a sub-agent on a cheaper model.
sub = start("invoke_agent cost-estimator", root, 16.30)
sub.set_attribute("gen_ai.operation.name", "invoke_agent")
sub.set_attribute("gen_ai.agent.name", "cost-estimator")
sub.set_attribute("gen_ai.provider.name", PROVIDER)
task = user("Estimate revenue lost to abandoned checkouts between 14:05 and 16:40 UTC on 2026-09-22, in USD.")
sql_args = {
    "query": "select count(*) as abandoned, sum(cart_total_eur) from checkouts "
    "where state = 'abandoned' and started_at between :a and :b",
    "params": {"a": "2026-09-22T14:05Z", "b": "2026-09-22T16:40Z"},
}
s1_out = [assistant_calls(("toolu_11", "run_sql", sql_args))]
chat(sub, 16.35, 17.60, WORKER_MODEL, [task], s1_out, {"input": 2300, "output": 190}, "tool_use", max_tokens=2048)
sql = {"abandoned": 412, "baseline_abandoned_same_window": 131, "excess_cart_value_eur": 23180.0}
tool(sub, 17.65, 19.92, "run_sql", "toolu_11", "Run a read-only SQL query against the analytics warehouse.", sql_args, sql)
s2_in = [task] + s1_out + [tool_response("toolu_11", sql)]
s2_out = [assistant_calls(("toolu_12", "lookup_fx", {"from": "EUR", "to": "USD", "date": "2026-09-22"}))]
chat(sub, 19.97, 20.91, WORKER_MODEL, s2_in, s2_out, {"input": 3100, "output": 150}, "tool_use", max_tokens=2048)
tool(
    sub, 20.95, 21.20, "lookup_fx", "toolu_12", "Historical FX rate for a currency pair.", {"from": "EUR", "to": "USD", "date": "2026-09-22"},
    error=("invalid_argument", ValueError("fx provider: historical rates are not enabled on this plan")),
)
fx_error = {"error": "invalid_argument", "message": "historical rates are not enabled on this plan"}
s3_in = s2_in + s2_out + [tool_response("toolu_12", fx_error)]
s3_out = [assistant_text("281 excess abandoned checkouts; excess cart value EUR 23,180. The EUR to USD conversion failed (historical FX not enabled), so the figure is reported in EUR.")]
chat(sub, 21.25, 24.55, WORKER_MODEL, s3_in, s3_out, {"input": 3600, "output": 420}, "end_turn", max_tokens=2048)
sub.end(end_time=at(24.60))

# 4. Synthesis.
m3_in = m2_in + m2_out + [tool_response("toolu_04", diff), tool_response("toolu_05", slow), user("[cost-estimator] " + s3_out[0]["parts"][0]["content"])]
answer = (
    "Cause: deploy #4127 (14:02 UTC) moved tax calculation to one tax-service call per line item; slow traces "
    "show about 14 calls per checkout, and p95 rose from 410 ms to 1,860 ms. Fixed: #4131 reverted it at "
    "16:35 UTC and latency returned to baseline by 16:40. Cost: 281 more abandoned checkouts than a normal "
    "Tuesday, about EUR 23,180 in cart value. I couldn't convert that to USD because the FX lookup is not "
    "enabled for historical rates."
)
chat(root, 24.70, 31.70, LEAD_MODEL, m3_in, [assistant_text(answer)], {"input": 21400, "output": 1180, "cache_read": 14900}, "end_turn")
root.end(end_time=at(31.80))

provider.shutdown()

request = encode_spans(exporter.spans)
json_text = MessageToJson(request, preserving_proto_field_name=False, use_integers_for_enums=True, indent=2)
payload = relativize_paths(fix_ids(json.loads(json_text)), str(HERE.parent) + "/")
with open(OUTPUT_PATH, "w") as f:
    json.dump(payload, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"wrote {len(exporter.spans)} spans -> {OUTPUT_PATH}")
