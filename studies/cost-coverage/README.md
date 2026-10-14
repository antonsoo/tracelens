# Cost estimates after incomplete imports

A trace can retain priceable calls while losing other span evidence. A full token
estimate requires both priceable retained calls and no observed inventory gap.

The reproduction uses the existing native Strands SDK capture, with explicitly
illustrative user rates of $1 per million input tokens and $2 per million output
tokens. These are accounting controls, not vendor prices, live model requests,
or invoices. The unmodified capture has two calls, 175 input and 26 output tokens:
`(175 + 26 * 2) / 1e6 = $0.000227`. Remove the first call's end timestamp and the
parser skips it. The remaining call has 104 input and 12 output tokens:
`(104 + 12 * 2) / 1e6 = $0.000128`.

Previously the cost JSON set `estimatedCostUsd` to $0.000128 and the terminal and
browser headlines called it an estimate. The parser warning did not qualify that
amount. The corrected report retains `knownCostUsd: 0.000128`, sets
`estimatedCostUsd: null`, and adds `incompleteInput: true`. The CLI and browser
explain that this is a known subtotal from retained spans. The retained priced
call count is one; unpriced calls remain zero. No missing call count is invented.

## Rules and limits

- Structured `span-inventory` parser issues include skipped spans, unreadable
  resource/scope/span containers, and incomplete collector JSONL tails. Known
  trace identities retain their selection scope; unknown identities conservatively
  apply to the selected import.
- A reference to an absent parent is observable missing span evidence, including
  directly constructed core API traces. Importing its related file can resolve it.
- Timing problems and invalid parent *values* alone do not establish a missing
  span. They remain comparison restrictions but do not change valid token charges.
- Dropped/invalid events and optional attribute warnings do not establish missing
  spans. Existing per-call usage validation and unpriced-call handling still apply.
- `incompleteInput` is an optional field present only as `true` for observed
  incomplete inventory. Existing complete-report JSON stays unchanged. Summary
  `totalCostUsd` remains the known subtotal; consult `costReport.estimatedCostUsd`
  before treating it as a full estimate.
- A whole missing leaf that leaves no warning or parent reference is undetectable.
  Complete imports also cannot prove complete instrumentation or actual invoices.
  Unknown inventory does not identify omitted call kinds, models, or charges.

## Reproduce

From an installed source checkout:

```sh
npm ci
npm run build
node studies/cost-coverage/replay.mjs
```

The replay reuses the native SDK census and labelled comparison damage cases.
It runs the core cost API, summary API, actual CLI cost JSON, CLI cost text, and CLI
summary text. `--cli PATH --node PATH --out PATH --observe-only` supports replaying
a separate baseline or packed installation without modifying its source.
`results/before.json` and `results/after.json` retain complete observations.
The replay specifies expected input completeness from the constructed damage,
independently of report output. It does not grade provider price accuracy.

Browser replay accepts two completed production-build directories:

```sh
node studies/cost-coverage/browser.mjs BEFORE_DIST AFTER_DIST OUTPUT_DIRECTORY
```

It loads the native capture and saved illustrative rates, warms fonts and assets,
then takes both browsers offline and stops the local server before subsequent
file imports. Cost JSON and selected-call receipts are real downloads. The
corrected cost exports must equal the CLI/core observations. Re-importing the
complete capture must restore its original estimate and full JSON report.

## Measured verification

On 2026-10-14, baseline `2c88eb6b61370c2f605fe8f388dc170dd3bc376d` was replayed
against implementation `926be7d0b457825c7129c01c727edf10fb0fc2b6` on 14 vCPU WSL2
Linux with 48 GB RAM. The baseline and implementation archive files were compared
byte for byte, including after the implementation's checks.

| Workflow | Cases / runs | Before disagreements | After disagreements |
| --- | ---: | ---: | ---: |
| Core cost/summary and CLI JSON/text | 37 cases, 185 workflows | 85 | 0 |
| Packed CLI, Node 26.7.0 | 185 workflows | - | 0 |
| Packed CLI, exact Node 20.0.0 | 185 workflows | - | 0 |
| Offline Chromium/Firefox, 1440 and 375 px | 80 workflows across both builds | 24 | 0 |

All 100 unaffected API/CLI captures are identical, including ten captures for
already-rejected malformed Jaeger controls. Every retained API charge is unchanged.
The browser checks include real cost-report and selected-call receipt downloads,
restoring the complete capture, accessibility checks, no external/late requests,
no page or policy errors, and no document overflow. Each of eight views served
and browser-loaded the same 24 files, matched to its tested production build.

Fresh Node 24.21.0 verification passed install, lint, strict types, 437 unit tests
in each of the default and German locales, both builds, 32 CLI tests, the existing
browser audit, and 134 Playwright tests. The initial default-concurrency runs hit
unchanged parser/fuzz wall-clock limits; full runs with `npm test -- --maxWorkers=2`
passed both locales without changing an assertion or deadline. The compiled
parser is byte-identical before and after; `results/parser-timing.json` records an
isolated synthetic 20,001-span replay separately from these unit timing failures.

All 588 implementation archive files remained unchanged after checks; all 580
baseline archive files match their pinned source. The 34 web and 29 CLI build
files match between clean Node 24 and working Node 26 builds. All 32 packed files
match the clean build and separate installed consumer byte for byte. The local
0.3.3 tarball is 57,998 bytes, SHA-256
`b53ccc7a4b56a002ea82af6fc824b26ec157a7a9044623cb3da06f3fabee6664`.
`results/verification.json` retains file digests, check commands and log hashes;
installed receipts reference the byte-identical full source observations to avoid
copying them a second time.

These results describe source and a locally packed artifact. No npm release,
version tag, manual deployment or remote CI success is claimed.

## Real browser captures

Each image shows the damaged native import at the illustrative rates. The dollar
amount is unchanged; its coverage and headline are corrected. The mobile ledger
uses its existing internal scrolling area. All eight screenshots were inspected.

| Browser / viewport | Before | After |
| --- | --- | --- |
| Chromium / dark 1440 | [before](../../docs/assets/cost-coverage/before-chromium-1440.png) | [after](../../docs/assets/cost-coverage/after-chromium-1440.png) |
| Chromium / light 375 | [before](../../docs/assets/cost-coverage/before-chromium-375.png) | [after](../../docs/assets/cost-coverage/after-chromium-375.png) |
| Firefox / dark 1440 | [before](../../docs/assets/cost-coverage/before-firefox-1440.png) | [after](../../docs/assets/cost-coverage/after-firefox-1440.png) |
| Firefox / light 375 | [before](../../docs/assets/cost-coverage/before-firefox-375.png) | [after](../../docs/assets/cost-coverage/after-firefox-375.png) |
