# Changelog

All notable changes to this project are documented in this file.

## [0.2.1] - 2026-10-01

- Published to npm as `@antonsoloviev/tracelens`:
  `npx @antonsoloviev/tracelens summary trace.json`.
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
