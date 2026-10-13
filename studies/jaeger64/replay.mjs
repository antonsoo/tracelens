import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  compiled: { type: 'string', default: 'dist-cli' }, output: { type: 'string' },
  'expect-fixed': { type: 'boolean', default: false },
} });
const compiled = resolve(args.compiled);
const { parseTraceInputs, parseOtlpJson } = await import(pathToFileURL(join(compiled, 'core/otlp-parser.js')));
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = name => ({ name: `${name}.json`, text: readFileSync(join(fixtures, `${name}.json`), 'utf8') });
const gateway = load('gateway.jaeger'), worker = load('worker.otlp'), audit = load('audit.otlp');
const inputs = [gateway, worker, audit], control = [load('gateway.otlp'), worker, audit];
const short = '1234567890abcdef', full = short.padStart(32, '0');
const auditId = 'a'.repeat(32);
const results = [];
function check(name, run) {
  try { results.push({ name, correct: true, observed: run() }); }
  catch (error) { results.push({ name, correct: false, error: error.message }); }
}
function shape(trace) {
  return { traceId: trace.traceId, roots: trace.roots.map(span => span.spanId),
    spans: trace.spans.map(span => ({ traceId: span.traceId, spanId: span.spanId,
      parentSpanId: span.parentSpanId, name: span.name, depth: span.depth,
      start: String(span.startTimeUnixNano), end: String(span.endTimeUnixNano),
      attributes: span.attributes, service: span.resourceAttributes['service.name'],
      links: span.links })).sort((a, b) => a.spanId.localeCompare(b.spanId)) };
}
for (const [name, order] of [['gateway first', inputs], ['worker first', [worker, audit, gateway]]]) {
  check(`${name}: one complete request`, () => {
    const actual = parseTraceInputs(order);
    assert.deepEqual(shape(actual), shape(parseTraceInputs(control)));
    assert.equal(actual.traces.length, 2);
    assert.equal(actual.warnings.length, 0);
    return shape(actual);
  });
}
for (const traceId of [short, short.toUpperCase(), full, Buffer.from(full, 'hex').toString('base64')]) {
  check(`select ${traceId}`, () => {
    const trace = parseTraceInputs(inputs, { traceId });
    assert.equal(trace.traceId, full);
    assert.equal(trace.spans.length, 3);
    return { traceId: trace.traceId, spans: trace.spans.length };
  });
}
check('audit links find gateway and worker', () => {
  const links = parseTraceInputs(inputs, { traceId: auditId }).spans[0].links;
  assert.deepEqual(links.map(link => link.target.status), ['available', 'available']);
  return links;
});
check('mixed-format duplicate is rejected', () => {
  assert.throws(() => parseTraceInputs([gateway, load('gateway.otlp')]), /Duplicate span identity/);
  return 'rejected';
});
check('single Jaeger document rejects aliases of one span', () => {
  const doc = JSON.parse(gateway.text);
  doc.data[0].spans.push({ ...doc.data[0].spans[0], traceID: full });
  assert.throws(() => parseOtlpJson(doc), /Duplicate span IDs/);
  return 'rejected';
});
check('Jaeger parent reference uses equivalent padded ID', () => {
  const doc = JSON.parse(gateway.text);
  doc.data[0].spans.push({ ...doc.data[0].spans[0], spanID: '0000000000000002',
    references: [{ refType: 'CHILD_OF', traceID: full, spanID: '0000000000000001' }] });
  const trace = parseOtlpJson(doc);
  assert.equal(trace.roots.length, 1);
  assert.equal(trace.roots[0].children.length, 1);
  assert.equal(trace.spans[1].links[0].target.status, 'available');
  return shape(trace);
});
check('nonzero high word is a different trace', () => {
  const doc = JSON.parse(gateway.text);
  doc.data[0].spans.push({ ...doc.data[0].spans[0], traceID: `1111111111111111${short}` });
  const trace = parseOtlpJson(doc);
  assert.equal(trace.traces.length, 2);
  assert.equal(trace.spans.length, 1);
  return trace.traces.map(trace => trace.traceId);
});
function cli(command, files, extra = []) {
  const argv = [join(compiled, 'cli/index.js'), command, ...files.map(input => input.name), ...extra];
  const run = spawnSync(process.execPath, argv, { encoding: 'utf8', cwd: fixtures });
  assert.ifError(run.error);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
const observations = {};
for (const command of ['summary', 'tree', 'timing', 'cost']) {
  observations[command] = cli(command, inputs, ['tree', 'summary'].includes(command) ? [] : ['--json']);
  check(`CLI ${command}: same report as canonical OTLP control`, () => {
    const expected = cli(command, control, ['tree', 'summary'].includes(command) ? [] : ['--json']);
    assert.equal(observations[command].status, 0);
    // The summary's first line is its input filenames. Compare all report
    // content after that header; the other three commands have no such header.
    const content = text => command === 'summary' ? text.slice(text.indexOf('\n') + 1) : text;
    assert.equal(content(observations[command].stdout), content(expected.stdout));
    return observations[command];
  });
}
observations.links = cli('links', inputs, ['--trace', auditId, '--json']);
check('CLI links exports both available targets', () => {
  assert.equal(observations.links.status, 0);
  const report = JSON.parse(observations.links.stdout);
  assert.deepEqual(report.spans[0].links.map(link => link.target.status), ['available', 'available']);
  return report;
});
observations.duplicate = cli('tree', [gateway, load('gateway.otlp')]);
check('CLI duplicate exits with an error', () => {
  assert.equal(observations.duplicate.status, 1);
  assert.match(observations.duplicate.stderr, /Duplicate span identity/);
  return observations.duplicate;
});
const report = { node: process.version, fixtures: [...inputs, control[0]].map(input => ({
  name: input.name, bytes: Buffer.byteLength(input.text), sha256: createHash('sha256').update(input.text).digest('hex'),
})), correct: results.filter(result => result.correct).length, total: results.length, results, observations };
if (args.output) writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
console.log(`${report.correct}/${report.total} identity and report checks correct`);
if (args['expect-fixed']) assert.equal(report.correct, report.total, results.filter(result => !result.correct).map(result => `${result.name}: ${result.error}`).join('\n'));
