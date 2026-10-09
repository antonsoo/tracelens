#!/usr/bin/env node
// tracelens CLI. This file is only ever invoked as the package's `bin`
// entry (via `npx @antonsoloviev/tracelens` or a local install), never
// imported as a library, so it runs `main()` unconditionally rather than
// guarding on `import.meta.url === argv[1]` (that comparison breaks once
// npm resolves the bin through a symlink, which is exactly how `npm i -g`
// installs it).
import { readFile } from 'node:fs/promises';
import { decodeText } from '../core/decode.js';
import { parseTraceText, buildSummary, buildCostReport, buildTiming, compareTraces, DEFAULT_PRICE_TABLE, isPriceEntry, spanDurationMs, TraceParseError } from '../core/index.js';
import type { ParsedTrace, PriceEntry, TraceListing } from '../core/index.js';
import { bold, cyan, dim, fmtInt, fmtMs, fmtUsd, green, heading, magenta, red, safe, table, yellow } from './format.js';
import { formatComparison } from './compare-report.js';
import { VERSION } from './version.js';
import { formatTiming } from './timing-report.js';
import { formatCostReport } from './cost-report.js';
import { buildLinksReport } from '../core/links.js';
import { formatLinks } from './links-report.js';

const HELP = `${bold('tracelens')} — a terminal summary for agent traces (OTLP/JSON, a collector's JSON Lines, or Jaeger JSON)

${bold('Usage:')}
  tracelens summary <trace.json> [--trace <id>] [--prices <prices.json>]
                                  Print duration, token, cost and error summary
  tracelens tree <trace.json> [--trace <id>]
                                  Print the span tree
  tracelens links <trace.json> [--trace <id>] [--json]
                                  Inspect span links and targets in this file
  tracelens timing <trace.json> [--trace <id>] [--json]
                                  Explain elapsed time, overlaps and gaps
  tracelens cost <trace.json> [--trace <id>] [--json] [--prices <prices.json>]
                                  Explain token charges, rates and unpriced calls
  tracelens compare <baseline.json> <candidate.json> [--json]
                    [--baseline-trace <id>] [--candidate-trace <id>] [--prices <prices.json>]
                                  Compare runs by operation path
  tracelens --help                 Show this help
  tracelens --version              Show the version

A file that holds several traces is read one trace at a time: the one with
the most spans, or the one whose ID (or the start of it) follows --trace.

${bold('Run it without installing:')}
  npx @antonsoloviev/tracelens summary trace.json
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

async function loadTrace(path: string, traceId?: string): Promise<ParsedTrace> {
  let raw: string;
  try {
    raw = decodeText(await readFile(path));
  } catch (err) {
    throw new Error(`Can't read "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseTraceText(raw, traceId === undefined ? {} : { traceId });
  } catch (err) {
    if (err instanceof TraceParseError) throw new Error(`"${path}": ${safe(err.message)}`);
    throw err;
  }
}

/** The shortest start of a trace ID, eight characters or more, that no other trace in the file shares. */
function shortId(traceId: string, all: TraceListing[]): string {
  for (let length = 8; length < traceId.length; length++) {
    const prefix = traceId.slice(0, length);
    if (all.every((t) => t.traceId === traceId || !t.traceId.startsWith(prefix))) return prefix;
  }
  return traceId;
}

function describeTrace(t: TraceListing): string {
  return `${safe(t.rootName)}, ${fmtInt(t.spanCount)} ${t.spanCount === 1 ? 'span' : 'spans'}, ${fmtMs(Number(t.durationNs) / 1_000_000)}`;
}

/** For a file with several traces: which one is being read, and the flag that reads each of the others. */
function otherTraces(trace: ParsedTrace, flag: string, intro = 'this file; showing'): string[] {
  if (trace.traces.length < 2) return [];
  const chosen = trace.traces.find((t) => t.traceId === trace.traceId)!;
  const others = trace.traces.filter((t) => t !== chosen);
  const lines = [yellow(`${trace.traces.length} traces in ${intro} ${safe(chosen.traceId)} (${describeTrace(chosen)})`)];
  for (const t of others.slice(0, 10)) {
    lines.push(dim(`  also: ${safe(t.traceId)} (${describeTrace(t)})   ${flag} ${safe(shortId(t.traceId, trace.traces))}`));
  }
  if (others.length > 10) lines.push(dim(`  and ${others.length - 10} more`));
  return lines;
}

