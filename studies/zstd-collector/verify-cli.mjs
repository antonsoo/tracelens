import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [node, cli, output] = process.argv.slice(2);
assert(node && cli && output, 'Usage: verify-cli.mjs NODE_EXECUTABLE INSTALLED_CLI OUTPUT_DIR');
const here = fileURLToPath(new URL('.', import.meta.url));
const run = (...args) => spawnSync(node, [resolve(cli), ...args], { encoding: 'utf8' });
const omit = (value, fields) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
const normalizeLog = log => ({ ...log, source: { ...log.source, file: omit(log.source.file, ['name']) } });
const normalize = report => ({ ...report,
  inputFiles: report.inputFiles.map(file => omit(file, ['name', 'compression'])),
  spans: report.spans.map(span => ({ ...span, logs: span.logs.map(normalizeLog) })),
  unmatched: report.unmatched.map(normalizeLog),
});
const pairs = [];
for (const mode of ['legacy', 'native']) for (const format of ['json', 'proto']) {
  const names = format === 'json' ? ['traces.jsonl', 'logs.jsonl'] : ['traces.traces.otlp', 'logs.logs.otlp'];
  const reports = [false, true].map(compressed => {
    const result = run('logs', ...names.map(name => join(here, 'fixtures', mode, name + (compressed ? '.zst' : ''))), '--json');
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.matchedRecords, 2);
    if (compressed) assert(report.inputFiles.every(file => file.compression.format === 'zstd'));
    return normalize(report);
  });
  assert.deepEqual(reports[1], reports[0]);
  pairs.push({ mode, format, completeLogReportMatchesPlain: true,
    normalizedReportSha256: createHash('sha256').update(JSON.stringify(reports[1])).digest('hex') });
}
const controls = JSON.parse(await readFile(join(here, 'controls/oracle.json')));
const refusals = [];
for (const row of controls.cases.filter(row => row.expected !== 'accept')) {
  const result = run('summary', join(here, 'controls', row.file));
  assert.equal(result.status, 1, row.file);
  assert.equal(result.stdout, '', row.file);
  assert.match(result.stderr, /Zstandard:/);
  refusals.push({ file: row.file, exitCode: result.status, stdoutBytes: 0 });
}
const version = spawnSync(node, ['--version'], { encoding: 'utf8' });
assert.equal(version.status, 0, version.stderr);
await mkdir(output, { recursive: true });
await writeFile(join(output, 'cli.json'), JSON.stringify({ node: version.stdout.trim(),
  scope: 'Actual installed CLI executable. Complete paired log reports agree, excluding only documented transport names/compression. Source paths and line evidence otherwise retained. Malformed input exits without partial stdout.', pairs, refusals }, null, 2) + '\n');
console.log(JSON.stringify({ pairedReports: pairs.length, refusals: refusals.length, node: version.stdout.trim() }));
