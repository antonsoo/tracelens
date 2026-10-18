# All-zero identities cannot establish a measured trace

Baseline `a74e718` accepts complete all-zero trace and span identities. An
invalid group can become the default trace, while an invalid span in a valid
trace becomes a counted model call with token usage and no parser warning.

The [OpenTelemetry API](https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext)
requires a nonzero byte in each complete trace/span ID. The retained capture
uses SDK 1.45.1 with an **explicitly broken custom ID generator**, plus a valid
generator control. The SDK records and serializes the spans, while its own
`SpanContext.is_valid` independently reports five invalid and two valid
contexts. This is a controlled extension fault; it does not claim the default
SDK generator produces invalid IDs or describe an observed production incident.
No model or external telemetry endpoint is involved.

The [capture oracle](fixtures/oracle.json) records those validity observations
before serialization. Its raw OTLP request and Google's camelCase/snake_case
JSON outputs retain the exact IDs. The named `scripted-response` token counts
are assigned synthetic control attributes, not measured provider billing.

| Same retained mixed export | Before | Corrected |
| --- | --- | --- |
| Default trace | Invalid all-zero group | SDK-valid trace |
| Default retained spans / input tokens | 4 / 4,000 | 2 / 20 |
| Explicit SDK-valid trace spans / input tokens | 3 / 1,020 | 2 / 20 |
| Inventory warnings | None | Five invalid contexts |
| Comparison against the valid control | +50% calls; +5,000% input tokens | Refused: incomplete inventory |
| Standalone invalid-only files | Accepted as traces | Refused: no valid spans |

[Before](results/before.json) and [after](results/after.json) retain 18 real
parser/CLI cases across the three carriers. Fifteen disagree with SDK validity
before and none afterward; the three complete valid controls are unchanged.
The source correction also leaves all [23 existing example/fixture outcomes](results/corpus.json)
identical, covering 28 trace selections and 131 spans.

Complete zero values now normalize as unavailable identities in hexadecimal,
canonical standard/URL-safe Base64 and Jaeger's complete 64-bit trace form.
Spans lacking a usable identity are skipped with scoped inventory warnings;
an invalid trace ID cannot establish warning scope, so that uncertainty remains
visible to the retained trace. No missing call count, outcome or replacement
identity is inferred. An invalid-only file refuses rather than displaying an
empty successful report.

All-zero parent IDs cannot resolve to an imported zero-ID span. They remain
unknown ancestry with a warning, and invalid links retain an omission count.
Logs already treated zero trace context as absent; that behavior is preserved.
Short opaque legacy labels retain their existing compatibility policy; accepting
such a label is not a claim of OTLP conformance or complete ID validation.

```sh
uv run studies/zero-identities/capture.py --out /tmp/new-zero-controls
npm run build
node studies/zero-identities/replay.mjs --out /tmp/zero-after.json --verify
```

Use `--compiled BASELINE/dist-cli` to observe the old behavior. A recapture
changes clocks; the declared IDs are intentionally fixed. The two existing
performance controls now generate nonzero IDs so their stated populations are
valid. Their deadlines and population-size assertions remain unchanged.

Lint, types, all 596 unit checks and all 32 CLI integrations pass. Source and
local checks do not alone establish a public demo or registry release.

The [local browser receipt](results/browser.json) retains 14 passing cases.
Both engines import each carrier while offline at desktop and phone widths,
retain only the two valid identities, download five inventory warnings and an
incomplete cost report, and preserve the inspected trace after comparison
refusal. Invalid-only replacements also refuse without replacing the valid
trace. Four screenshots retain the actual UI; no new controls were added.

A fresh archive of `1b0765f` repeats lint, types, all 596 unit checks, build
and all 32 CLI integrations on Node 24.21.0. The separate local package repeats
all 18 native identity/CLI cases without a disagreement on
[Node 20.0.0](results/installed-node20.json) and
[Node 24.21.0](results/installed-node24.json). All
[39 compiled files](results/package.json) match the clean build. The four local
browser screenshots were opened and inspected; they retain unknown full totals
and the known retained subtotal rather than displaying the invalid calls.