async function loadPrices(path: string | undefined): Promise<PriceEntry[]> {
  if (path === undefined) return DEFAULT_PRICE_TABLE;
  const parsed: unknown = JSON.parse(decodeText(await readFile(path)));
  if (!Array.isArray(parsed) || !parsed.every(isPriceEntry)) throw new Error('Price file must be an array of valid price entries (whole model name, provider, finite nonnegative rates, source URL and date).');
  return parsed;
}

function printSummary(path: string, trace: ParsedTrace, prices: PriceEntry[]): void {
  const summary = buildSummary(trace, prices);
  console.log(bold(`${path}`));
  console.log(dim(`trace ${safe(trace.traceId)}  ·  ${summary.spanCount} spans  ·  ${trace.roots.length} root span(s)`));
  for (const line of otherTraces(trace, '--trace')) console.log(line);

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
        ['model', 'provider', 'calls', 'input', 'output', 'token cost'],
        summary.modelUsage.map((r) => [
          safe(r.model),
          safe(r.provider ?? '(not recorded)'),
          fmtInt(r.calls),
          r.missingInputCalls ? `unknown (${r.missingInputCalls} missing)` : fmtInt(r.inputTokens),
          r.missingOutputCalls ? `unknown (${r.missingOutputCalls} missing)` : fmtInt(r.outputTokens),
          r.uncostedCalls ? `${fmtUsd(r.costUsd)} subtotal (${r.uncostedCalls} unpriced)` : fmtUsd(r.costUsd),
        ]),
      ),
    );
    const totalLine = `token estimate: ${fmtUsd(summary.totalCostUsd)}`;
    console.log(`\n${bold(totalLine)}${summary.uncostedCalls > 0 ? dim(`  (known subtotal; ${summary.uncostedCalls} call(s) lack valid usage or pricing)`) : ''}`);
  } else {
    console.log(heading('Tokens & cost by model'));
    console.log(dim('No model-call spans were found.'));
  }
  console.log(dim(`Use tracelens cost for rates, assumptions and per-call evidence; ${summary.costReport.excludedSpans} non-call span(s) with model/usage data excluded.`));

  console.log(heading('Errors & possible retries'));
  console.log(
    `${summary.errorCount > 0 ? red(`${summary.errorCount} span(s) ended in error`) : green('no errors')}` +
      dim('  ·  ') +
      `${summary.retryCount} possible retried call(s)`,
  );

  console.log(formatTiming(summary.timing, false));

  console.log(heading('Longest-child chain (heuristic)'));
  console.log(dim('longest-duration child chosen at each nesting level — see docs/formats.md'));
  for (const span of summary.criticalPath) {
    const label = safe(span.genai?.toolName ? `${span.name} (${span.genai.toolName})` : span.name);
    console.log(`  ${'  '.repeat(span.depth)}${kindColor(span.agentKind, label)} ${dim(fmtMs(spanDurationMs(span)))}`);
  }

  if (trace.warnings.length > 0) {
    console.log(heading('Parser warnings'));
    for (const w of trace.warnings) console.log(yellow(`  ⚠ ${safe(w.message)}`));
  }
}

function printTree(trace: ParsedTrace): void {
  for (const line of otherTraces(trace, '--trace')) console.log(line);
  const pending = [...trace.roots].reverse();
  while (pending.length) {
    const span = pending.pop()!;
    const statusMark = span.status.code === 'ERROR' ? red(' ✗') : '';
    const label = safe(span.genai?.toolName ? `${span.name} (${span.genai.toolName})` : span.name);
    console.log(`${'  '.repeat(span.depth)}${kindColor(span.agentKind, label)} ${dim(fmtMs(spanDurationMs(span)))}${statusMark}`);
    for (let i = span.children.length - 1; i >= 0; i--) pending.push(span.children[i]!);
  }
}

