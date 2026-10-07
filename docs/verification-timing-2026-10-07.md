# Elapsed-time accounting: local verification, 2026-10-07

Implementation: `80832a1`. Build dependency patch: `d2f998c`.
These changes are local and unreleased. No push, package publication or website
deployment was performed.

## Useful difference

The old summary showed 7.00 seconds of summed work inside a 6.20-second run,
then chose one longest child at each level as a heuristic critical path. It
could not quantify the overlap. The new accounting identifies exactly 0.80
seconds of repeated coverage and links the overlap interval to its two spans.
The candidate's 3.40-second elapsed increase consists of 2.60 seconds of added
summed work plus 0.80 seconds from lost overlap. This is an accounting identity,
not proof of which change caused the slowdown.

The [new controlled capture](../scripts/capture-timing.py) makes six actual
loopback HTTP requests under OpenTelemetry Python SDK 1.45.1, in two runs.
It verifies responses, span counts and observed concurrency. Delays are injected
on purpose; the captures are not a production benchmark or model call.

| Captured run | Elapsed | Summed self time | Overlap excess | Peak concurrency |
| --- | ---: | ---: | ---: | ---: |
| Parallel requests | 248.020 ms | 479.996 ms | 231.976 ms | 3 |
| Sequential requests | 466.953 ms | 466.953 ms | 0 ms | 1 |

See the [complete comparison JSON](verification-timing-result-2026-10-07.json).
The CPU scheduling noise and client overhead are real; the timestamps were not
replaced with the planned delays.

## Independent and browser verification

- A point-membership oracle checks every nanosecond of 180 seeded small irregular
  traces without sharing the interval subtraction or sweep implementation. It
  covers detached children, multiple roots, overlaps, gaps, zero durations and
  large absolute timestamps. Separate expected values check triple overlap and
  the bundled comparison.
- Chromium and Firefox load the production application and download timing JSON
  equal to the native CLI. They inspect original spans, swap runs, retain interval
  pages across theme changes and download while offline. Malicious-looking names
  remain text. No page errors, off-origin requests or CSP violations were observed.
- A 1,200-way overlap retains eight example IDs per exported interval, but the
  selected interval resolves and downloads all 1,200 IDs. Only ten interval
  buttons and twenty span links are rendered per page.
- Keyboard and axe checks cover the open timing inspector at 320px in light and
  dark modes in both browsers. Four timing scans and the existing workspace
  accessibility scans passed; this is not a manual screen-reader study.

All screenshots below were opened for visual review. Comparison evidence uses
normal page scrolling; the single-trace inspector bounds its height so the
waterfall remains available.

| Browser | Desktop | Active-span evidence | Narrow dark view |
| --- | --- | --- | --- |
| Chromium | [1440px](assets/timing-chromium-desktop.png) | [Detail](assets/timing-chromium-evidence.png) | [390px](assets/timing-chromium-mobile.png) |
| Firefox | [1440px](assets/timing-firefox-desktop.png) | [Detail](assets/timing-firefox-evidence.png) | [390px](assets/timing-firefox-mobile.png) |

## Larger input and fresh installation

A controlled trace with 20,000 overlapping root spans contained 5,248,938 input
bytes. Chromium loaded it in 1,117 ms and Firefox in 4,429 ms. Opening its peak
interval took 119 ms and 147 ms respectively. Both downloaded 20,000 distinct
IDs while rendering twenty links. These are single local measurements, including
browser/UI overhead, not general performance guarantees. The size measurement
preceded the final comparison-only scrolling adjustment; the timing algorithm
was unchanged. [Recorded measurements](verification-timing-browser-2026-10-07.json).

A detached checkout with no installed dependencies used Node 24.21.0 and passed
`npm ci`, strict typechecking, lint, 192 unit cases, 26 CLI cases, the production
build, the existing end-to-end browser script and all 72 Chromium/Firefox
workflows. All 32 production files matched the working Node 26.7.0 build by
SHA-256: [asset manifest](verification-timing-assets-2026-10-07.json).
The separate waterfall stress/keyboard script passed in the working checkout.

The dependency audit found source-map-js 1.2.1 in build tooling. The lockfile now
uses its 1.2.2 patch for [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q);
only that dependency changed. The fresh installation reported zero known npm
vulnerabilities at verification time.

The [walkthrough](timing.md) describes the schema, bounded references, exact
arithmetic and limitations. Missing spans and clock skew can change the observed
breakdown; it is neither measured CPU utilization nor a causal scheduling model.
