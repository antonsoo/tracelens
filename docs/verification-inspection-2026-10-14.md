# Trace inspection: clean build and installed evidence

This verification covers implementation
[`0c51954276879eb13c763f4523316a062c7c2a2c`](https://github.com/antonsoo/tracelens/commit/0c51954276879eb13c763f4523316a062c7c2a2c).
The subsequent evidence/documentation commits do not change application code.
No npm version or tag was published by this work.

| Reproduced problem | Result | Evidence and limits |
|---|---|---|
| Timestamp peers selected a failed or successful predecessor by file order | All unchanged permutations retain an unknown possible-retry outcome | [Native SDK capture](../studies/retry-order/README.md); a heuristic, not proof of retry intent |
| A clamped failed interval implied known completion and discarded its supplied end | Completion stays unknown; `originalEndTimeUnixNano` retains that end in span downloads | [Declared timing damage and valid zero/overlap/success controls](../studies/retry-order/README.md#clamping-cannot-establish-completion) |
| A skipped model call left its retained token subtotal looking complete | Full browser totals are unknown, with the known subtotal visible | [Native Strands capture](../studies/cost-coverage/README.md#token-headlines-after-a-partial-import); no missing call/token count is invented |
| Large message JSON was decoded repeatedly | Controlled core imports take 28-59% less time on the two tested runtimes | [Samples and equivalence](../studies/message-decoding/README.md); not an arbitrary-trace speed or general memory claim |
| Phone details followed all 6,000 timeline rows, about 150,206 pixels down | The bounded panel puts details 480 pixels from its start at 375 by 800 | [Geometry and keyboard/download replay](../studies/mobile-waterfall/README.md); calculations and evidence are unchanged |

The README now leads with inspection workflows. The
[source-history index](source-history.md) retains the repair narratives and
their original evidence separately.

## Clean archive

A fresh archive of the implementation passed `npm ci`, lint, strict type
checking, `npm test -- --maxWorkers=1`, both builds, CLI checks, browser checks
and `npm pack`. The [clean receipt](verification/inspection-2026-10-14/clean.json)
records every command, exit and elapsed time. All 805 tracked archive files
remained byte-identical through the checks.

The unit run passed **482 tests**, including the existing one-second parser
guard and five-second fuzz deadline. No threshold or deadline was relaxed.
This newer clean run resolves the earlier retry study's clean-build timing
qualification for this capture; its original failure logs remain historical
evidence, not a prediction for every shared-host run.

All **32 CLI checks** passed. The browser run passed the custom interaction/
waterfall audit and **142 Playwright scenarios** in Chromium and Firefox,
including the new first-offline large-message workflows and the updated phone
navigation audit. [Unit log](verification/inspection-2026-10-14/unit.log),
[CLI log](verification/inspection-2026-10-14/cli.log),
[browser log](verification/inspection-2026-10-14/browser.log).
Only the temporary checkout path is normalized to `<checkout>` in retained logs.

## Separately installed package

The locally packed npm tarball was installed outside the source checkout with
install scripts disabled. All **33 tarball files** match that installation.
All 32 non-metadata package files match the clean build/source too; npm's
`package.json` is compared directly between archive and installation.
All **34 web files** match the independently built working artifact inspected
in the browser studies. [File hashes, package digest and byte sizes](verification/inspection-2026-10-14/artifact.json).

Both the complete replay driver and its CLI subprocesses ran under the named
runtime, importing the installed package's core:

| Runtime | Retry permutations | Completion controls | Cost workflows | Fixture files | Large imports |
|---|---:|---:|---:|---:|---:|
| Node 20.0.0 | 6 | 6 | 185 | 54 | 2 |
| Node 26.7.0 | 6 | 6 | 185 | 54 | 2 |

Every replay agrees. The 54 fixture outcomes and the complete large-workload
output hashes equal the measured source results. The installed normalization
module also matches the performance-study bytes. The floor runtime is an
actual Node 20.0.0 binary, not an npm shim resolving another Node.
[Installed summary](verification/inspection-2026-10-14/installed.json),
[Node 20 fixture/large-input evidence](verification/inspection-2026-10-14/installed-20-messages.json),
[Node 26 evidence](verification/inspection-2026-10-14/installed-26-messages.json).

The eight updated large-message screenshots come from this clean browser run
and were visually inspected. All eight span-download hashes match the prior
focused run; the phone layout has improved without changing the evidence.
[Phone history](assets/message-decoding/history-chromium-375.png),
[desktop system parts](assets/message-decoding/system-firefox-1440.png).

## Reproduction

```bash
npm ci
npm run lint && npm run typecheck
npm test -- --maxWorkers=1
npm run build && npm run test:cli && npm run test:browser
npm pack
```

The individual studies document their independent schedules, declared damage,
measured populations and replay arguments. Installed replays accept `--cli`
and `--node`; the selected executable's directory determines the imported core.
Build output is `dist/` for the static app and `dist-cli/` for the package.
