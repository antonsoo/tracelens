# Reproduce the nano token charge

This runs AI SDK 6.0.302 and `@ai-sdk/openai` 3.0.124 against one pinned
[upstream recorded Responses stream](https://github.com/vercel/ai/blob/5028fa46b4b4e695bf0d80e968db43268e9ec5ef/packages/openai/src/responses/__fixtures__/openai-code-interpreter-tool.1.chunks.txt).
The SDK exports its own OpenTelemetry spans. The response supplies the model
and token counts; the replay prompt is a placeholder. No model or provider
endpoint is called, and no code-interpreter code is executed. Installing
dependencies and downloading the fixture do require network access.

From the repository root, using Node 20+ and Python 3:

```bash
mkdir -p /tmp/tracelens-cost-replay
curl --fail --location https://raw.githubusercontent.com/vercel/ai/5028fa46b4b4e695bf0d80e968db43268e9ec5ef/packages/openai/src/responses/__fixtures__/openai-code-interpreter-tool.1.chunks.txt --output /tmp/tracelens-cost-replay/response.chunks.txt
npm ci --prefix scripts/cost-replay --ignore-scripts --no-audit --no-fund
node scripts/cost-replay/replay.mjs /tmp/tracelens-cost-replay/response.chunks.txt /tmp/tracelens-cost-replay/trace.json /tmp/tracelens-cost-replay/replay.json
npm ci
npm run build:cli
node dist-cli/cli/index.js cost /tmp/tracelens-cost-replay/trace.json --json > /tmp/tracelens-cost-replay/cost.json
python3 scripts/cost-replay/check.py /tmp/tracelens-cost-replay/response.chunks.txt /tmp/tracelens-cost-replay/cost.json docs/cost-evidence/before.json
```

The replay checks SHA-256
`2907e69401c95a1c32bf495032c0bb4916a41b80d4a8cd49cbf97b2570633d84`,
refuses fetches outside its loopback server, and requires one request, two
spans, no stream errors, and the source input/output counts. It writes a
receipt containing package versions and hashes. IDs and timestamps change
on each replay; token usage and the token charge should not.

`check.py` separately reads the raw response and multiplies its counts by
the [nano rates](https://developers.openai.com/api/docs/models/gpt-5-nano)
checked on 2026-10-09 UTC, using Python's `decimal.Decimal`. It checks the
CLI's total and token components without importing TraceLens's price table
or matcher. The expected token charge is **$0.00081907**. The source contains
a code-interpreter operation; its separate tool fee is outside this figure.
Replayed timestamps measure local response handling, not model latency.

The bundled [trace](../../examples/cost-nano-stream.json) and
[capture receipt](../../docs/cost-evidence/replay.json) came from this script.
The upstream fixture is Apache-2.0; the [license](../../examples/cost-replay-LICENSE.txt)
is retained alongside the derived example.
