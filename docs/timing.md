# Where did the elapsed time go?

This feature is in the source checkout and is not in the published 0.3.3 package.
The [verification record](verification-timing-2026-10-07.md) includes captured
results, screenshots and the larger-input check.

An agent run can contain seven seconds of work and finish in six seconds.
Adding call durations does not reveal how much of the work happened together.
TraceLens now accounts for the recorded timeline and connects every interval
to the spans that cover it.

```sh
npm ci
npm run build
node dist-cli/cli/index.js timing examples/comparison-baseline.json
node dist-cli/cli/index.js timing examples/comparison-baseline.json --json
node dist-cli/cli/index.js compare examples/timing-parallel.json examples/timing-sequential.json
```

The hand-authored comparison makes the arithmetic easy to verify:

| Term | Baseline | Candidate | Change |
| --- | ---: | ---: | ---: |
| Summed self time | 7.00 s | 9.60 s | +2.60 s |
| Subtract overlap excess | 0.80 s | 0 s | -0.80 s |
| Add uncovered time | 0 s | 0 s | 0 s |
| Elapsed time | 6.20 s | 9.60 s | +3.40 s |

The candidate's elapsed time grew by 2.60 seconds of additional recorded work
plus 0.80 seconds from the loss of overlap. This is an accounting identity;
it does not establish which code change caused either difference.

## Inspect it in the browser

Choose **Parallel vs sequential (local capture)** on the landing screen. This
pair comes from seven actual SDK spans per run, including three successful
requests to a controlled local HTTP server. The server's delays are deliberate;
no model, credentials or production data are involved. The
[capture script](../scripts/capture-timing.py) can reproduce the experiment.

1. Open **Baseline elapsed-time breakdown** and **Candidate elapsed-time
   breakdown**. The counts show three concurrent self-time spans versus one.
2. Select an overlap interval. Its exact offset and duration appear with every
   active span; clicking a name opens the original span in the waterfall.
3. Return to the comparison, change the interval filter or swap the runs.
   Evidence remains attached to its source trace. Pricing does not affect timing.
4. Download timing JSON for every interval, or the selected interval's complete
   span-ID list. The comparison JSON includes both timing reports.

There are ten intervals and twenty active spans per UI page, with direct page
selection. An interval can cover thousands of spans without adding thousands
of buttons to the page. The selected interval's download retains all IDs.

## What is counted

[OpenTelemetry spans](https://opentelemetry.io/docs/specs/otel/trace/api/#span)
record the beginning and end of operations. TraceLens uses the parsed start and
end timestamps, after the parser's documented recovery and warnings.

First, each span loses the union of its direct children's intervals, clipped
to its own bounds. The pieces left are its **self time**. A parent waiting for
one child therefore does not become two concurrent operations. A child running
beyond its parent retains its own time outside the parent. All intervals are
half-open: a call ending at exactly another's start does not overlap it.

The resulting pieces partition the trace's earliest-start/latest-end envelope:

| Active self-time spans | Elapsed-time bucket |
| ---: | --- |
| 0 | No recorded span |
| 1, classified LLM | LLM alone |
| 1, classified tool | Tool alone |
| 1, another kind | Other alone |
| 2 or more | Overlapping work |

These five buckets sum exactly to elapsed time. A three-way overlap lasting
one second contributes one second to **overlapping work**, but two seconds to
**overlap excess**. Summed self time counts all three span-seconds. Thus:

```text
elapsed = summed self time - overlap excess + uncovered time
```

The algorithm subtracts child unions and sweeps timestamp boundaries. It uses
integer nanoseconds, O(n log n) time and O(n) stored evidence; full sets of
concurrent IDs are resolved only for a selected interval. It does not sample
the timeline into approximate time bins.

## JSON and scope

`tracelens timing --json` exports `schemaVersion: 1` and
`format: "tracelens-timing"`. Start/end, offsets, durations and totals are
decimal nanosecond strings, preserving large timestamps and sub-millisecond
differences. Displayed milliseconds are rounded. `bucketsNs`, `summedSelfNs`,
`overlapExcessNs` and `peakConcurrency` retain the complete calculation.
`intervals` contains every interval where the active set changes. Each stores
at most eight example `spanIds` and an explicit `omittedSpanCount`, preventing
quadratic exports under heavy concurrency. The browser can resolve all active
IDs from the original trace; its selected-interval export sets omissions to zero.

Timing exports contain IDs, timestamps and parser warnings. They do not copy
prompts, completions or tool payloads. The ordinary span download does contain
those captured fields. Existing comparison JSON gains an additive `timing`
object with `baseline` and `candidate` reports; existing metrics keep their meaning.

No recorded span does not prove the process was idle: telemetry can be missing.
Likewise, other self time can include orchestration, waits and uninstrumented
operations; it is not measured CPU time. Clocks from different machines can be
skewed. Nested instrumentation can describe the same work at different levels.
The calculation uses the supplied hierarchy and timestamps, preserves parser
warnings, and makes no scheduling, speedup or causal critical-path claim.
