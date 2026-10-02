import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const before = 'examples/comparison-baseline.json';
const after = 'examples/comparison-candidate.json';
const run = (...args) =>
  spawnSync(process.execPath, ['dist-cli/cli/index.js', ...args], { cwd: root, encoding: 'utf8' });
test('CLI emits a versioned JSON report without prose on stdout', () => {
  const result = run('compare', before, after, '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.wallTimeMs.delta, 3400);
  assert.equal(report.operations[0].metrics.selfTimeMs.delta, 1500);
  assert.ok(report.priceTable.length > 0);
  assert.equal(result.stderr, '');
});
test('CLI text explains concurrent work and the direction of changes', () => {
  const result = run('compare', before, after);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /candidate - baseline/);
  assert.match(result.stdout, /concurrent work can exceed wall time/);
  assert.match(result.stdout, /\+3\.40 s/);
});
test('CLI supports --json before filenames', () => {
  assert.equal(JSON.parse(run('compare', '--json', before, after).stdout).wallTimeMs.delta, 3400);
});
for (const args of [
  [before],
  [before, after, '--bogus'],
  [before, after, 'third.json'],
  [before, after, '--json', '--json'],
]) {
  test(`CLI rejects invalid arguments: ${args.join(' ')}`, () => {
    const result = run('compare', ...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  });
}
test('CLI reports a missing file as an error without corrupting JSON stdout', () => {
  const result = run('compare', 'does-not-exist.json', after, '--json');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Can't read/);
});
test('existing summary and tree commands still work', () => {
  for (const command of ['summary', 'tree']) assert.equal(run(command, before).status, 0);
});

// Files as the OpenTelemetry Collector's file exporter writes them: an export per line, and
// every trace that passed through it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after as afterAll } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tracelens-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const oneLine = (path) => JSON.stringify(JSON.parse(readFileSync(join(root, path), 'utf8')));
const genai = JSON.parse(readFileSync(join(root, 'examples/genai-semconv-trace.json'), 'utf8'));
const genaiSpans = genai.resourceSpans[0].scopeSpans[0].spans;
const batch = (spans) =>
  JSON.stringify({ resourceSpans: [{ ...genai.resourceSpans[0], scopeSpans: [{ ...genai.resourceSpans[0].scopeSpans[0], spans }] }] });
const genaiId = genaiSpans[0].traceId;
const baselineId = JSON.parse(oneLine(before)).resourceSpans[0].scopeSpans[0].spans[0].traceId;
const candidateId = JSON.parse(oneLine(after)).resourceSpans[0].scopeSpans[0].spans[0].traceId;

const batched = join(scratch, 'one-run.jsonl');
writeFileSync(batched, [batch(genaiSpans.slice(0, 5)), batch(genaiSpans.slice(5, 11)), batch(genaiSpans.slice(11))].join('\n') + '\n');
const collector = join(scratch, 'collector.jsonl');
writeFileSync(collector, [batch(genaiSpans.slice(0, 9)), oneLine(before), batch(genaiSpans.slice(9)), oneLine(after)].join('\n') + '\n');

test('summary reads a run that the collector wrote as several lines', () => {
  const lines = run('summary', batched);
  const whole = run('summary', 'examples/genai-semconv-trace.json');
  assert.equal(lines.status, 0, lines.stderr);
  // Everything but the first line, which names the file, is the same report.
  assert.equal(lines.stdout.split('\n').slice(1).join('\n'), whole.stdout.split('\n').slice(1).join('\n'));
  assert.equal(run('tree', batched).stdout, run('tree', 'examples/genai-semconv-trace.json').stdout);
});

test('summary of a file with several traces reads the largest and lists the others with their flag', () => {
  const result = run('summary', collector);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`trace ${genaiId}  ·  16 spans`));
  assert.match(result.stdout, new RegExp(`3 traces in this file; showing ${genaiId} \\(invoke_agent incident-analyst, 16 spans, 31\\.80 s\\)`));
  assert.match(result.stdout, new RegExp(`also: ${baselineId} \\(support-agent, 6 spans, [0-9.]+ s\\)   --trace ${baselineId.slice(0, 8)}`));
  assert.match(result.stdout, new RegExp(`also: ${candidateId} .*--trace ${candidateId.slice(0, 8)}`));
});

