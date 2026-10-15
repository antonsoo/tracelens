# Export order cannot establish a retry

Two same-name tool calls share a start timestamp and parent. One fails and
one succeeds. A later call follows both. TraceLens previously reported either
0 or 1 possible retry depending only on which peer appeared last in the file.
The source now retains the ambiguous preceding outcome as unknown.

These package changes remain **unreleased to npm**. The original captures and
verification snapshots are retained below; the [later consolidated checks](../../docs/verification-inspection-2026-10-14.md)
record the clean build, installed runtimes and subsequent publication state.

## Actual SDK spans, controlled schedule

[`capture.py`](capture.py) runs three local dictionary lookups through
OpenTelemetry SDK 1.45.1. The first lookup raises `KeyError`, the other two
succeed, and the SDK records their ERROR/OK statuses. The script explicitly
supplies start/end times to reproduce a timestamp tie. This schedule is
**synthetic**, not measured concurrent execution or a production incident.
It contacts no model, server or collector.

| Call | Start offset | End offset | Actual local outcome |
|---|---:|---:|---|
| Failed peer | 1 ms | 2 ms | ERROR |
| Successful peer | 1 ms | 2 ms | OK |
| Later call | 3 ms | 4 ms | OK |

All three share the parent span, which covers 0-5 ms. The SDK's Protobuf
encoder produces the [retained OTLP JSON](fixtures/native.json); byte IDs
are rendered as hexadecimal for OTLP JSON. The [capture oracle](fixtures/oracle.json)
records package versions, driver/input hashes, original IDs, timestamps and
outcomes independently of the TypeScript parser.

```bash
uv run studies/retry-order/capture.py --output fresh-capture
npm run build
node studies/retry-order/replay.mjs --out replay.json
```

The first command makes a fresh capture with new IDs; the replay uses the
retained capture so the original failure remains inspectable.

## Same spans, different claimed counts

At source baseline `a0af5e4`, the summary remembered the last visited tool
with a given name/parent. Sorting by start time preserved export order among
ties. The later call therefore inherited whichever peer came last:

| Order of the two equal-start peers | Before | After |
|---|---|---|
| ERROR, then OK | 0 possible retries | 0 observed; 1 unknown |
| OK, then ERROR | 1 possible retry | 0 observed; 1 unknown |

Neither order has evidence that one peer started after the other. All six
permutations of the unchanged tool records are retained in
[`results/before.json`](results/before.json) and
[`results/after.json`](results/after.json), including actual terminal output.
The root record and every span field are preserved. Before: all six disagreed
with the explicit-ambiguity expectation; three claimed 0 and three claimed 1.
After: all six agree, with the same one recorded error and no parser warnings.

## Processing timestamp peers together

The implementation groups tools by trace ID, parent ID and tool name, sorts
each group by start time, and processes equal-start calls as a batch. Each
batch consults the immediately preceding distinct-start batch. A new call is
a possible retry only when every predecessor candidate is a completed
failure. Conflicting candidates, or an unreadable preceding outcome, leave
that call's retry status unknown. Uniformly successful or overlapping
predecessors do not count as retries. Parallel later calls see the same
earlier batch, rather than overwriting one another's predecessor.

`retryCount` is the known observed subtotal. `unknownRetryCount` now also
covers ambiguous predecessor evidence. The terminal names unknown preceding
call outcomes; the browser shows **Unknown** with an observed subtotal and
uncertain predecessor count. The original span statuses remain known and
downloadable. No artificial parser warnings or unknown error statuses are
introduced to force the summary state.

Only sorting is superlinear; each predecessor batch is examined once for the
next batch. There is no Cartesian product of candidate predecessors and later
calls. The regression checks a 20,000-tool trace split into two equal-start
batches, along with uniform errors/successes, unreadable outcomes, overlapping
completion, multiple later calls, zero-duration ties and separate tool/parent/
trace identities. It also checks all 24 permutations of the four native spans.

The interpretation remains deliberately limited: sharing a name and parent
does not establish identical intent. These are **possible retries**, not proof
that an application actually retried an operation.

## Production browser evidence

[`browser.mjs`](browser.mjs) serves independently built baseline/current
artifacts and disconnects before the first trace import in every fresh
context. It replays all six unchanged permutations through actual parser
workers in Chromium and Firefox at 1440 px/dark and 375 px/light. Baseline
headers change between 0 and 1. Current headers consistently show Unknown,
0 observed and 1 uncertain predecessor. All views retain four spans and one
known error, and downloaded span evidence retains the failed call's original
ID, status and timestamp.

[Browser receipt](results/browser/browser.json) records all 48 imports,
download hashes, served/loaded asset hashes, and checks for page errors,
external/late requests, CSP violations, accessibility violations and overflow.
The screenshots were visually inspected:

- [Current desktop/Chromium](../../docs/assets/retry-order/after-chromium-1440.png)
  and [phone/Chromium](../../docs/assets/retry-order/after-chromium-375.png).
