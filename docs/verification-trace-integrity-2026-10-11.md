# Trace import evidence, verified 2026-10-11 UTC

Two corrections address trace files that previously appeared more complete or
more precisely timed than their data justified.

| Failure | Corrected behavior | Reproduction |
| --- | --- | --- |
| SDK-reported dropped span attributes, events and event attributes were discarded. An SDK export with all five events dropped had no warning. | Counts survive parsing and downloaded span evidence; scoped warnings appear in browser and CLI reports. | [Actual SDK limit capture](../studies/dropped-evidence/README.md) |
| Missing Jaeger duration became measured zero; failed microsecond conversions sometimes became nanosecond dates. Malformed events were silently lost or fabricated. | Invalid spans/logs are skipped with scoped warnings; retained fields and explicitly measured zeros survive. | [Controlled partial exports](../studies/import-integrity/README.md) |

## Independent evidence and install boundary

The SDK capture uses real OpenTelemetry 1.45.1 limit enforcement and its actual
Protobuf exporter, with controlled IDs, timestamps and event content. Nine
trace/serialization combinations match SDK objects before serialization. The
verifier also runs five actual CLI commands for each combination. The Jaeger
study deliberately damages a checked-in synthetic example; fourteen controls
check conversion, retention and warning behavior. Neither capture represents
production traffic, model accuracy or recovery of missing data.

Source `65d885c` was archived, freshly installed with `npm ci`, linted, type
checked, built with `npm run build`, and checked through 297 core cases and 30
CLI cases. All passed. The built npm tarball was installed in a separate empty
project with install scripts disabled. Its 25 installed code files match the
clean build byte for byte. Both studies pass from that package under Node
20.0.0 and Node 26.7.0. Six actual CLI report commands retain partial-export
warnings, including comparison JSON. The [installed-file/report hashes](trace-integrity-2026-10-11/installed.json)
and individual [Node 20 SDK](trace-integrity-2026-10-11/dropped-node20.json),
[Node 26 SDK](trace-integrity-2026-10-11/dropped-node26.json),
[Node 20 Jaeger](trace-integrity-2026-10-11/integrity-node20.json) and
[Node 26 Jaeger](trace-integrity-2026-10-11/integrity-node26.json) records retain
those outcomes. The tarball still carries the source package's 0.3.3 version;
it is a local build, not the registry's published 0.3.3 artifact.

[Existing-fixture replay](trace-integrity-2026-10-11/corpus.json) preserves all
22 file outcomes, with 27 selected traces and 127 spans. This compares parsed
source data and warnings after excluding only the newly supported omission
fields and their positive warnings. It is not the full instrumentation census.

## Browser investigation

The first full run at `785163c` passed 113/114 cases, losing a Firefox target
during the existing cancellation test. Five isolated repeats passed, and a
second full run passed 114/114. The combined production source `65d885c` passed
115/116, with the same Firefox target crash. These failures are retained in the
check record; they were not skipped or relabeled as successes.

Review found two ineffective assertions in that test: counting `JSON.parse`
on the main thread says nothing about parsing in a worker, and calling the
worker's cleared `onerror` property after cancellation does not deliver a late
error. The test also posted a new file to a terminated native worker. A
[separate minimal probe](../studies/import-integrity/worker-probe.mjs) completed
100 iterations with and without that post in Firefox ([observations](trace-integrity-2026-10-11/worker-probe.json)),
so that operation alone does **not** establish the crash's cause.

`b8468f0` changes the check to hold actual parser replies, verify termination,
and invoke captured success/error callbacks after cancellation or replacement.
It checks that stale replies cannot replace the current file or introduce an
error. Five repeats in each browser passed. This improves the verification;
it is not a claim to have fixed a Firefox engine defect.

The SDK and partial-export browser workflows import local files, switch traces,
go offline, inspect retained events and download complete span/warning evidence.
Six desktop/phone screenshots were opened and inspected. Missing exporter data
and skipped malformed records remain explicitly unavailable.

The final complete local run passes **116/116** cases, with no skips or retries,
using the fresh production build and the exact committed test revision above.
The legacy browser audit also passes. The [check record](trace-integrity-2026-10-11/checks.json)
keeps command results, prior failures, runtime versions and package hashes.

## Public build

The source is pushed. `npm run build` produced `dist/` from `65d885c`, and
`8c72541` deploys those files to the existing `gh-pages` branch. All **33** built
files were fetched from [the public viewer](https://antonsoo.github.io/tracelens/)
and matched byte for byte ([served-file hashes](trace-integrity-2026-10-11/served-files.json)).
The public viewer passes the same **116/116** Chromium/Firefox workflows, plus
the legacy browser audit, with no skips or retries. The hosted test copy changes
only the base URL, first-party origin guard and local-server configuration.
Offline workflows use browser connection emulation after loading the page.

Later documentation commits do not constitute new builds. No npm package or
tag was published; the registry still reports **0.3.3**. Actions is disabled,
so these are local, installed-artifact and hosted observations, not a remote
CI success claim. Unknown exporter loss, uninstrumented spans and the cause of
the earlier Firefox target crashes remain outside the evidence established here.
