import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const before = 'examples/comparison-baseline.json';
const after = 'examples/comparison-candidate.json';
const run = (...args) =>
  spawnSync(process.execPath, ['dist-cli/cli/index.js', ...args], { cwd: root, encoding: 'utf8' });
test('links CLI retains SDK evidence and selects linked traces without prose on JSON stdout', () => {
  const oracle = JSON.parse(readFileSync(new URL('../examples/queue-links.oracle.json', import.meta.url), 'utf8'));
  const result = run('links', '--json', 'examples/queue-links.json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.format, 'tracelens-span-links');
  assert.equal(report.linkCount, 8);
  assert.equal(report.reportedDroppedLinks, 1);
  assert.equal(report.spans.flatMap((s) => s.links).filter((l) => l.target.status === 'missing-trace').length, 2);
  assert.match(result.stderr, /4 traces/);
  const target = oracle.spans.find((s) => s.name === 'enqueue job 2');
  const selected = run('links', 'examples/queue-links.json', '--trace', target.traceId.slice(0, 8), '--json');
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(JSON.parse(selected.stdout).traceId, target.traceId);
  assert.equal(JSON.parse(selected.stdout).linkCount, 0);
  const text = run('links', 'examples/queue-links.json');
  assert.match(text.stdout, /8 recorded links; 1 reported dropped/);
  assert.match(text.stdout, /Target trace absent/);
  assert.equal(run('links', 'examples/queue-links.json', '--prices', 'prices.json').status, 1);
});
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
test('timing JSON keeps exact interval arithmetic and explains the elapsed-time difference', () => {
  const result = run('timing', before, '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const timing = JSON.parse(result.stdout);
  assert.equal(timing.format, 'tracelens-timing');
  assert.equal(timing.elapsedNs, '6200000000');
  assert.equal(timing.summedSelfNs, '7000000000');
  assert.equal(timing.overlapExcessNs, '800000000');
  assert.equal(timing.bucketsNs.uncovered, '0');
  const compared = JSON.parse(run('compare', before, after, '--json').stdout);
  assert.deepEqual(compared.timing.baseline, timing);
  const text = run('timing', before);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /6\.20 s elapsed = 7\.00 s summed self time - 800\.0 ms overlap excess/);
});
test('SDK-captured requests distinguish parallel work from sequential work', () => {
  const parallel = JSON.parse(run('timing', 'examples/timing-parallel.json', '--json').stdout);
  const sequential = JSON.parse(run('timing', 'examples/timing-sequential.json', '--json').stdout);
  assert.equal(parallel.peakConcurrency, 3);
  assert.equal(sequential.peakConcurrency, 1);
  assert.ok(BigInt(parallel.overlapExcessNs) > 0n);
  assert.equal(sequential.overlapExcessNs, '0');
  for (const timing of [parallel, sequential]) {
    assert.equal(timing.bucketsNs.uncovered, '0');
    assert.equal(BigInt(timing.summedSelfNs) - BigInt(timing.overlapExcessNs), BigInt(timing.elapsedNs));
  }
});

// Files as the OpenTelemetry Collector's file exporter writes them: an export per line, and
// every trace that passed through it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after as afterAll } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'tracelens-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const nanoTrace = 'tests/fixtures/census/vercel-ai-sdk-6-openai-responses-stream.json';
test('cost CLI explains a real recorded call and agrees with the comparison export', () => {
  const result = run('cost', nanoTrace, '--json');
  assert.equal(result.status, 0, result.stderr);
  const cost = JSON.parse(result.stdout);
  assert.equal(cost.format, 'tracelens-cost-evidence');
  assert.equal(cost.pricedCalls, 1);
  assert.equal(cost.excludedSpans, 1);
  assert.ok(Math.abs(cost.estimatedCostUsd - 0.00081907) < 1e-12);
  const comparison = JSON.parse(run('compare', nanoTrace, nanoTrace, '--json').stdout);
  assert.deepEqual(comparison.costEvidence.baseline, cost);
  const text = run('cost', nanoTrace);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Price: gpt-5-nano \(snapshot\)/);
  assert.match(text.stdout, /\$0\.00081907/);
  assert.match(text.stdout, /excluded: not-model-call/);
  assert.doesNotMatch(text.stdout, /ai\.prompt/);
});
test('a custom price file controls cost, summary and comparison without changing browser settings', () => {
  const prices = join(scratch, 'prices with spaces.json');
  writeFileSync(prices, JSON.stringify([{
    id: 'illustrative', matchModel: 'gpt-5-nano', provider: 'openai', inputPerMTok: 2,
    outputPerMTok: 4, cacheReadPerMTok: 1, sourceUrl: '', sourceDate: '2026-10-09',
  }]));
  const cost = JSON.parse(run('cost', '--prices', prices, nanoTrace, '--json').stdout);
  assert.ok(Math.abs(cost.estimatedCostUsd - 0.015642) < 1e-12);
  assert.equal(cost.rows[0].result.entry.id, 'illustrative');
  assert.match(run('summary', nanoTrace, '--prices', prices).stdout, /\$0\.015642/);
  const comparison = JSON.parse(run('compare', nanoTrace, nanoTrace, '--prices', prices, '--json').stdout);
  assert.equal(comparison.metrics.costUsd.baseline.value, cost.estimatedCostUsd);
  for (const bad of ['{}', '[{}]', '{']) {
    writeFileSync(prices, bad);
    const result = run('cost', nanoTrace, '--prices', prices, '--json');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr, '');
  }
});
test('cost CLI keeps unpriced embeddings and exact zero rates distinct', () => {
  const file = 'tests/fixtures/census/openinference-litellm-embedding.json';
  const unknown = JSON.parse(run('cost', file, '--json').stdout);
  assert.equal(unknown.unpricedCalls, 1);
  assert.equal(unknown.knownCostUsd, null);
  const prices = join(scratch, 'zero-price.json');
  writeFileSync(prices, JSON.stringify([{ id: 'zero', matchModel: 'text-embedding-ada-002-v2', provider: '', inputPerMTok: 0, outputPerMTok: 0, sourceUrl: '', sourceDate: '' }]));
  const zero = JSON.parse(run('cost', file, '--prices', prices, '--json').stdout);
  assert.equal(zero.estimatedCostUsd, 0);
  assert.equal(zero.unpricedCalls, 0);
});
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
  assert.match(result.stderr, /No trace in this file has the ID "ffff"\. Available: /);
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

