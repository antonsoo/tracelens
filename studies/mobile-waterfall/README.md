# Reach span details without traversing the whole trace

On a narrow screen, the old layout stacked the detail panel below every
waterfall row. Virtualization limited DOM work but left the page as tall as
the complete trace. A valid 6,000-span import put its selected detail panel
about 150,206 pixels below the timeline's start. The 340-pixel sticky labels
also left just 34 pixels of timing track on a 375-pixel phone.

The narrow layout now bounds the timeline panel and scrolls its rows inside
it. The page still scrolls to the detail content below. Labels take at most
55% of the viewport, capped at the desktop width, and indentation is bounded
so deeply nested names leave room for timing. Full tree levels, names,
timestamps and span evidence remain intact.

## Actual browser geometry

At 375 by 800 pixels, with 6,000 spans:

| Browser | Measure | Before | After |
|---|---|---:|---:|
| Chromium | Detail distance from timeline start | 150,206.30 px | 480 px |
| Firefox | Detail distance from timeline start | 150,206.33 px | 480 px |
| Chromium | Document height | 151,252 px | 1,526 px |
| Firefox | Document height | 151,253 px | 1,526 px |
| Both | Visible timing track | 34 px | 168.75 px |

The 160-span control also places details 480 pixels below the timeline start
after the change, rather than about 4,206 pixels. These controls are
**synthetic valid OTLP documents** with declared timestamps, not captured
agent performance or a live model workload.

[`browser.mjs`](browser.mjs) replays both sizes in Chromium and Firefox at
375, 768 and 1440 pixels. [Before](results/before/receipt.json) uses a fresh
archive build of `9a1374f`; [after](results/after/receipt.json) records the
corrected production assets. Each context disconnects before its first import.
The 24 before/after imports retain the complete span counts, keyboard End
navigation, selected last-span downloads and scroll position through zoom.
All 12 paired input hashes and last-span download hashes match.

The receipt retains loaded/served asset hashes, geometry, page/request checks,
accessibility results and document overflow checks. No external/late requests,
page/CSP/accessibility errors or document overflow occurred. Wide-screen
inspection keeps its existing side-by-side layout. The regular waterfall audit
also exercises scrolling and selecting a distant row at phone width.

All six screenshots were inspected. The phone figures use the 160-span control
and the same page scroll position, so the selected detail can be seen after
bounding the panel: [before Chromium](results/before/chromium-375.png),
[after Chromium](results/after/chromium-375.png),
[after Firefox](results/after/firefox-375.png).
[Desktop control](results/after/chromium-1440.png).

```bash
npm run build
node studies/mobile-waterfall/browser.mjs /path/to/baseline/dist before
node studies/mobile-waterfall/browser.mjs dist after --expect-bounded
```

This changes layout and navigation distance, not calculations or imported
evidence. The browser's 25 MiB input limit and 30-second import watchdog remain.
