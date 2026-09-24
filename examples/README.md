# Example traces

Both trace files in this directory are **real [OpenTelemetry Python SDK](https://opentelemetry.io/docs/languages/python/)
output** — real trace/span IDs, real nanosecond timestamps, a real captured
Python stack trace on the two failing spans, and a real OTLP/JSON encoding
(via `opentelemetry-exporter-otlp-proto-common`'s `encode_spans` + protobuf's
`MessageToJson`). The model calls and tool calls themselves are **mocked**:
this machine has no LLM API keys, so `otel_genai_example.py` and
`openinference_example.py` fabricate plausible completions and tool results
in Python rather than calling a real provider. The telemetry format is not
mocked — only the content inside it is.

## Scenario

A small "research agent" answers a question using a weather tool and a
calculator, illustrating the shapes a trace viewer actually needs to handle:

1. `invoke_agent research-agent` — the root span.
2. `chat` — the model decides to call `get_weather`.
3. `execute_tool get_weather` — succeeds.
4. `chat` — the model decides to call `calculator` and `lookup_currency`.
5. `execute_tool calculator` (attempt 1) — **fails** with a simulated
   upstream timeout (`error.type=timeout`, a real Python `TimeoutError`
   captured via `span.record_exception()`).
6. `execute_tool calculator` (attempt 2, retry) — succeeds.
7. `execute_tool lookup_currency` — **fails permanently** with an invalid
   currency code (`error.type=invalid_argument`) and is not retried.
8. `chat` — the model produces a final answer referencing the tool results.

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

Each run overwrites its trace file in place with fresh IDs and timestamps —
the diff will be small and cosmetic.
