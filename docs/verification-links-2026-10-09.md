# Span-link verification, 2026-10-09

All work is local. No registry release, remote push, tag or site deployment
was performed. The published package remains outside this verification.

## Reproduced behavior

The previous checkout (`eed0aa2`) discarded all 8 links in the new controlled
SDK capture. It also attached a native Jaeger reference to a local span that
shared the target span ID but belonged to the wrong trace. The retained replay
checks 400 OTLP/JSON Lines cases and 200 Jaeger cases, using explicit expected
identities and source metadata. All those cases agree after the change; the
400 OTLP cases keep exactly the same timing report after adding links.

The SDK capture comes from four local Queue jobs, one unsampled producer and
deliberate SDK link/attribute limits. Nine spans across four traces record
eight links and one dropped link. The SDK-object oracle is independent of
Tracelens. Seven trace-state values disappear in the upstream Python encoder;
they remain unavailable here. See [the study](../studies/span-links/README.md)
for source hashes, scripts and all before/after results.

## Clean checkout dependencies and actual workflows

| Command / workflow | Observed result |
| --- | --- |
| `npm ci` | Fresh dependency install; 0 reported vulnerabilities |
| `npm run lint` | Pass |
| `npm run typecheck` | Both TypeScript configurations pass |
| `npm test` | 236 tests, 21 files |
| `npm run build` | Web app in `dist/`; CLI in `dist-cli/` |
| `npm run test:cli` | 30 integration checks |
| `npm run test:browser` | Legacy browser audits plus 102 Chromium/Firefox scenarios |
| `uv run --locked scripts/capture-links.py --output-directory <scratch>` | Fresh capture: 9 spans, 8 links, 1 dropped, all four jobs processed |
| `npm pack`, installed outside checkout | 18 successful CLI invocations on Node 26.7.0 and 20.0.0 |
| Replay against each installed core | SDK links and all 600 controls agree on both runtimes |

Installed invocations include help/version, summary, tree, text/JSON links,
timing, cost and comparison. Actual output is retained in
`studies/span-links/installed-cli.json`, `cli-links-v*.json` and `cli-links.txt`.
The Node 20.0.0 binary was downloaded from the official distribution and
checked against `SHASUMS256.txt`, rather than relying on an npm executable
wrapper to select a runtime.

The packed local artifact is `antonsoloviev-tracelens-0.3.3.tgz`, SHA-256:
`7ef453a02d83bd7ac4f316d8c2e01f5a66659d211558147dc612ea6d3c88efdf`.
This is a local build using the existing version, not a release with that version.

## Browser behavior and visual review

The SDK sample and file upload both reach the Links tab. Actual downloaded
span JSON retains all three batch links, their metadata and the dropped
count; the trace's downloaded links report equals CLI JSON. A cross-trace
target can be opened while the browser is offline and then returned to the
source span. Inspecting from either comparison side preserves the complete
comparison JSON. Same-trace links do not change the parent tree.

Missing and duplicate targets offer no navigation. A cyclic target trace
produces an error while the source remains visible. A 1,001-link input renders
20 cards per page and downloads all 1,001 records. Malicious-looking attribute
names are text. Keyboard tab selection, narrow layouts, accessibility checks,
worker cancellation, timeouts and recovery pass. Request-origin and CSP
checks include the new same-origin blob workers.

Four new screenshots were opened and visually reviewed:

- [Desktop dark](assets/links-dark-1440.png)
- [Desktop light](assets/links-light-1440.png)
- [320px dark](assets/links-dark-320.png)
- [375px light](assets/links-light-375.png)

The desktop keeps its scrollable inspector; on phones the details now scroll
with the page so the link records are reachable without a short nested pane.
IDs wrap, targets remain readable and no page overflow was observed. The
phone's existing waterfall still has its own horizontal timeline scroll.

## Cost of retaining evidence

A generated 6,669,248-byte file with 20,000 spans, 100 traces and 40,000 links
was read seven times (two warmups, five measurements). Median JSON decode and
import time was 62.681 ms before and 87.011 ms after, with the selected trace
now retaining its 400 links. This is unequal work: the previous importer lost
the link evidence. These are local observations on a 14-logical-CPU WSL2 host
with about 47 GiB memory, Node 26.7.0, alongside other checks; they are not a
controlled performance comparison. File I/O and rendering are excluded.

The embedded parser changes the production main JS bundle to 114.94 kB
(36.02 kB gzip). It removes the later worker-script network dependency.
The existing 25 MiB browser input limit, non-streaming parser and UI-thread
summary/export work still apply. New sample downloads and whole-site reloads
are not guaranteed offline.
