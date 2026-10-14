# A second field spelling can hide the calls

At baseline `83a4bac`, TraceLens selected `resourceSpans ?? resource_spans`
and made the same choice for several nested fields. The viewer accepts both
spellings individually, but a file containing both could lose evidence
without a diagnostic.

The native Strands census fixture has six spans, including two model calls
with 175 input tokens and 26 output tokens. A derived control puts its agent
root in `resourceSpans` and the other five unchanged resources in
`resource_spans`. Baseline successfully displays one span, no model usage
and no warnings. No span, timestamp, token or response was edited; only the
resource arrays were partitioned under competing keys. This is damage to a
native capture, not a claim that Strands emits duplicate field spellings.

The corrected parser rejects competing non-null trace fields before
normalization. It checks resource and scope collections, span identity,
parent/timing/omission fields, and event/link aliases. JSONL batches are
checked before their resources are flattened. Even equal declarations are
refused; the caller should keep one spelling. A single spelling and an
unset/null companion remain supported.

| Workflow | Baseline | Corrected source |
| --- | --- | --- |
| Unmodified native Strands export | Six spans, two model calls | Unchanged |
| Partitioned resource fields | One span; no model usage or warnings | Rejects both resource spellings |
| Same ambiguity in a JSONL batch | Silently drops the second collection | Rejects the named batch |
| Competing scope, ID, time, omission, event or link fields | Selects one declaration | Rejects before analysis |
| Ambiguous log time/name/omission fields | Selects camelCase values | Retains both raw fields, warns, normalized value unavailable |
| Browser candidate replacement | Imports a changed/incomplete candidate | Rejects; prior comparison download unchanged |

## Reproduce

```bash
npm ci
npm run build
node studies/field-aliases/replay.mjs --out /tmp/field-aliases-after.json
```

To inspect the baseline without changing the checkout, export `83a4bac`
into a separate directory, install/build it, then pass its
`dist-cli/cli/index.js` to the replay's `--cli` option and add
`--observe-only`. The CLI study preserves exit codes, exact stdout/stderr
and input hashes for 28 workflows. The temporary path prefix is normalized.
[Before](results/before.json) has 18 disagreements with the corrected
contract; [after](results/after.json) has zero. Eight inputs are unmodified
native census fixtures; the remaining cases are explicitly derived controls.

The browser replay accepts a built `dist/` directory and output directory:

```bash
node studies/field-aliases/browser.mjs dist /tmp/field-aliases-browser
```

[Baseline browser records](results/browser-before/browser.json) and
[corrected records](results/browser-after/browser.json) cover two candidate
replacements in Chromium/Firefox at 1440 and 375 pixels, offline. Baseline
accepts both; corrected imports reject both and retain the earlier complete
comparison exactly, checked through actual JSON downloads. Both recover by
loading the original native file. Served asset bytes are compared with the
tested build; records retain browser versions, hashes, screenshots, overflow,
CSP violations and page errors.

## Installed and clean-checkout verification

The [verification receipt](results/verification.json) identifies the parser
commit and the fresh archive used for installation, lint, type checks,
425 unit checks, both builds, 32 CLI checks and 132 Chromium/Firefox browser
checks. The additional existing browser audit passed too. All 32 files in the
packed `0.3.3` archive match that clean build and the installed package;
[the inventory](results/package-files.json) retains their hashes. This is a
local package build, not a new registry release.

The same 28 CLI workflows passed from that installation on
[Node 26.7.0](results/installed-current.json) and
[Node 20.20.2](results/installed-floor.json), the supported major-version
floor. The browser study's served assets also match the final clean build.
All eight before/after screenshots were inspected, including the phone-width
error message and the retained six-span comparison.

The first full browser run had 131 passes and a Firefox page crash in an
existing rapid trace-switch test. The
[original log](results/checks/clean-browser.txt) is retained. Running that
unchanged test against the baseline passed once and then six times; the crash
was not reproduced there. Its old harness delayed *sending* parser work and
later posted it to an already terminated worker. The revised test queues an
actual parser response before cancellation and delivers it after
supersession, checking termination, ignored stale results and picker focus.
That scenario passed eight repetitions across both engines, and the subsequent
fresh full run passed all 132 cases. This is a test correction, not evidence
that a Firefox engine crash has been fixed. Normalized logs for the initial,
baseline, repeated and final checks are in [results/checks](results/checks/).

## Why refuse rather than pick a field?

Canonical [OTLP JSON](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)
uses camelCase field names. TraceLens also accepts ordinary Protobuf-style
exports and snake_case input. The
[ProtoJSON duplicate-field rules](https://protobuf.dev/programming-guides/json/#duplicate-keys)
describe last-wins semantics when original order is available, otherwise
failure rather than arbitrary selection. The viewer deliberately refuses
competing trace declarations so the evidence shown does not depend on which
spelling happens to be preferred. It does not merge the declarations.

Ambiguous log scalar values are kept under the original `raw` record with
warnings. No event name, timestamp or dropped-attribute count is selected.
Log identity conflicts remain unmatched under the existing policy; logs do
not create calls, duration or charges.

This guard covers recognized alternate trace fields, not every possible JSON
integrity problem. Literal duplicate JSON keys still follow `JSON.parse`'s
last-key behavior. Unrecognized fields and application payload properties
are outside this alias check. The imported data is not authenticated, and
passing this check cannot establish complete instrumentation.

The source correction has no corresponding npm release or verified hosted
deployment. The web build is `npm run build:web`, with output in `dist/`; the
CLI build is `npm run build:cli`, with output in `dist-cli/`.
