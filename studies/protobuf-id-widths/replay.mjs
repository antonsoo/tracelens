// Compare declared binary imports with the retained actual Collector responses.
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
const rows = [];
for (const record of oracle.cases) {
  const bytes = readFileSync(join(directory, record.file)); assert.equal(sha(bytes), record.sha256);
  let accepted = false, error;
  try { core.decodeTraceFile(bytes, record.file); accepted = true; } catch (caught) { error = caught.message; }
  const paths = record.signal === 'logs' ? ['native-control.traces.pb', record.file] : [record.file];
  const result = spawnSync(process.execPath, [join(compiled, 'cli/index.js'), 'tree', ...paths], { cwd: directory, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.ifError(result.error); assert.equal(result.signal, null);
  const correct = accepted === record.collectorAccepted && result.status === (record.collectorAccepted ? 0 : 1) && (record.collectorAccepted || result.stdout === '');
  rows.push({ ...record, importerAccepted: accepted, error, correct, cli: { exitCode: result.status, stdout: result.stdout, stderr: result.stderr } });
}
const failures = rows.filter(row => !row.correct).length;
writeFileSync(args.out, JSON.stringify({ scope: 'Explicit byte-field alterations of retained SDK requests, generic Google wire acceptance and actual Collector responses. Correctness compares signal-specific identity widths, not generic Protobuf validity, opaque legacy JSON labels or an upstream advisory.', node: process.version, decoderSha256: sha(readFileSync(join(compiled, 'core/trace-file.js'))), collectorVersion: oracle.collectorVersion, oracleSha256: sha(readFileSync(join(directory, 'oracle.json'))), cases: rows.length, failures, rows }, null, 2) + '\n');
console.log(`${rows.length} native identity-width / CLI controls; ${failures} disagreements with the Collector`);
if (args.verify) assert.equal(failures, 0);
