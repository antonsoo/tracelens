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
