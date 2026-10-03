# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- Local span search and an errors-only filter, with ancestor context,
  separate match counts, empty results, and preserved branch folds.
  Summary totals and comparison exports remain unfiltered.
- Loading status and cancellation for pending file reads and sample
  downloads. A newer choice aborts obsolete fetches and skips decoding
  obsolete file reads.
- Chromium/Firefox workspace regressions and desktop/mobile accessibility
  checks, including contrast on selected error rows.

### Fixed

- Choosing an uncomparable trace from a multi-trace file could replace one
  side of a valid comparison and break the return to the comparison view.
  Both sides are now checked before state changes.
- Timeline dragging stopped after its first movement because a redraw
  discarded the gesture's mouse handlers. A drag now survives redraws;
  leaving inspection disposes its global listeners and cached views.
- Detail tabs now expose their selected state, support arrow/Home/End
  navigation and retain focus. The waterfall uses one Tab entry point.
  The price dialog is named and returns focus after save or cancel;
  validation focuses the invalid field and row edits keep a useful focus.
- Keyboard access to file selection and focus after loading, trace
  selection, comparison navigation, zooming, resizing and theme changes.
- Cache-write token counts are visible in the span overview. Deep traces
  retain their actual accessibility level while visual indentation is
  capped so their names remain readable.

## [0.3.3] - 2026-10-03

### Fixed

- A file that is not text (an image, an archive) given by mistake was parsed as JSON, and the
  error quoted its raw bytes: `Not valid JSON: Unexpected token '?', "?PNG..."`, control
  characters included. It now says `not a text file (a trace is JSON: OTLP/JSON, a
  collector's JSON Lines, or Jaeger JSON)`, in the CLI and in the web app.

## [0.3.2] - 2026-10-02

### Added

- Published to npm as `@antonsoloviev/tracelens`:
  `npx @antonsoloviev/tracelens summary trace.json`. The README, the format
  notes and `tracelens --help` use the registry package instead of the GitHub
  install, which npm 12 blocks by default.

### Fixed

- A trace saved by a Windows shell or editor. `... > trace.json` in Windows
  PowerShell writes UTF-16 with a byte-order mark, and its `-Encoding utf8`
  (like Notepad's "UTF-8 with BOM") puts a mark in front of UTF-8. The CLI
  refused both ("Not valid JSON: Unexpected token"), and the web app refused
  the UTF-16 one. The mark now decides the encoding and is dropped; the three
  copies of a trace give the same summary.

### Changed

- The page's fonts are served by the page itself. They came from Google Fonts,
  the one request the page made to another origin; the same font files (every
  subset, as Google serves them to a current browser) are now in
  `src/web/fonts/`, with their SIL Open Font License texts. Nothing looks
  different: screenshots before and after match. The page now loads with
  every other host blocked.

### Security

- The built page carries a Content-Security-Policy. Scripts, styles, fonts and
  workers load from the page's own origin only, and `connect-src 'self'` has
  the browser refuse to send what you give the page to any other host, even
  for a script injected through a bug in how the page renders a file. Inline
  event handlers and `eval` are not allowed. Every control was exercised
  in Chromium and Firefox with a listener for policy violations: none.

### Accessibility

- Checked with axe-core (WCAG 2.1 A and AA, and its best-practice rules) in light and dark,
  at desktop and phone widths, with a trace loaded and in the
  comparison view: no findings now. The faint text was 3.1:1 (light) and 3.4:1
  (dark); every view has one `main` landmark.

## [0.3.1] - 2026-10-02

Checked against spans written by real instrumentation libraries: the
Anthropic and OpenAI SDKs run over a mocked HTTP transport with OpenInference
(`openinference-instrumentation-anthropic` 3.0.1, `-openai` 0.1.63) and with
OpenLLMetry 0.62.4 active. Both traces are committed under
`tests/fixtures/instrumented/`, with the scripts that write them.

### Fixed

- **OpenInference assistant turns were empty.** Only `message.role` and
  `message.content` were read. The Anthropic instrumentation writes every
  assistant turn as `message.contents.<j>.message_content.*`, and both write
  tool calls as `message.tool_calls.<k>.tool_call.*`, so in a real trace an
  answer and a tool call each showed as an empty bubble. The thread now shows
  the text, the tool call with its arguments (once, although the span lists
  it twice), a tool's result as a result (`message.tool_call_id`), image
  parts and legacy function calls. The same two agent turns read the same
  under OpenInference and under `gen_ai.*`.
- OpenInference spans show the request's `max_tokens` and temperature
  (`llm.invocation_parameters`) and the finish reason (`llm.finish_reason`).
- `gen_ai.system_instructions` is a list of parts, not of messages; it was
  shown under the role "unknown". It is the system's.

## [0.3.0] - 2026-10-01

### Added

- JSON Lines. The OpenTelemetry Collector's file exporter, which the README
  recommends, writes one export per batch on a line of its own, so any run
  longer than a batch was refused as "not valid JSON". The lines are now
  read as one export, in the web app, the CLI and the library
  (`parseTraceText`). A last line cut short is skipped with a warning, and
  lines of metrics or logs in the same file are skipped and counted.
- Files with several traces, which is what a collector's file and a Jaeger
  search result are. They used to be refused ("Multiple trace IDs in one
  file"). One trace is read, the one with the most spans unless another is
  asked for, and the rest are listed: a picker in the web app, `--trace
  <id>` for `summary` and `tree`, `--baseline-trace` and `--candidate-trace`
  for `compare`. An ID can be shortened to any start of it that is unique
  in the file.
- Arrow-key navigation in the waterfall: up and down move, left and right
  fold and open a span, Home and End jump. Rows carry `aria-level`,
  `aria-expanded` and `aria-selected`.

### Fixed

- The timeline was always laid out 600 pixels wide. The track's width was
  measured before the waterfall was in the page, so it read as zero and fell
  back to the minimum: on a 1,900-pixel window the bars used half the track.
- Selecting a span, zooming or panning put the waterfall back at its top
  and dropped keyboard focus, because each of them rebuilt the view. In a
  trace longer than the screen, the span just clicked scrolled out of
  sight. The scroll position and the focused row are now kept.
- Long traces. Every span was a row in the page, rebuilt on every click:
  in headless Chromium a selection took 0.3 s in a 2,000-span trace, 4.7 s
  at 10,000 and 17 s at 40,000, and the 40,000-span trace took 10 s to
  appear. Only the rows in view are rendered now: about 40 ms per
  selection at any of those sizes, and 0.4 s to appear. The summary and the
  comparison are no longer recomputed on every render either.
- `tracelens tree`, and the critical path and warnings of `tracelens
  summary`, printed span and tool names as they came, escape sequences
  included. Text from a trace is now printed without control characters.
- A bar's duration label was cut mid-digit when the bar was a little too
  narrow for it; it is left out there. The bars' grow-in animation ran
  again on every click; it runs once per trace.
- The README still said Jaeger JSON was not parsed (it has been since
  0.2.0) and that the waterfall had no virtualization. Its three waterfall
  screenshots are re-shot.

### Changed

- `parseOtlpJson` no longer throws on a document with several traces; it
  reads one (see above) and returns the list as `traces`. Code that relied
  on the error can check `traces.length`.
- An unknown flag to `summary` or `tree` is an error. They used to ignore
  everything after the file name.

## [0.2.1] - 2026-10-01

- The package is named `@antonsoloviev/tracelens`, ready for npm (published
  there from 0.3.2).
- `tracelens --version`.

## [0.2.0] - 2026-09-30

- Jaeger's native JSON (the Jaeger UI's "Download JSON", or the query API's
  trace response) is read in the web app, the CLI and the library. It is
  converted to OTLP/JSON first, with microsecond times, typed tags, span kind,
  status and scope lifted from their tags, and logs as events, so it gets
  every OTLP check. A Jaeger copy of the GenAI example is bundled, made by an
  independent `scripts/otlp-to-jaeger.mjs`, and a test checks that both files
  give the same tree, times, status, events and cost.
- `docs/formats.md` described Jaeger's `startTime` as milliseconds; it is
  microseconds, as is `duration`.

## [0.1.1] - 2026-09-30

- Price table: Claude Sonnet 5.5 and the GPT-6 tier (Astra, Sol, Luna) get their
  own entries; an id that extends a shorter one no longer borrows its label.
- The drop zone's waveform is drawn across its full width (the draw animation's
  dash was shorter than the path).
