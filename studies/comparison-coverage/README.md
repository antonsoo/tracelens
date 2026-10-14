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
The exported core raises `TraceComparisonError` for these coverage refusals;
parser failures remain separately recognizable as `TraceParseError`.

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

## Installed artifact and real browser verification

| Verified workflow | Result |
|---|---|
| Core API and actual CLI | [Baseline](results/before.json): 60 of 111 disagreements; [corrected source](results/after.json): zero |
| Ordinary controls | All 45 complete core/JSON/terminal captures identical |
| Fresh Node 24.21.0 archive | Lint, strict types, 431 unit checks in each default/German locale, both builds, 32 CLI checks, the additional browser audit and 132 production-browser checks pass |
| Installed local 0.3.3 archive | [Node 26.7.0](results/installed-current.json) and exact [Node 20.0.0](results/installed-floor.json): 111 workflows each, complete captures match source |
| Artifact identity | All 561 baseline and 565 implementation archived files match source; all 34 web and 29 CLI build files match Node 24/26; all 32 packed files match the clean build and install |
| Actual offline production app | [64 replacement workflows](results/browser.json), Chromium/Firefox at 1440/375 px: 32 baseline disagreements, zero corrected; rejection keeps the complete previous downloaded report exactly |
| Recovery and loaded bytes | All eight views recover with the unchanged native input; all 24 served/browser-loaded files match each tested build; server shuts down before the replacement workflows |
| Visual and accessibility review | All eight screenshots inspected; no overflow, script/CSP errors, external/late requests or axe findings in the replay |

The [verification receipt](results/verification.json) retains source, input,
build, packed-file, check-log and screenshot hashes. The package was installed
from the local archive; its unchanged `0.3.3` version does not identify a new
npm release. The installed bin and exact-floor summary/tree/links commands also
run successfully. No registry release, tag, manual deployment or remote CI
result is claimed.

```sh
node studies/comparison-coverage/browser.mjs \
  /tmp/tracelens-before/dist /tmp/tracelens-after/dist /tmp/comparison-browser
```

The first full run exposed an exact warning-object assertion and two fuzz
checks that assumed every inspectable parsed trace could be compared. The
fuzzer now distinguishes typed comparison refusals and parse failures while
still rejecting unexpected exceptions. Final fresh checks were rerun. The
first browser-driver attempt started before its target build existed and
failed with `ENOENT`; the final replay uses completed production builds.
Neither observation was presented as a repaired product failure.

These unedited screenshots show the actual missing-end-timestamp workflow.
The baseline accepts five spans and claims 40.6% fewer input tokens. The
corrected screenshot shows rejection and the **retained original six-span
comparison**. Its zero changes belong to that retained complete input; they
are not results for the rejected candidate.

| View | Baseline | Corrected |
|---|---|---|
| Chromium, 1440 px | [Before](../../docs/assets/comparison-coverage/before-chromium-1440.png) | [After](../../docs/assets/comparison-coverage/after-chromium-1440.png) |
| Chromium, 375 px | [Before](../../docs/assets/comparison-coverage/before-chromium-375.png) | [After](../../docs/assets/comparison-coverage/after-chromium-375.png) |
| Firefox, 1440 px | [Before](../../docs/assets/comparison-coverage/before-firefox-1440.png) | [After](../../docs/assets/comparison-coverage/after-firefox-1440.png) |
| Firefox, 375 px | [Before](../../docs/assets/comparison-coverage/before-firefox-375.png) | [After](../../docs/assets/comparison-coverage/after-firefox-375.png) |
