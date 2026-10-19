import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [compiled, load, output] = process.argv.slice(2);
assert(compiled && load && output, 'Usage: measure-series.mjs COMPILED_ROOT LOAD_DIR OUTPUT_JSON');
const files = ['traces.jsonl', 'traces.jsonl.zst', 'traces.traces.otlp', 'traces.traces.otlp.zst'];
const temporary = await mkdtemp(join(tmpdir(), 'tracelens-zstd-measure-'));
const runs = [];
try {
  // Fresh processes, with the four carriers interleaved across three rounds.
  for (let round = 0; round < 3; round++) for (const file of files) {
    const receipt = join(temporary, 'run.json');
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./measure-load.mjs', import.meta.url)),
      resolve(compiled), resolve(load), file, receipt,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    runs.push({ round: round + 1, ...JSON.parse(await readFile(receipt, 'utf8')) });
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
assert.equal(new Set(runs.map(row => row.normalizedSpansSha256)).size, 1);
assert.equal(new Set(runs.map(row => row.timingSha256)).size, 1);
const statistics = files.map(file => {
  const group = runs.filter(row => row.file === file);
  const ms = group.map(row => row.totalCoreMs).sort((a, b) => a - b);
  const rss = group.map(row => row.maxRssKiB);
  return { file, freshProcesses: group.length, medianCoreMs: ms[1],
    coreMsRange: [ms[0], ms.at(-1)], maxRssKiBRange: [Math.min(...rss), Math.max(...rss)] };
});
const decoder = JSON.parse(await readFile(new URL('../../scripts/zstd/decoder.json', import.meta.url)));
await writeFile(output, JSON.stringify({
  scope: 'Controlled SDK digest workload on 14-vCPU WSL2 Linux, 48 GB RAM. File I/O, module import and SDK-observation checks excluded from core wall time. RSS includes verification. Background host activity was not isolated. These are descriptive observations, not production/browser latency guarantees.',
  decoder: { version: decoder.version, bytes: decoder.bytes, sha256: decoder.sha256 },
  statistics, runs,
}, null, 2) + '\n');
console.log(JSON.stringify(statistics));
