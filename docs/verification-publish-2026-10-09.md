# Tracelens publication review, 2026-10-09

The review began at `9d1d5bd`, with 17 local commits beyond `origin/main`.
It covers cancellable imports, instrumentation dialects, elapsed-time
accounting, cost receipts and cross-trace span links. Earlier verification
notes describe their original local state; this record covers the new review.
No npm registry release or version tag is part of this work.

## Corrections found during review

The [default-price review](../studies/default-prices/README.md) found a doubled
Sonnet 5.5 cache-read rate and three omitted GPT-6 cache-write rates. GPT-6.1
Sol now has its own entry. All 11 existing Anthropic rows were checked directly
against the provider page; older OpenAI rows retain their earlier source dates.
Twenty separately specified component calculations now agree, compared with
8 disagreements or missing prices before the correction. Saved browser tables
preserve the user's rates; the Prices dialog explains how to adopt the defaults.

The span-link replay now accepts fresh captures and exits unsuccessfully on
SDK or identity disagreements. A new Python timing checker calculates active
self-time membership from raw timestamps, independently of the app's interval
subtraction and event sweep. The browser verification driver accepts either a
local or hosted URL and compares actual downloads with the compiled CLI.

## New captures and installed package

[Retained evidence](publish-evidence-2026-10-09/) contains fresh controlled SDK
captures, not copies of earlier pass reports. No model endpoint was called.

| Workflow | New observation |
| --- | --- |
| Queue/context propagation, Python OTel SDK 1.45.1 | Four completed jobs; 9 spans; all 8 links retained; 1 deliberate dropped link |
| Link identity replay | 600 controlled OTLP/JSON Lines/Jaeger cases; no identity, metadata, timing or reference disagreement |
| Three concurrent loopback HTTP requests | 251.132 ms elapsed, 489.863 ms summed self time, peak 3 |
| The same three requests sequentially | 465.856 ms elapsed and summed self time, peak 1 |
| Timing against raw-source Python oracle | All 13 raw intervals in each capture agree, including buckets and active source IDs |
| Pinned recorded Responses stream through AI SDK 6.0.302 | One loopback request, zero provider requests, two SDK spans |
| Python Decimal against raw response counts | $0.00081907 token estimate; 3,103 fresh input, 2,944 cached input and 1,623 output tokens |
| Packed CLI installed outside the checkout | 16 successful command invocations across Node 20.0.0 and 26.7.0 |
| Both installed runtimes | All 600 link controls and 20 price calculations agree |

Timing observations include deliberate server delays and local overhead; they
are not a performance benchmark. The nano response's 1,408 reasoning tokens
are already in its output count. Its code-interpreter fee is outside this token
estimate. The fixture and license are identified in
[the replay instructions](../scripts/cost-replay/README.md).

The clean archive is `94aab05`. Its local package uses the existing 0.3.3 version
and is **not the npm release**. SHA-256:
`a6f7f99efcef3a4e6989a6ff5d89a18737b820cc29a7617c4432702481ab85d2`.
Node 20's archive was checked against the official `SHASUMS256.txt`; the
executed binary was also compared byte-for-byte with that archive.

## Clean build and browser verification

`git archive 94aab05` was unpacked into a fresh directory. `npm ci` installed
from the lockfile and reported zero vulnerabilities. npm blocked esbuild's
optional install script under the existing allowScripts setting; the installed
platform package still built successfully. No dependency policy was changed.

Lint, both TypeScript configurations, all 236 unit checks and all 30 CLI checks
passed. The legacy browser audits and all 102 Chromium/Firefox scenarios
also passed. Twelve local screenshots covering the three workflows in both
browsers were opened and visually reviewed. The production main JavaScript is 115.50 kB (36.18 kB gzip); CSS is
35.81 kB (6.31 kB gzip).

The separate served-build driver ran Chromium and Firefox, light and dark,
at 1440px and 375px: eight workflows. In each it downloaded links and cost
reports equal to the CLI, inspected the selected cost receipt offline,
followed an imported cross-trace target offline, verified the refreshed prices,
exported complete timing source IDs, and returned to an unchanged comparison.
No page errors, CSP violations, external-origin requests or page-width overflow
were observed. [Observed results](publish-evidence-2026-10-09/browser-local.json).

## Published source and site

The source and `gh-pages` were pushed as fast-forward updates. The public site
is [antonsoo.github.io/tracelens](https://antonsoo.github.io/tracelens/).

| Artifact | Reviewed/published revision |
| --- | --- |
| Clean application build | `94aab05` |
| Source publication, including review evidence | `135d2b2` |
| Static site branch | `bce6532` |
| npm registry version, rechecked after publication | `0.3.3`, unchanged; the newer CLI commands require a source build |

The source publication and later documentation commits contain the same
application files as the clean build. All **33 served files** have matching
SHA-256 values, including HTML, JavaScript, CSS, fonts and all nine examples.
[File-by-file comparison](publish-evidence-2026-10-09/hosted-assets.json).

The same eight browser/theme/width workflows passed against the public URL:
actual links, cost and timing downloads match the compiled CLI; imported link
navigation, receipts and comparison inspection work offline; refreshed prices
are present. There were no page errors, external-origin requests, CSP violations
or page-width overflows. [Hosted observations](publish-evidence-2026-10-09/browser-hosted.json).
Twelve hosted screenshots were opened and visually reviewed; examples:

- [Cross-trace inspection, desktop](assets/published-2026-10-09/links-chromium-dark-1440.png)
- [Cost receipt, phone](assets/published-2026-10-09/cost-firefox-light-375.png)
- [Timing accounting, phone](assets/published-2026-10-09/timing-chromium-light-375.png)

From a checkout built with `npm ci && npm run build`, repeat the hosted checks:

```sh
python3 scripts/verify-assets.py https://antonsoo.github.io/tracelens/ dist /tmp/tracelens-assets.json
node scripts/verify-site.mjs https://antonsoo.github.io/tracelens/ /tmp/tracelens-site-check
```

## Scope

The parser is not streaming and browser files remain capped at 25 MiB.
Summary/export work still runs on the UI thread. Already imported linked traces
work offline; loading new samples or reloading the whole site may need a network.
Seven SDK trace-state values are omitted upstream by the pinned Python encoder;
the importer cannot recover them. Missing targets and dropped evidence remain
explicitly unavailable. Rates do not infer service tiers, regional or context
premiums, extended cache TTL or non-token fees. No production invoice was checked.
