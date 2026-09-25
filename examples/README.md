# Example traces

Both trace files in this directory are **real [OpenTelemetry Python SDK](https://opentelemetry.io/docs/languages/python/)
output**: real trace/span IDs, real parent/child links, real captured Python
stack traces on the failing spans, and a real OTLP/JSON encoding (via
`opentelemetry-exporter-otlp-proto-common`'s `encode_spans` + protobuf's
`MessageToJson`). What is **mocked** is the content: this machine has no LLM
API keys, so the scripts fabricate plausible completions and tool results
instead of calling a real provider. `otel_genai_example.py` also sets span
start/end times explicitly, so its timeline has realistic durations
(multi-second model calls) without the script sleeping for half a minute.
The telemetry format is not mocked, only what's inside it.

## Scenario: `genai-semconv-trace.json` (the viewer's default)

A fictional on-call assistant, `incident-analyst`, is asked why p95 checkout
latency regressed and what it cost. 16 spans over 31.8 s:

1. `invoke_agent incident-analyst`: the root span.
2. `chat claude-sonnet-5`: plans, and asks for three lookups at once.
3. `execute_tool search_incidents`, `query_metrics`, `list_deploys`: run in
   parallel.
4. `chat claude-sonnet-5`: asks for the suspect deploy's diff and the slow
   traces.
5. `execute_tool get_diff`: succeeds.
6. `execute_tool query_traces` (attempt 1): **fails** after 5 s
   (`error.type=timeout`, a real `TimeoutError` recorded with
   `span.record_exception()`).
7. `execute_tool query_traces` (attempt 2, retry): succeeds.
8. `invoke_agent cost-estimator`: a sub-agent on `claude-haiku-4-5` that runs
   a SQL query, then **fails permanently** on an FX lookup
   (`error.type=invalid_argument`, not retried) and reports in EUR instead.
9. `chat claude-sonnet-5`: writes the final answer from the tool results.

Token counts include prompt-cache reads and writes, so the cost column shows
what caching saved.

## Scenario: `openinference-trace.json`

A smaller 8-span run (a weather/calculator/currency "research agent" with one
retried and one permanent tool failure) in the OpenInference conventions, to
show the same viewer on the other attribute schema.

## Files

| File | Convention |
|---|---|
| `genai-semconv-trace.json` | [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) (`gen_ai.*`) |
| `openinference-trace.json` | [OpenInference semantic conventions](https://github.com/Arize-ai/openinference) (`openinference.*`, `llm.*`) |
| `otel_genai_example.py` | Generates `genai-semconv-trace.json` |
| `openinference_example.py` | Generates `openinference-trace.json` |

See [`docs/formats.md`](../docs/formats.md) for the exact attribute keys each
file uses and the spec versions they were verified against.

## Regenerating

```bash
uv venv && source .venv/bin/activate
uv pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http opentelemetry-exporter-otlp-proto-common
python examples/otel_genai_example.py
python examples/openinference_example.py
```

Each run overwrites its trace file with fresh IDs (the GenAI trace keeps its
fixed timestamps; the OpenInference one takes the wall clock). The small
copies in `tests/fixtures/` are what the tests assert on, so regenerating
these files never breaks the test suite.