- [Current desktop/Firefox](../../docs/assets/retry-order/after-firefox-1440.png)
  and [phone/Firefox](../../docs/assets/retry-order/after-firefox-375.png).
- [Baseline desktop](../../docs/assets/retry-order/before-chromium-1440.png)
  and [baseline phone](../../docs/assets/retry-order/before-chromium-375.png).

The fixed-capture replay is also suitable for a separately installed package:
pass its executable's JavaScript path with `--cli`, and optionally `--node`
for another supported runtime.

## Clamping cannot establish completion

A second replay removes the successful timestamp peer from the same native
capture, leaving a failed lookup and a later successful lookup. The valid
capture has one possible retry. Declared damage changes the failed call's end
to one nanosecond before its start. Previously the importer clamped it to zero
duration, discarded the supplied end, and still reported one possible retry.
The warning did not prevent the unsupported inference.

The parser now retains `originalEndTimeUnixNano` beside its drawable interval.
Retry inference treats completion of that failed call as unknown. Its known
ERROR status and the parser warning remain intact. This does not make other
timing aggregates valid: comparisons still reject reversed intervals, and
individual display timings remain clamped as before.

| Predecessor control | Before: observed / unknown | After: observed / unknown |
|---|---:|---:|
| Valid completed ERROR | 1 / 0 | 1 / 0 |
| End-before-start ERROR | 1 / 0 | 0 / 1 |
| Valid zero-duration ERROR | 1 / 0 | 1 / 0 |
| Overlapping ERROR | 0 / 0 | 0 / 0 |
| End-before-start OK | 0 / 0 | 0 / 0 |
| End-before-start unreadable status | 0 / 1 | 0 / 1 |

[`completion.mjs`](completion.mjs) declares every mutation and replays the real
CLI; [before](results/completion-before.json) and
[after](results/completion-after.json) retain inputs, hashes, expected counts,
warnings and terminal output. The unchanged peer-order replay still agrees.

```bash
node studies/retry-order/completion.mjs --out completion.json
node studies/retry-order/browser.mjs BEFORE_DIST dist completion-browser --completion
```

The [completion browser receipt](results/completion-browser/browser.json)
covers a fresh offline import in Chromium and Firefox at 1440 px/dark and
375 px/light for baseline `375a311` and the correction. All eight views retain
three spans and one known error; the corrected header shows Unknown, zero
observed and one uncertain predecessor. Corrected span downloads retain the
supplied reversed end and the clamped display end separately. Served assets
match the tested build; page errors, late/external requests, CSP/accessibility
violations and document overflow are absent. All eight screenshots were
visually inspected, including [desktop](../../docs/assets/retry-order/completion/after-chromium-1440.png)
and [phone](../../docs/assets/retry-order/completion/after-firefox-375.png).

## Original verification snapshot

The default parallel unit run failed the parser's existing one-second
performance assertion and the fuzz test's five-second deadline on this shared
host. The complete 474-test suite then passed with `--maxWorkers=1`, preserving
both assertions and deadlines; all 32 CLI checks passed too. The original
[parallel timing failures](results/checks.log) and
[sequential results](results/checks-sequential.log) are retained. Checkout
paths in those logs are normalized to `<checkout>`.

A fresh archive of `7311fe7` passed lint, type checking, web/CLI builds and
all 32 console checks. Its unit run passed 473/474 tests; the same parser
wall-clock assertion exceeded one second on the baseline too, with identical
parser source bytes. That timing check remains an unresolved qualification;
no threshold was changed. [Baseline timing](results/verification/parser-baseline.log)
and [clean checks](results/verification/clean-checks.log) retain the failures.

The packed npm artifact was installed outside the source checkout. All six
permutations and actual CLI summaries agree with source on Node 20.0.0 and
26.7.0. All 33 package files match the clean build and installed files; all
34 web files match the build inspected in the offline browser replay.
[Package, source and asset hashes](results/verification/receipt.json),
[Node 20 replay](results/verification/installed20.json), and
[Node 26 replay](results/verification/installed26.json).

The broader browser run also exposed a verification race in the existing
attribute-evidence test: its final trace selection was followed immediately
by a click on the old row, before the worker returned the selected trace.
Commit `c70b9ed` waits for the requested trace's row label before opening
attributes; `375a311` also waits for actual parser completion in the attribute
and export-container checks. They change test synchronization, with no
application change. The original broader run passed 132/134 scenarios,
with a Chromium attribute timeout and Firefox container-download timeout.
A fresh archive of `375a311` then passed all four affected workflows in both
engines with the original assertions and timeouts. Its built application files
are byte-identical to the inspected/installed implementation. The remaining
130 scenarios were not repeated after those test-only edits.
[Original broad run](results/verification/clean-browser-initial.log) and
[corrected four-case run](results/verification/targeted-browser.log).

The build command is `npm run build`, producing `dist/` for the static browser
app and `dist-cli/` for the npm CLI. At the original capture both were local
artifacts for review. The [consolidated verification](../../docs/verification-inspection-2026-10-14.md)
records the later source push and public browser deployment; npm remains unreleased.