class UsageError extends Error {}

interface Args {
  files: string[];
  json: boolean;
  /** Values of accepted options, by flag name. */
  traces: Map<string, string>;
}

/** Splits what follows the command into files and the flags that command accepts. */
function parseArgs(args: string[], valueFlags: string[], allowJson: boolean, usage: string): Args {
  const parsed: Args = { files: [], json: false, traces: new Map() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && allowJson && !parsed.json) parsed.json = true;
    else if (valueFlags.includes(arg) && !parsed.traces.has(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value.\n${usage}`);
      parsed.traces.set(arg, value);
    } else if (arg.startsWith('--')) throw new UsageError(usage);
    else parsed.files.push(arg);
  }
  return parsed;
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === '--version' || cmd === '-v') {
    console.log(`tracelens ${VERSION}`);
    return;
  }
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  if (cmd !== 'summary' && cmd !== 'tree' && cmd !== 'compare' && cmd !== 'timing' && cmd !== 'cost' && cmd !== 'links') {
    console.error(red(`Unknown command "${safe(cmd)}".`));
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  if (rest.length === 0) {
    console.error(red(`Missing <trace.json> argument.`));
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  try {
    if (cmd === 'compare') {
      const usage = 'Usage: tracelens compare <baseline.json> <candidate.json> [--json] [--baseline-trace <id>] [--candidate-trace <id>] [--prices <prices.json>]';
      const args = parseArgs(rest, ['--baseline-trace', '--candidate-trace', '--prices'], true, usage);
      if (args.files.length !== 2) throw new UsageError(usage);
      const [baseline, candidate] = await Promise.all([
        loadTrace(args.files[0]!, args.traces.get('--baseline-trace')),
        loadTrace(args.files[1]!, args.traces.get('--candidate-trace')),
      ]);
      const report = compareTraces(baseline, candidate, await loadPrices(args.traces.get('--prices')));
      // Which trace was read from a file of several goes to stderr: stdout is the report, and with --json nothing else.
      for (const line of otherTraces(baseline, '--baseline-trace', `the baseline, ${args.files[0]}; comparing`)) console.error(line);
      for (const line of otherTraces(candidate, '--candidate-trace', `the candidate, ${args.files[1]}; comparing`)) console.error(line);
      console.log(args.json ? JSON.stringify(report, null, 2) : formatComparison(report));
      return;
    }
    const priced = cmd === 'summary' || cmd === 'cost';
    const json = cmd === 'timing' || cmd === 'cost' || cmd === 'links';
    const usage = `Usage: tracelens ${cmd} <trace.json> [--trace <id>]${json ? ' [--json]' : ''}${priced ? ' [--prices <prices.json>]' : ''}`;
    const args = parseArgs(rest, ['--trace', ...(priced ? ['--prices'] : [])], json, usage);
    if (args.files.length !== 1) throw new UsageError(usage);
    const file = args.files[0]!;
    if (cmd === 'timing') {
      const trace = await loadTrace(file, args.traces.get('--trace'));
      const timing = buildTiming(trace);
      for (const line of otherTraces(trace, '--trace')) console.error(line);
      console.log(args.json ? JSON.stringify(timing, null, 2) : formatTiming(timing));
      if (!args.json) for (const warning of timing.warnings) console.log(yellow(`Warning: ${safe(warning.message)}`));
      return;
    }
    const trace = await loadTrace(file, args.traces.get('--trace'));
    if (cmd === 'links') {
      const report = buildLinksReport(trace);
      for (const line of otherTraces(trace, '--trace')) console.error(line);
      console.log(args.json ? JSON.stringify(report, null, 2) : formatLinks(report));
    }
    else if (cmd === 'cost') {
      const report = buildCostReport(trace, await loadPrices(args.traces.get('--prices')));
      for (const line of otherTraces(trace, '--trace')) console.error(line);
      console.log(args.json ? JSON.stringify(report, null, 2) : formatCostReport(report));
    }
    else if (cmd === 'summary') printSummary(file, trace, await loadPrices(args.traces.get('--prices')));
    else printTree(trace);
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}

await main();
