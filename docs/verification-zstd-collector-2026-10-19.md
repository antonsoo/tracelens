# Compressed Collector imports: source and installed verification

Source `4289ac8` opens Zstandard-compressed OTLP JSON and explicitly declared
protobuf, including both Collector carriers. Source `ffcd74b` adds the exact
5,001-span native protobuf capture to the demo and its direct query link.
The [producer study](../studies/zstd-collector/README.md) retains actual
Collector output, SDK clocks/attributes and independent Google/Python decoding.
It distinguishes native telemetry from deliberately damaged codec controls.

A fresh `git archive ffcd74b` was installed with Node 24.21.0 / npm 11.19.0,
without copying dependencies or compiled files. Ordinary builds consume the
committed reference decoder; they require no C toolchain or decoder download.

| Check | Observed result |
| --- | --- |
| Fresh installation | 156 packages; zero reported audit vulnerabilities |
| Lint, strict types, production build | Passed |
| Unit suite | 646 checks in 41 files, in default and German locales, with two workers |
| CLI integration | 32 passed |
| Final production browser run | 180 Chromium/Firefox workflows passed; loading-wait harness from `4ddc382` |
| Clean versus working build | All 39 static and 42 CLI files byte-identical across Node 24/26 |
| Locally packed source | 50 files; 137,502-byte tarball, installed into a new consumer without lifecycle scripts |
| Installed artifact | All 50 installed files match the tar archive exactly |
| Minimum supported runtime | Installed package runs on Node 20.0.0; all eight native files and eight complete trace comparisons agree |
| Actual installed CLI | Four paired log reports match uncompressed controls; 17 malformed inputs exit 1 with empty stdout |
| Reference codec controls on installed Node 20 | 399 byte variants and 6,992 mutations agree within explicit resource/dictionary limits |
| Larger installed workload | All 5,001 original SDK IDs, clocks and attributes agree |

The [verification receipt](../studies/zstd-collector/verification.json) retains
every static/CLI hash and the separate [installed artifact manifest](../studies/zstd-collector/artifact.json).
[Installed native replay](../studies/zstd-collector/installed/replay.json),
[actual CLI](../studies/zstd-collector/installed/cli.json) and
[codec replay](../studies/zstd-collector/installed/codec.json) identify the tested surface.
The packed source still carries package version 0.3.3; its integrity differs
from the separately observed npm 0.3.3 artifact. No registry release was made.

Commands from the clean archive:

```sh
npm ci
npm run lint
npm run typecheck
npm test -- --maxWorkers=2
LC_ALL=de_DE.UTF-8 LANG=de_DE.UTF-8 npm test -- --maxWorkers=2
npm run build
npm run test:cli
npm run test:browser
npm pack --ignore-scripts --pack-destination OUTPUT_DIR --json
```

A fresh consumer installed that tarball with `npm install --ignore-scripts`.
The study's `replay.mjs`, `replay-codec.mjs` and `measure-load.mjs` then loaded
its actual compiled core. `verify-cli.mjs` additionally launches the installed
executable and checks complete paired reports and empty stdout on malformed
inputs. The minimum-runtime CI command uses `summary`'s text interface;
`--json` belongs to the report commands.

One unrestricted-worker unit run exceeded the existing one-second plain-JSON
20,000-span timing gate on this shared host (1.155 s). The clean two-worker
runs passed. No product timing gate was relaxed. An initial final browser run
passed 179 checks and timed out polling repeated downloads in an older OTLP
retry check; its final visible candidate had already updated correctly. That
harness now waits for the loading notice to disappear before exporting once.
The final complete browser run passes all 180 checks, with that waiting rule
and unchanged production bytes.

The independent browser study has sixteen first-import-offline trace/log
workflows, four larger native imports and four actual sample entry workflows.
It retains span downloads, source int64 values and clocks, trace/link navigation,
comparison reports, damaged-replacement recovery and aggregate decoded-text
refusals. Desktop dark and 375px light screenshots were opened and inspected.
The added home-page sample wraps inside the existing design; all focused
accessibility scans have zero violations. Viewport width does not simulate
a phone processor. Observed timings and kernel memory readings are described
in the study without production latency or whole-process memory guarantees.

The static decoder is libzstd 1.5.7, built twice from pinned upstream source
and WASI SDK 27.0 with identical 72,826-byte output. It has no host imports
and a 128 MiB WebAssembly linear-memory maximum. Linked notices ship in the
package and static site. Frame extents/output/window budgets precede decoding;
the reference codec validates bitstreams and optional checksums. Complete
omitted trailing frames cannot be inferred. Existing JSONL partial-line
warnings and protobuf wire limits retain their own meanings.

## Public source and canonical site

Source `d1bceb6` is pushed. Pages `daec025` appends to `dc964f8` and publishes
the clean `dist/` tree. All [39 canonical files and both entry checks](../studies/zstd-collector/hosted-bytes.json)
match by SHA-256. All [26 previous deployed assets](../studies/zstd-collector/preserved-assets-hosted.json)
remain byte-identical on the public origin; no orphan history or force push
was used.

Actual public-browser replays pass [sixteen trace/log workflows](../studies/zstd-collector/hosted/browser.json),
[four larger native imports](../studies/zstd-collector/hosted/load-browser.json),
and [four sample entry workflows](../studies/zstd-collector/hosted/sample-browser.json).
The first twenty disconnect before their first file import. Sample entry
workflows fetch the original compressed capture, then disconnect before
searching and downloading the last SDK tool span. All retain original clocks
and attributes, without page/CSP errors, late requests or document overflow.
All [seven public screenshots](../studies/zstd-collector/hosted-screenshots.json)
were opened and inspected and match the reviewed local PNGs byte for byte.

The [publication receipt](../studies/zstd-collector/publication.json) binds these
reports to the canonical URL and deployed/source revisions. npm 0.3.3 remains
the separately observed registry artifact. No package or tag was released.
