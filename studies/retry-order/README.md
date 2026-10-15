# Export order cannot establish a retry

Two same-name tool calls share a start timestamp and parent. One fails and
one succeeds. A later call follows both. TraceLens previously reported either
0 or 1 possible retry depending only on which peer appeared last in the file.
The source now retains the ambiguous preceding outcome as unknown.

This is an **unreleased local source change**. No npm publication or hosted
deployment was made.

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
