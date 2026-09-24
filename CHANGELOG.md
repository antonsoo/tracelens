# Changelog

All notable changes to this project are documented in this file.

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
