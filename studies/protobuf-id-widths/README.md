# Native byte identities have exact lengths

The native importer at `270d97b` decodes arbitrary nonempty byte lengths in
trace, span, parent, link and log identity fields. Its JSON compatibility layer
can then interpret those Base64 strings as opaque legacy labels. A fifteen-byte
trace ID becomes an invented trace identity instead of an invalid OTLP input.

The generic Protobuf `bytes` type accepts those widths. OTLP identities impose
additional constraints: trace IDs occupy sixteen bytes and span IDs eight.
The [native Collector receipt](fixtures/oracle.json) checks this distinction
against the actual core Collector **0.163.1** on loopback, using the same pinned
binary as the native import study. Its HTTP receiver refuses all twelve
wrong-width inputs with 400, while accepting all four controls with 200.

| Declared native field | Constructed nonempty widths | Collector | Importer before | Corrected |
| --- | --- | --- | --- | --- |
| Span trace_id | 15, 17 bytes | Refused | Accepted | Refused |
| Span span_id | 7, 9 bytes | Refused | Accepted | Refused |
| Span parent_span_id | 7, 9 bytes | Refused | Accepted | Refused |
| Link trace_id / span_id | 15 / 9 bytes | Refused | Accepted | Refused |
| LogRecord trace_id | 15, 17 bytes | Refused | Accepted | Refused |
| LogRecord span_id | 7, 9 bytes | Refused | Accepted | Refused |
| Unchanged native trace and log requests | Original valid widths | Accepted | Accepted | Accepted |
| Empty parent / absent log context | Zero bytes, absent optional context | Accepted | Accepted | Accepted |

The sixteen retained inputs begin with [actual SDK exports](../otlp-binary/README.md)
and the [declared valid-ID control](../zero-identities/README.md). Alterations
are explicitly labelled in the oracle; these are constructed protocol controls,
not a claim that an unmodified SDK emits wrong-width IDs. Google Protobuf
independently round-trips all sixteen as valid wire messages. The Collector's
semantic ID checks reject the twelve altered widths. This is not a report of
an upstream Protobuf decoding defect or security advisory.

The Collector's [trace output](fixtures/collector/traces.jsonl) contains only
the two accepted trace requests, four spans in total. Its
[log output](fixtures/collector/logs.jsonl) contains only the two accepted log
requests. The rejected requests do not contribute partially exported records.
The oracle records each response as Base64, preserving the actual Protobuf
error bytes without substituting invented error text.

[Before](results/before.json) and [after](results/after.json) check all sixteen
library and real CLI outcomes: twelve disagree with the Collector before and
none after. The explicit binary decoder now validates identity widths before
building its JSON view. Any wrong-width identity rejects the whole file,
including a bad later batch after an otherwise valid first batch. Optional
empty context retains its existing behavior; complete all-zero values continue
through the separate incomplete-identity policy. Arbitrary attribute bytes and
unknown wire fields are not mistaken for identity fields.

No inferred byte width is imposed on opaque legacy JSON labels. A caller's
declared binary signal supplies the context to interpret native bytes exactly.
This check does not claim general validation of every OTLP semantic field.

```sh
uv run studies/protobuf-id-widths/capture.py --collector /path/to/otelcol --out /tmp/id-width-controls
npm run build
node studies/protobuf-id-widths/replay.mjs --out /tmp/id-width-after.json --verify
```

The capture verifies the Collector binary hash against the earlier native
receipt before executing it. No external telemetry endpoint, model, registry
release or real account is involved.

All 614 unit checks pass, including eighteen focused width/framing/legacy
controls. The [existing JSON corpus](results/corpus.json) remains identical:
23 outcomes, 28 trace selections and 131 spans. The
[native import replay](results/native-parity.json) still preserves every
original SDK observation across raw and framed carriers, all 24 CLI operations
and all four comparisons against native Collector JSON.

The [local production browser run](results/browser.json) passes all 26 cases:
the ten original native import workflows, fourteen zero-identity workflows and
two atomic wrong-width replacement/recovery checks. A rejected trace file or
log in a multi-file group leaves the existing comparison byte-identical; a
valid retry clears the error. Both Chromium and Firefox exercise the real
worker with the network disconnected after page load.

The clean archive `fd4704d` passes a fresh install, lint, types, all 614 unit
checks, the production build and all 32 CLI integrations on Node 24.21.0.
All [39 compiled files](results/package.json) match a separate non-editable
local package installation. Its real CLI repeats all sixteen width controls
without disagreement on [Node 20.0.0](results/installed-node20.json) and
[Node 24.21.0](results/installed-node24.json). No npm registry release is made.

## Public delivery

Source `fd4704d` and verification `f306bec` were pushed to main. Deployment
`cffc0db` includes both the zero-identity and exact-byte-width corrections,
while retaining prior hashed assets. All 36 files in the clean production build
match their [canonical public bytes](results/hosted-bytes.json). The
[public browser receipt](results/hosted-browser.json) repeats all 26 workflows
against `https://antonsoo.github.io/tracelens/`, including offline import,
actual evidence downloads, invalid-context comparison refusal, atomic
wrong-width rejection and successful retry in both engines.

These checks establish the captured source/local-package/public-demo states
separately. Package metadata remains 0.3.3; no npm registry release is included.
