# Contributing

This is a personal portfolio project, but issues and pull requests are
welcome.

## Setup

```bash
npm install
npm run dev          # web UI at http://localhost:5173
npm run test         # vitest
npm run lint          # eslint
npm run typecheck     # tsc --noEmit, both tsconfigs
npm run build         # web (dist/) + CLI (dist-cli/)
```

## Layout

- `src/core/` — the parser, semconv mapping, cost model and layout math.
  Framework-agnostic; both the web UI and the CLI depend on it, nothing
  depends the other way.
- `src/web/` — the Vite/TypeScript UI (no framework — see the README for
  why).
- `src/cli/` — the `tracelens` CLI entry point.
- `tests/` — vitest, against both real fixtures (`examples/`) and
  hand-built edge cases (`tests/fixtures.ts`).
- `examples/` — real OpenTelemetry SDK trace exports and the Python scripts
  that generate them.
- `docs/formats.md` — the exact attribute keys and spec versions the parser
  targets. Update this alongside any change to `src/core/normalize.ts`.

## Before opening a PR

- `npm run lint && npm run typecheck && npm test && npm run build` should
  all pass.
- New parsing/mapping behavior needs a test against a real or realistic
  fixture, not just a smoke test.
- If you change what an attribute maps to, update `docs/formats.md` in the
  same PR — it's the single source of truth for "what does tracelens
  actually read."
