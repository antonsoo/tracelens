#!/usr/bin/env node
// tracelens CLI. This file is only ever invoked as the package's `bin`
// entry (via `npx github:antonsoo/tracelens` or a local install), never
// imported as a library, so it runs `main()` unconditionally rather than
// guarding on `import.meta.url === argv[1]` (that comparison breaks once
// npm resolves the bin through a symlink, which is exactly how `npm i -g`
// installs it).
import { readFile } from 'node:fs/promises';
import { parseOtlpJson, buildSummary, DEFAULT_PRICE_TABLE, spanDurationMs } from '../core/index.js';
import type { ParsedSpan } from '../core/index.js';
import { bold, cyan, dim, fmtInt, fmtMs, fmtUsd, green, heading, magenta, red, table, yellow } from './format.js';

const HELP = `${bold('tracelens')} — a terminal summary for OTLP/JSON agent traces

${bold('Usage:')}
  tracelens summary <trace.json>   Print duration, token, cost and error summary
  tracelens tree <trace.json>      Print the span tree
  tracelens --help                 Show this help

${bold('Install from GitHub (nothing is published to npm yet):')}
  npx --yes --allow-git=root github:antonsoo/tracelens summary trace.json

  npm 12+ disables installing from git by default; --allow-git=root opts back in
  (or set the npm config permanently: npm config set allow-git true).
`;

function kindColor(kind: string, s: string): string {
  switch (kind) {
    case 'llm':
      return cyan(s);
    case 'tool':
      return magenta(s);
    case 'agent':
      return green(s);
    default:
      return s;
  }
}

async function loadTrace(path: string) {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`Can't read "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`"${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseOtlpJson(json);
}

function printSummary(path: string, trace: ReturnType<typeof parseOtlpJson>): void {
  const summary = buildSummary(trace, DEFAULT_PRICE_TABLE);
  console.log(bold(`${path}`));
  console.log(dim(`trace ${trace.traceId}  ·  ${summary.spanCount} spans  ·  ${trace.roots.length} root span(s)`));

  console.log(heading('Timing'));
  console.log(
    table(
      ['bucket', 'self time'],
      [
        ['total wall clock', fmtMs(summary.totalDurationMs)],
        [cyan('llm'), fmtMs(summary.llmSelfTimeMs)],
        [magenta('tool'), fmtMs(summary.toolSelfTimeMs)],
        ['other', fmtMs(summary.otherSelfTimeMs)],
      ],
    ),
  );

  if (summary.modelUsage.length > 0) {
    console.log(heading('Tokens & cost by model'));
    console.log(
      table(
        ['model', 'calls', 'input', 'output', 'cost'],
        summary.modelUsage.map((r) => [
          r.model,
          fmtInt(r.calls),
          fmtInt(r.inputTokens),
          fmtInt(r.outputTokens),
          fmtUsd(r.costUsd),
        ]),
      ),
    );
    const totalLine = `total: ${fmtUsd(summary.totalCostUsd)}`;
    console.log(`\n${bold(totalLine)}${summary.uncostedCalls > 0 ? dim(`  (${summary.uncostedCalls} call(s) had no price match)`) : ''}`);
  } else {
    console.log(heading('Tokens & cost by model'));
    console.log(dim('No LLM spans with gen_ai/OpenInference usage attributes were found.'));
  }

  console.log(heading('Errors & retries'));
  console.log(
    `${summary.errorCount > 0 ? red(`${summary.errorCount} span(s) ended in error`) : green('no errors')}` +
      dim('  ·  ') +
      `${summary.retryCount} retried call(s)`,
  );

  console.log(heading('Critical path'));
  console.log(dim('longest-duration child chosen at each nesting level — see docs/formats.md'));
  for (const span of summary.criticalPath) {
    const label = span.genai?.toolName ? `${span.name} (${span.genai.toolName})` : span.name;
    console.log(`  ${'  '.repeat(span.depth)}${kindColor(span.agentKind, label)} ${dim(fmtMs(spanDurationMs(span)))}`);
  }

  if (trace.warnings.length > 0) {
    console.log(heading('Parser warnings'));
    for (const w of trace.warnings) console.log(yellow(`  ⚠ ${w.message}`));
  }
}

function printTree(trace: ReturnType<typeof parseOtlpJson>): void {
  const walk = (span: ParsedSpan): void => {
    const statusMark = span.status.code === 'ERROR' ? red(' ✗') : '';
    const label = span.genai?.toolName ? `${span.name} (${span.genai.toolName})` : span.name;
    console.log(`${'  '.repeat(span.depth)}${kindColor(span.agentKind, label)} ${dim(fmtMs(spanDurationMs(span)))}${statusMark}`);
    for (const c of span.children) walk(c);
  };
  for (const r of trace.roots) walk(r);
}

async function main(): Promise<void> {
  const [, , cmd, file] = process.argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  if (cmd !== 'summary' && cmd !== 'tree') {
    console.error(red(`Unknown command "${cmd}".`));
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  if (!file) {
    console.error(red(`Missing <trace.json> argument.`));
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  try {
    const trace = await loadTrace(file);
    if (cmd === 'summary') printSummary(file, trace);
    else printTree(trace);
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}

await main();