- Cache writes are read from `gen_ai.usage.cache_creation.input_tokens`, the
  name the GenAI semantic conventions use; tracelens only knew
  `cache_write.input_tokens`, so a spec-compliant trace's cache writes were
  priced at the plain input rate instead of the cache-write rate (1.25x or 2x
  on Anthropic models). The old name is still accepted, and the bundled
  example now uses the spec's.
- Validate price rules and stored settings; keep the app usable with blocked
  browser storage. Expose both cache-read and cache-write rates in the editor.
- Keep incomplete/invalid usage unknown in costs and token totals; preserve
  mixed-convention usage and recognize legacy model-only LLM spans.
- Reject multi-trace batches, warn on invalid timestamps, and keep reserved
  attribute names as data. Traverse deep trees without recursive rendering.
- Count only possible retries after failed, completed tool calls.
- Preserve comparison filter, sort, expanded rows, focus and scroll during
  inspection, theme changes and resize; correct boolean ARIA attributes.

- Compare two local runs in the browser or with `tracelens compare`.
  Group repeated calls by operation ancestry; inspect per-side spans and
  model changes, sort/filter operations, swap runs, and export JSON.
- Compare elapsed time, self time, tokens, estimated costs and errors with
  explicit missing-measurement coverage and a captured price table.
- Add a labeled synthetic comparison pair and executable browser/CLI checks.
- Clip child intervals to the parent for self-time accounting.
- Reject cyclic parents and duplicate span IDs; resolve parents within
  their trace and assign depths without recursive stack overflow.

## [0.1.0] - 2026-09-24

Initial release.

- OTLP/JSON trace parser with typed-`AnyValue` decoding, tree building, and
  graceful handling of malformed spans, missing parents and clock skew.
- Semantic-convention mapping for OpenTelemetry GenAI (`gen_ai.*`, including
  the legacy per-message event fallback) and OpenInference
  (`openinference.*`, `llm.*`).
- Cost estimation against an editable, WebFetch-verified price table.
- A "critical path" heuristic, self-time accounting, and retry detection.
- Web UI: waterfall timeline with zoom/pan, span tree, detail panel
  (overview / messages / tool I/O / attributes / events), light and dark
  themes.
- CLI (`tracelens summary` / `tracelens tree`).
- Two real OpenTelemetry-SDK-generated example traces (mocked model calls,
  real telemetry) and the scripts that produced them.
