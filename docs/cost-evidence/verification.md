# Token cost verification

**Publication update:** the reviewed source and static site were pushed later
on 2026-10-09. See [the new verification record](../verification-publish-2026-10-09.md).
The original local verification record follows; no npm release was made.

Verified locally on 2026-10-09 UTC (2026-10-08 in Los Angeles). Baseline:
`6ada30f`. Implementation: `e957f8d`, `6a77a66`, `aa41319`, `0f89841`.
These changes have not been pushed, deployed or published.

## Observed change

The baseline priced a recorded `gpt-5-nano-2025-08-07` response using the
base `gpt-5` rate. With 6,047 input tokens (2,944 cached) and 1,623 output
tokens (including 1,408 reasoning), it showed $0.02047675. The corrected
token estimate is $0.00081907 at the cited nano rates: a 25x overstatement.

The product change includes whole-model/provider matching, dated-snapshot
controls, explicit unpriced reasons, embedding/reranker coverage, and
per-call receipts in the browser, CLI and comparison exports. Browser
price exports can reproduce the same decisions in the CLI. Wrapper usage
is inspectable without being added to the total twice.

## Reproduction evidence

| Artifact | What it establishes |
|---|---|
| [before.json](before.json) | Actual baseline output for the Vercel, OpenLLMetry and embedding fixtures |
| [replay.json](replay.json) | Fresh SDK export, pinned fixture checksum and dependencies, one loopback request and zero provider requests |
| [after.json](after.json) | Full CLI receipt for that fresh export |
| [decimal-check.json](decimal-check.json) | Independent raw-response arithmetic at explicitly quoted nano rates |
| [cli.txt](cli.txt) | Unedited terminal output used for the screenshot |
| [package.json](package.json) | Fresh tarball installation; the installed binary's full receipt matched on Node 26.7.0 and Node 20.0.0 |
| [performance.json](performance.json) | One measured 10,000-call synthetic trace; all calls retained and charged |

The [replay guide](../../scripts/cost-replay/README.md) contains the complete
commands and pinned upstream URL. `check.py` reads the provider response
directly and uses Python Decimal, independently of the TraceLens price
matcher. The fresh capture is another SDK run over the same upstream
response, not a new model inference. A second clean replay on Node 20.0.0
also produced one priced call, one excluded wrapper and the same decimal
total. Its IDs and timestamps differed, as expected.

## Local checks

From the repository root, starting with `npm ci`:

| Command | Result |
|---|---|
| `npm ci` | Clean dependency installation; zero reported vulnerabilities |
| `npm run lint` | Passed; repeated after adding the standalone measurement script |
| `npm run typecheck` | Both TypeScript configurations passed |
| `npm test` | 231 checks passed in 20 files |
| `npm run build` | Static site in `dist/`; executable in `dist-cli/` |
| `npm run test:cli` | 29 executable checks passed |
| `npm run test:browser` | Legacy interaction runner and all 84 then-present Chromium/Firefox scenarios passed |
| `npm run build:web` then `npx playwright test tests/browser/cost.spec.mjs` | All 14 cost scenarios passed after narrowing the phone table and adding comparison receipt checks |
| `node scripts/cost-replay/measure.mjs` | 10,000 calls retained; parse 196.669 ms, ledger 75.085 ms, JSON export 31.079 ms on the recorded machine |

The browser checks exercise actual file imports, source-span navigation,
saved-price export and CLI parity, offline downloads, a 1,001-call ledger's
last page, an executable-looking source URL, keyboard navigation, and axe
audits in both themes at 320px. Comparison checks download each run's ledger
and inspect the matching source call. No page exceptions, external requests
or Content Security Policy violations were observed in those cost scenarios.

The full-suite run preceded the final small table-width adjustment and two
new comparison scenarios. The subsequent targeted run covers those changes;
the current suite contains 86 browser scenarios. Timing measurements above
are single local observations, not general performance guarantees.

To repeat the package check without publishing:

```bash
mkdir -p /tmp/tracelens-pack
npm pack --pack-destination /tmp/tracelens-pack
npm install --ignore-scripts --prefix /tmp/tracelens-pack/consumer /tmp/tracelens-pack/antonsoloviev-tracelens-0.3.3.tgz
/tmp/tracelens-pack/consumer/node_modules/.bin/tracelens cost examples/cost-nano-stream.json --json
```

The local tarball retains the existing `0.3.3` version label; it is not the
published package. It has no runtime npm dependencies. Node 20 verification
used the actual `node-linux-x64@20.0.0` binary and checked its version before
running the installed CLI; an `npm exec` invocation on this machine had
resolved the ambient Node 26 binary instead.

## Visual inspection

All four screenshots were captured from the built app or actual CLI output,
then opened and inspected. The browser uses the existing IBM Plex type and
trace-kind colors. The calculation table fits the 375px phone view without
horizontal clipping; the narrower 320px table remains keyboard-scrollable.
The phone detail pane is scrolled to the calculation in these captures.

| View | Screenshot |
|---|---|
| Chromium, dark, 1440px | [Desktop receipt](../assets/cost-receipt-desktop.png) |
| Chromium, light, 375px | [Phone receipt](../assets/cost-receipt-mobile-light.png) |
| Firefox, dark, 375px | [Phone receipt](../assets/cost-receipt-mobile-dark.png) |
| CLI | [Complete receipt](../assets/cost-terminal.png) |

## Limits and repository metadata

Only the nano rate was freshly checked for this change; other defaults
retain their earlier source dates. Token receipts do not model service tiers,
historical prices, multimodal tariffs or tool fees. The recorded response's
code-interpreter fee is excluded. Overlapping instrumentation is not
automatically deduplicated. This verifies a replayed response and the
application workflow, not a provider invoice or live model latency.

The old instrumentation census cost scorer repeated the bad matcher. Its
documentation now identifies the historical cost metric's limitations; the
full census was not rerun and no new corpus-wide accuracy figure is claimed.

Suggested repository description: **Inspect LLM trace timing and token costs
locally, with per-call calculation receipts.**

Suggested topics: `opentelemetry`, `otlp`, `llm-observability`, `agent-tracing`,
`trace-viewer`, `cost-estimation`, `local-first`.