test('multi-file CLI restores SDK parents and compares complete groups', () => {
  const paths = ['worker.json', 'gateway.jsonl', 'audit.jsonl'].map(name => `studies/multifile/fixtures/${name}`);
  const oracle = JSON.parse(readFileSync('studies/multifile/fixtures/oracle.json', 'utf8'));
  for (const command of ['summary', 'tree', 'timing', 'cost', 'links']) {
    const result = run(command, ...paths);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /not present/);
  }
  const links = run('links', ...paths, '--trace', oracle.audit.traceId, '--json');
  assert.equal(links.status, 0, links.stderr);
  const report = JSON.parse(links.stdout);
  assert.equal(report.inputFiles.length, 3);
  assert.equal(report.spans[0].sourceFile.name, paths[2]);
  assert.ok(report.spans[0].links.every(link => link.target.status === 'available'));
  const flags = paths.flatMap(path => ['--baseline-file', path, '--candidate-file', path]);
  const comparison = run('compare', ...flags, '--json');
  assert.equal(comparison.status, 0, comparison.stderr);
  const compared = JSON.parse(comparison.stdout);
  assert.equal(compared.wallTimeMs.delta, 0);
  assert.equal(compared.metrics.calls.delta, 0);
  assert.equal(compared.metrics.calls.baseline.value, 7);
  assert.deepEqual(compared.inputFiles.baseline, compared.inputFiles.candidate);
  assert.ok(compared.operations.flatMap(op => op.baselineCalls).every(call => call.sourceFile));
  for (const args of [['compare', '--baseline-file', paths[0]], ['compare', ...flags, paths[0]],
    ['links', ...paths, paths[0], '--json']]) {
    const bad = run(...args);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
  }
});
test('logs joins separately exported SDK message records and retains their source', () => {
  const root = 'studies/log-events/capture-event-only/';
  const result = run('logs', root + 'traces.json', root + 'logs.json', '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.format, 'tracelens-log-evidence');
  assert.equal(report.matchedRecords, 2);
  assert.deepEqual(report.unmatched, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.spans[0].inputMessages[0].parts[0].content, 'Compute the SHA-256 of receipt-17.');
  assert.equal(report.spans[0].outputMessages[0].parts[0].name, 'sha256');
  assert.equal(report.spans[0].logs[0].source.file.name, root + 'logs.json');
  assert.equal(report.spans[0].logs[0].timeUnixNano, undefined);
  assert.equal(typeof report.spans[0].logs[0].observedTimeUnixNano, 'string');
});

test('logs reads the combined SDK example and asks for traces when only logs were selected', () => {
  const result = run('logs', 'examples/genai-log-events.jsonl');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 matched records/);
  assert.match(result.stdout, /line 1, resourceLogs/);
  const alone = run('logs', 'studies/log-events/capture-event-only/logs.json', '--json');
  assert.equal(alone.status, 1);
  assert.match(alone.stderr, /Select a trace export/);
  assert.equal(alone.stdout, '');
});
