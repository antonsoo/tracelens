# Incomplete imports must not manufacture a run improvement

At source `11cf372`, removing the first model call's end timestamp from the
captured Strands operation-details trace makes the actual CLI comparison
report **175 to 104 input tokens (-40.6%)** and **two to one chat calls (-50%)**
on their shared operation path. Its warning says the span was skipped, while
the numeric deltas still describe an improvement. The underlying capture has
not changed its work; the constructed candidate has lost importable evidence.

The correction marks parser warnings that affect span inventory, timing or
ancestry with a structured `comparisonIssue`. Quantitative comparisons reject
either affected side before producing a report. The existing browser validates
before committing a candidate or trace selection, so rejection retains the
previous complete comparison. Individual partial traces remain inspectable
with their original warnings; the guard does not recover discarded contents.

The gate covers missing/invalid identifiers and timestamps, non-object records,
unreadable span containers, truncated JSONL tails, reversed intervals clamped
for display, and unresolved parents. Known losses in another selected-away
trace do not block the current trace. Unknown container membership cannot
establish which trace was unaffected. Complete related files resolve parents
before the comparison. Explicit zero durations remain observations. Warnings
about optional events/links and other exported signals do not themselves block
the comparison. Direct `ParsedTrace` callers also need resolved parents and
internally consistent intervals.

This is an import-evidence gate, not certification of complete instrumentation.
Entirely omitted spans with no surviving references or import warnings remain
undetectable. Sampling, missing attributes, clock agreement across services,
cost assumptions and the existing self-time clipping rules still limit what
the trace establishes. Inspect partial traces individually; provide the
complete related exports and correct invalid source timestamps for comparison.

## Actual core and CLI replay

```sh
npm ci
npm run build
node studies/comparison-coverage/replay.mjs --out /tmp/comparison-coverage.json
```

[`cases.mjs`](cases.mjs) constructs 37 cases: eight unchanged SDK captures,
labelled damage variants of the Strands export and repository Jaeger example,
scoped other-trace cases, zero durations, optional warnings and a related-file
recovery. Each runs through the exported core API and the actual CLI's JSON
and terminal comparison workflows. The baseline has **60 disagreements in
111 workflows**; the correction has none. The existing rejection of malformed
Jaeger trace containers is retained rather than relaxed.

To reproduce the baseline, separately build `git archive 11cf372`, pass its
`dist-cli/cli/index.js` with `--cli`, and add `--observe-only`. `--node` selects
the CLI runtime. Running the driver itself with the selected Node also tests
the core on that runtime. Input digests, complete reports, stdout/stderr and
exit codes are captured. Scratch inputs remain in a temporary directory.

The [SDK fixture provenance](../../tests/fixtures/census/README.md) identifies
the instrumentations and captured provider-response replays. No model,
collector, provider or Jaeger server is called by this study. All damage
variants are explicitly constructed, not observed production incidents.
