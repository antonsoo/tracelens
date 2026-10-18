// Native SDK validity observations, parser and real CLI before/after replay.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values: args } = parseArgs({ options: { compiled: { type: 'string', default: 'dist-cli' }, out: { type: 'string' }, verify: { type: 'boolean', default: false } } });
assert.ok(args.out, 'Supply --out');
const compiled = resolve(args.compiled), directory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const core = await import(pathToFileURL(join(compiled, 'core/index.js')));
const oracle = JSON.parse(readFileSync(join(directory, 'oracle.json')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of oracle.files) assert.equal(sha(readFileSync(join(directory, file.file))), file.sha256);
const expected = oracle.observations.filter(row => row.sdkIsValid);
assert.equal(expected.length, 2); assert.equal(oracle.observations.filter(row => !row.sdkIsValid).length, 5);
function load(file) { return core.decodeTraceFile(readFileSync(join(directory, file)), file); }
function cli(params) {
  const result = spawnSync(process.execPath, [join(compiled, 'cli/index.js'), ...params], { cwd: directory, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.ifError(result.error); assert.equal(result.signal, null);
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}
const rows = [];
for (const suffix of ['traces.pb', 'json', 'snake.json']) {
  for (const name of ['zero-trace', 'zero-span', 'both-zero', 'valid', 'mixed']) {
    const file = `${name}.${suffix}`, shouldRefuse = name.startsWith('zero') || name === 'both-zero';
    let observed, error;
    try {
      const trace = core.parseTraceInputs([load(file)]), summary = core.buildSummary(trace, []);
      observed = { traceId: trace.traceId, spans: trace.spans.map(span => ({ name: span.name, traceId: span.traceId, spanId: span.spanId })), traces: trace.traces.map(t => ({ traceId: t.traceId, spans: t.spanCount })), inputTokens: summary.modelUsage.reduce((n, row) => n + row.inputTokens, 0), incompleteInput: summary.costReport.incompleteInput ?? false, warnings: trace.warnings };
    } catch (caught) { error = caught.message; }
    const command = cli(['summary', file]);
    const correct = shouldRefuse ? Boolean(error?.includes('No valid spans')) && command.exitCode === 1 && command.stdout === ''
      : !error && observed.traceId === expected[0].traceId && observed.spans.length === expected.length && observed.spans.every(row => expected.some(e => e.spanId === row.spanId && e.name === row.name)) && observed.inputTokens === 20 && observed.incompleteInput === (name === 'mixed') && command.exitCode === 0;
    rows.push({ file, shouldRefuse, correct, observed, error, cli: command });
  }
  const mixed = core.parseTraceInputs([load(`mixed.${suffix}`)], { traceId: expected[0].traceId });
  const valid = core.parseTraceInputs([load(`valid.${suffix}`)]);
  let report, error;
  try { report = core.compareTraces(valid, mixed, []); } catch (caught) { error = caught.message; }
  const command = cli(['compare', '--baseline-file', `valid.${suffix}`, '--candidate-file', `mixed.${suffix}`, '--candidate-trace', expected[0].traceId, '--json']);
  const summary = core.buildSummary(mixed, []);
  rows.push({ file: `mixed.${suffix}`, operation: 'explicit-valid-trace-and-comparison', correct: Boolean(error?.includes('Cannot compare')) && command.exitCode === 1 && command.stdout === '', selectedTrace: mixed.traceId, retainedSpans: mixed.spans.length, inputTokens: summary.modelUsage.reduce((n, row) => n + row.inputTokens, 0), comparison: report ? { calls: report.metrics.calls, inputTokens: report.metrics.inputTokens } : undefined, error, cli: command });
}
const failures = rows.filter(row => !row.correct).length;
writeFileSync(args.out, JSON.stringify({ scope: 'Native SDK exports under an explicitly broken custom ID generator. Independent SDK SpanContext.is_valid observations precede serialization. This is a controlled fault, not a default-SDK incident or a live model call.', node: process.version, oracleSha256: sha(readFileSync(join(directory, 'oracle.json'))), sdkValid: expected.length, sdkInvalid: 5, cases: rows.length, failures, rows }, null, 2) + '\n');
console.log(`${rows.length} native identity/CLI cases; ${failures} disagreements with SDK validity`);
if (args.verify) assert.equal(failures, 0);
