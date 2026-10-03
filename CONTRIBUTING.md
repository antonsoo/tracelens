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

Run comparison integration checks after building: `npm run test:cli` and
`npm run test:browser`. The browser check needs Playwright Chromium installed
and Firefox (`npx playwright install chromium firefox`) and starts its own
local preview servers on ports 4318 and 4319. The second suite lives in
`tests/browser/` and uses Playwright Test. Run it alone with
`npx playwright test` after building. To refresh the span-search screenshots,
run `CAPTURE_SCREENSHOTS=1 npx playwright test -g 'accessible layouts'`.

## Community and private reports

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Anton Soloviev
maintains this project and handles conduct reports at
[anton@praviel.com](mailto:anton@praviel.com).

Use the bug or improvement forms for public issues. For a suspected security
vulnerability or a conduct concern, email the maintainer privately with the
repository name and relevant details. Do not post credentials, personal data,
private logs, or confidential documents in a public issue.
