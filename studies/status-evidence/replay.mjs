// Core and actual console workflow replay. Inputs are an SDK capture plus labelled variants.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1]; };
const cli = resolve(option('--cli') ?? resolve(root, 'dist-cli/cli/index.js'));
const moduleRoot = resolve(dirname(cli), '..');
const core = await import(pathToFileURL(resolve(moduleRoot, 'core/index.js')));
const out = resolve(option('--out') ?? resolve(here, 'results/after.json'));
const oracle = JSON.parse(readFileSync(resolve(here, 'fixtures/oracle.json'), 'utf8'));
const native = JSON.parse(readFileSync(resolve(here, 'fixtures/native-integers.json'), 'utf8'));
const jaeger = JSON.parse(readFileSync(resolve(here, 'fixtures/native-jaeger.json'), 'utf8'));
const errorId = oracle.spans.find(span => span.status === 'ERROR').spanId;
const errorSpan = doc => doc.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)).find(span => span.spanId === errorId);
const hash = value => createHash('sha256').update(value).digest('hex');
const cases = oracle.variants.map(variant => ({ id: variant.name,
  doc: JSON.parse(readFileSync(resolve(here, 'fixtures', variant.file), 'utf8')),
  expected: ['native-integers', 'native-names', 'quoted-integer', 'quoted-leading-zero', 'quoted-signed-integer', 'quoted-surrounding-space'].includes(variant.name) ? 'ERROR' : 'UNKNOWN',
  scope: 'Captured native tool status with one labelled JSON code replacement.',
}));
for (const [id, status, expected] of [
  ['absent', undefined, 'UNSET'], ['null-status', null, 'UNSET'], ['empty-status', {}, 'UNSET'],
  ['null-code', { code: null }, 'UNSET'], ['explicit-unset', { code: 0 }, 'UNSET'],
  ['explicit-ok', { code: 1 }, 'OK'], ['bare-error-alias', { code: 'ERROR' }, 'ERROR'],
  ['array-status', ['STATUS_CODE_ERROR'], 'UNKNOWN'], ['string-status', 'STATUS_CODE_ERROR', 'UNKNOWN'],
  ['number-status', 2, 'UNKNOWN'], ['boolean-status', true, 'UNKNOWN'],
  ['empty-code', { code: '' }, 'UNKNOWN'], ['array-code', { code: [2] }, 'UNKNOWN'],
  ['object-code', { code: { value: 2 } }, 'UNKNOWN'], ['quoted-fraction', { code: '2.0' }, 'UNKNOWN'],
  ['invalid-message-known-error', { code: 2, message: 123 }, 'ERROR'],
  ['null-message-known-error', { code: 2, message: null }, 'ERROR'],
]) {
  const doc = structuredClone(native);
  if (status === undefined) delete errorSpan(doc).status;
  else errorSpan(doc).status = status;
  cases.push({ id, doc, expected, scope: 'Constructed status-shape/default/compatibility control; not a production incident.' });
}
const baseText = JSON.stringify(native);
assert.equal(core.buildSummary(core.parseOtlpJson(native), core.DEFAULT_PRICE_TABLE).errorCount, 1);
for (const [id, tags, expected] of [
  ['jaeger-control', [{ key: 'otel.status_code', type: 'string', value: 'ERROR' }], 'ERROR'],
  ['jaeger-legacy-control', [{ key: 'error', type: 'bool', value: true }], 'ERROR'],
  ['jaeger-lowercase-control', [{ key: 'otel.status_code', type: 'string', value: 'error' }], 'ERROR'],
  ['jaeger-quoted-integer', [{ key: 'otel.status_code', type: 'string', value: '2' }], 'ERROR'],
  ['jaeger-future-code', [{ key: 'otel.status_code', type: 'int64', value: 3 }], 'UNKNOWN'],
  ['jaeger-invalid-code', [{ key: 'otel.status_code', type: 'string', value: 'garbled' }], 'UNKNOWN'],
  ['jaeger-invalid-error', [{ key: 'error', type: 'string', value: 'maybe' }], 'UNKNOWN'],
  ['jaeger-duplicate-codes', [{ key: 'otel.status_code', type: 'string', value: 'ERROR' }, { key: 'otel.status_code', type: 'string', value: 'OK' }], 'UNKNOWN'],
  ['jaeger-duplicate-errors', [{ key: 'error', type: 'bool', value: true }, { key: 'error', type: 'bool', value: false }], 'UNKNOWN'],
  ['jaeger-error-evidence-survives', [{ key: 'otel.status_code', type: 'string', value: 'garbled' }, { key: 'error', type: 'bool', value: true }], 'ERROR'],
  ['jaeger-error-code-survives', [{ key: 'otel.status_code', type: 'string', value: 'ERROR' }, { key: 'error', type: 'string', value: 'maybe' }], 'ERROR'],
]) {
  const doc = structuredClone(jaeger);
  const span = doc.data[0].spans.find(span => span.spanID === errorId);
  span.tags = span.tags.filter(tag => !['otel.status_code', 'error'].includes(tag.key)).concat(tags);
  cases.push({ id, doc, base: jaeger, expected, scope: 'Independently converted SDK capture with labelled Jaeger status-tag replacement.' });
}
const work = mkdtempSync(resolve(option('--work-root') ?? tmpdir(), 'tracelens-status-'));
writeFileSync(resolve(work, 'baseline.json'), baseText);
const records = [];
for (const item of cases) {
  const baseline = core.parseOtlpJson(item.base ?? native);
  writeFileSync(resolve(work, 'baseline.json'), JSON.stringify(item.base ?? native));
  const text = JSON.stringify(item.doc);
  writeFileSync(resolve(work, 'candidate.json'), text);
  const trace = core.parseOtlpJson(item.doc);
  const summary = core.buildSummary(trace, core.DEFAULT_PRICE_TABLE);
  const report = core.compareTraces(baseline, trace, core.DEFAULT_PRICE_TABLE);
  const span = trace.spans.find(span => span.spanId === errorId);
  const unknown = item.expected === 'UNKNOWN';
  const count = item.expected === 'ERROR' ? 1 : 0;
  const needsRaw = unknown || item.id === 'invalid-message-known-error'
    || item.id === 'jaeger-error-evidence-survives' || item.id === 'jaeger-error-code-survives';
  const agrees = span.status.code === item.expected && summary.errorCount === count
    && (summary.unknownStatusCount ?? 0) === (unknown ? 1 : 0)
    && report.metrics.errors.candidate.missing === (unknown ? 1 : 0)
    && report.metrics.errors.delta === (unknown ? null : count - 1)
    && report.metrics.calls.delta === 0 && report.wallTimeMs.delta === 0
    && (!needsRaw || span.status.raw !== undefined)
    && (!unknown || (summary.unknownRetryCount ?? 0) === 1);
  const captures = {};
  for (const [kind, args] of [
    ['compare-json', ['compare', 'baseline.json', 'candidate.json', '--json']],
    ['compare-text', ['compare', 'baseline.json', 'candidate.json']],
    ['summary', ['summary', 'candidate.json']], ['tree', ['tree', 'candidate.json']],
  ]) {
    const result = spawnSync(option('--node') ?? process.execPath, [cli, ...args], {
      cwd: work, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NO_COLOR: '1' },
    });
    assert(!result.error, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    if (kind === 'compare-json') assert.deepEqual(JSON.parse(result.stdout), report);
    captures[kind] = { command: ['tracelens', ...args], exit: result.status,
      stdout: result.stdout, stderr: result.stderr };
  }
  const terminalAgrees = unknown ? /unknown/i.test(captures.summary.stdout)
    && !/no errors/.test(captures.summary.stdout) && /unknown/i.test(captures['compare-text'].stdout) : true;
  records.push({ id: item.id, scope: item.scope, expected: item.expected, inputSha256: hash(text),
    parsedStatus: span.status, warnings: trace.warnings,
    summary: { errors: summary.errorCount, unknownStatuses: summary.unknownStatusCount ?? 0,
      possibleRetries: summary.retryCount, unknownRetries: summary.unknownRetryCount ?? 0 },
    report, captures, agrees: agrees && terminalAgrees });
}
const result = { node: spawnSync(option('--node') ?? process.execPath, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  baselineSha256: hash(baseText), parserSha256: hash(readFileSync(resolve(moduleRoot, 'core/otlp-parser.js'))),
  cases: records.length, consoleWorkflows: records.length * 4,
  disagreements: records.filter(record => !record.agrees).length, records };
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ cases: result.cases, consoleWorkflows: result.consoleWorkflows, disagreements: result.disagreements }));
assert(argv.includes('--observe-only') || result.disagreements === 0);
