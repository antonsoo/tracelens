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