test('--trace reads another trace, by ID or by the start of one', () => {
  const alone = run('summary', before).stdout.split('\n').slice(2).join('\n');
  for (const id of [baselineId, baselineId.slice(0, 8), baselineId.toUpperCase()]) {
    for (const args of [['summary', collector, '--trace', id], ['summary', '--trace', id, collector]]) {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`3 traces in this file; showing ${baselineId} `));
      assert.equal(result.stdout.split('\n').filter((line) => !/traces in this file|^ {2}also: /.test(line)).slice(2).join('\n'), alone);
    }
  }
  const tree = run('tree', collector, '--trace', candidateId);
  assert.equal(tree.status, 0, tree.stderr);
  assert.equal(tree.stdout.split('\n').slice(3).join('\n'), run('tree', after).stdout);
});

test('--trace with an ID the file does not hold is refused in one line that lists what it holds', () => {
  const result = run('summary', collector, '--trace', 'ffff');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.match(result.stderr, /No trace in this file has the ID "ffff"\. It holds: /);
  assert.ok(result.stderr.includes(genaiId) && result.stderr.includes(baselineId));
});

test('compare reads the two runs out of one collector file', () => {
  const direct = run('compare', before, after, '--json');
  const picked = run('compare', collector, collector, '--baseline-trace', baselineId, '--candidate-trace', candidateId.slice(0, 10), '--json');
  assert.equal(picked.status, 0, picked.stderr);
  assert.equal(picked.stdout, direct.stdout);
  // What was chosen is said on stderr, so that stdout stays the report.
  assert.match(picked.stderr, new RegExp(`3 traces in the baseline, .*collector\\.jsonl; comparing ${baselineId} `));
  assert.match(picked.stderr, new RegExp(`3 traces in the candidate, .*collector\\.jsonl; comparing ${candidateId} `));
  assert.match(picked.stderr, new RegExp(`--candidate-trace ${genaiId.slice(0, 8)}`));
  const text = run('compare', collector, after, '--baseline-trace', baselineId);
  assert.equal(text.stdout, run('compare', before, after).stdout);
});

for (const args of [
  ['summary', collector, '--trace'],
  ['summary', collector, '--trace', '--json'],
  ['summary', collector, '--json'],
  ['summary', collector, 'second.json'],
  ['summary', collector, '--baseline-trace', baselineId],
  ['tree', collector, '--trace', baselineId, '--trace', candidateId],
  ['compare', collector, collector, '--trace', baselineId],
  ['compare', collector, collector, '--baseline-trace'],
]) {
  test(`CLI rejects invalid arguments: ${args.map((a) => (a === collector ? 'collector.jsonl' : a)).join(' ')}`, () => {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: tracelens /);
  });
}

test('a file that is neither JSON nor JSON Lines is refused in one line', () => {
  const broken = join(scratch, 'broken.jsonl');
  writeFileSync(broken, [batch(genaiSpans.slice(0, 5)), '{"resourceSpans": [', batch(genaiSpans.slice(5))].join('\n'));
  const result = run('summary', broken);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /broken\.jsonl": Not valid JSON, and not JSON Lines either: line 2: /);
  const html = join(scratch, 'page.json');
  writeFileSync(html, '<html>\n<body></body>\n</html>\n');
  assert.match(run('tree', html).stderr, /page\.json": Not valid JSON: /);
});

test('names from the trace cannot write escape sequences to the terminal', () => {
  const hostile = structuredClone(genai);
  const spans = hostile.resourceSpans[0].scopeSpans[0].spans;
  spans[0].name = 'agent\u001b]0;owned\u0007\u001b[2J';
  for (const span of spans) {
    for (const attribute of span.attributes ?? []) {
      if (attribute.key === 'gen_ai.request.model' || attribute.key === 'gen_ai.tool.name') attribute.value = { stringValue: `m\u001b[31m${attribute.value.stringValue}\u009b0m` };
    }
  }
  spans[3].startTimeUnixNano = 'bad\u001b[5m';
  spans[3].name = 'skipped\u001b[1m';
  const other = structuredClone(hostile);
  for (const span of other.resourceSpans[0].scopeSpans[0].spans) span.traceId = 'ab'.repeat(16);
  const path = join(scratch, 'hostile.jsonl');
  writeFileSync(path, `${JSON.stringify(hostile)}\n${JSON.stringify(other)}\n`);
  for (const args of [['summary', path], ['tree', path], ['summary', path, '--trace', 'nope\u001b[2J'], ['compare', path, path]]) {
    const result = run(...args);
    const output = result.stdout + result.stderr;
    assert.ok(output.length > 0);
    assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(output), false, `${args.join(' ')}: ${JSON.stringify(output.match(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f].{0,20}/)?.[0])}`);
  }
});
