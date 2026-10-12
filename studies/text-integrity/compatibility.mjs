// Compare complete CLI output on the unchanged, committed example traces.
// node compatibility.mjs BEFORE_CLI AFTER_CLI EXAMPLES_ROOT RECEIPT.json
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [beforeArg, afterArg, rootArg, output] = process.argv.slice(2);
const before = resolve(beforeArg), after = resolve(afterArg), root = resolve(rootArg);
const hash = data => createHash('sha256').update(data).digest('hex');
const rows = [];
for (const name of ['comparison-baseline', 'comparison-candidate', 'cost-nano-stream',
  'genai-semconv-trace', 'jaeger-genai-trace', 'openinference-trace', 'queue-links',
  'timing-parallel', 'timing-sequential']) {
  const file = `examples/${name}.json`, bytes = readFileSync(resolve(root, file));
  for (const command of ['summary', 'tree', 'timing', 'cost', 'links', 'compare']) {
    const args = command === 'compare' ? [command, file, file, '--json']
      : ['summary', 'tree'].includes(command) ? [command, file] : [command, file, '--json'];
    const results = [before, after].map(cli => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' }));
    for (const result of results) { assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); }
    assert.equal(results[0].stdout, results[1].stdout, `${file} ${command} stdout`);
    assert.equal(results[0].stderr, results[1].stderr, `${file} ${command} stderr`);
    rows.push({ file, command, inputBytes: bytes.length, inputSha256: hash(bytes),
      stdoutBytes: Buffer.byteLength(results[1].stdout), stdoutSha256: hash(results[1].stdout),
      stderrSha256: hash(results[1].stderr), identical: true });
  }
}
writeFileSync(output, JSON.stringify({ node: process.version, scope: 'Nine repository examples, mixed synthetic and recorded provenance; see examples/README.md', rows }, null, 2) + '\n');
console.log(`${rows.length} complete CLI outputs unchanged`);
