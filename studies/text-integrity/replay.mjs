// node replay.mjs CLI_PATH SCRATCH_DIR RECEIPT.json [--baseline]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [cliArg, scratchArg, output, mode] = process.argv.slice(2);
const cli = resolve(cliArg), scratch = resolve(scratchArg), baseline = mode === '--baseline';
mkdirSync(scratch, { recursive: true });
const manifest = readFileSync(new URL('./cases.json', import.meta.url));
const cases = JSON.parse(manifest).cases;
const hash = data => createHash('sha256').update(data).digest('hex');
const control = cases.find(c => c.id === 'otlp-utf-8-unicode');
writeFileSync(resolve(scratch, 'control.json'), Buffer.from(control.base64, 'base64'));
const rows = [];
for (const c of cases) {
  const bytes = Buffer.from(c.base64, 'base64');
  assert.equal(hash(bytes), c.sha256);
  writeFileSync(resolve(scratch, 'input.json'), bytes);
  if (c.valid && c.format !== 'prices') writeFileSync(resolve(scratch, 'reference.json'), c.decoded);
  const args = c.format === 'prices' ? ['cost', 'control.json', '--prices', 'input.json', '--json']
    : ['compare', c.valid ? 'reference.json' : 'control.json', 'input.json', '--json'];
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: scratch, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  let report;
  if (result.status === 0) report = JSON.parse(result.stdout);
  const matches = c.valid ? result.status === 0 && (c.format === 'prices' || (
    report.operations.every(o => o.status === 'matched') && report.metrics.calls.delta === 0 &&
    report.operations.every(o => o.baselineCalls[0].name === o.candidateCalls[0].name)
  )) : result.status === 1 && result.stdout === '' && /Invalid UTF-(8|16LE|16BE) text\. Re-export/.test(result.stderr);
  rows.push({ id: c.id, valid: c.valid, exit: result.status, stderr: result.stderr,
    stdoutBytes: Buffer.byteLength(result.stdout), stdoutSha256: hash(result.stdout),
    operations: report?.operations?.map(o => ({ path: o.path, status: o.status })), matches });
}
for (const [name, id] of [['a.json', 'otlp-utf-8-continuation-80'], ['b.json', 'otlp-utf-8-continuation-81']]) {
  writeFileSync(resolve(scratch, name), Buffer.from(cases.find(c => c.id === id).base64, 'base64'));
}
const collision = spawnSync(process.execPath, [cli, 'compare', 'a.json', 'b.json', '--json'], { cwd: scratch, encoding: 'utf8' });
const receipt = { synthetic: true, node: process.version, baseline, manifestSha256: hash(manifest),
  matches: rows.filter(r => r.matches).length, total: rows.length, rows,
  distinctDamagedNames: { exit: collision.status, stderr: collision.stderr,
    report: collision.stdout ? JSON.parse(collision.stdout) : null } };
writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(`${receipt.matches}/${receipt.total} expected CLI outcomes; damaged-name comparison exit ${collision.status}`);
if (!baseline) { assert.ok(rows.every(r => r.matches)); assert.equal(collision.status, 1); }
