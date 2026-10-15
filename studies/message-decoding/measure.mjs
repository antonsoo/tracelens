// Controlled import measurements; no remote model, collector, or production traces.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { arch, cpus, platform, totalmem } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { messageWorkload } from './workloads.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const hash = raw => createHash('sha256').update(raw).digest('hex');
const flat = trace => ({ ...trace, roots: trace.roots.map(s => s.spanId),
  spans: trace.spans.map(s => ({ ...s, children: s.children.map(c => c.spanId) })) });
const json = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v);
const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };

if (option('--worker')) {
  const core = await import(pathToFileURL(resolve(option('--module'))));
  const text = readFileSync(option('--worker'), 'utf8');
  let trace;
  const milliseconds = [];
  for (let i = 0; i < 7; i++) {
    trace = null;
    global.gc();
    const start = performance.now();
    trace = core.parseTraceText(text);
    const elapsed = performance.now() - start;
    if (i) milliseconds.push(elapsed); // one unmeasured warmup per fresh process
  }
  const peakRssKiB = process.resourceUsage().maxRSS; // before hashing the full result
  const digest = createHash('sha256');
  for (const span of trace.spans) digest.update(json({ ...span, children: span.children.map(c => c.spanId) }));
  const first = trace.spans.find(s => s.agentKind === 'llm');
  console.log(JSON.stringify({ node: process.version, milliseconds, medianMs: median(milliseconds), peakRssKiB,
    outputSha256: digest.digest('hex'), spans: trace.spans.length,
    inputMessagesPerCall: first.genai.inputMessages?.length ?? 0,
    systemPartsPerCall: first.genai.systemInstructions?.[0]?.parts.length ?? 0 }));
  process.exit(0);
}

assert(option('--before'), 'Expected --before PATH to the baseline compiled core/index.js');
const beforePath = resolve(option('--before')), afterPath = resolve(option('--after') ?? resolve(root, 'dist-cli/core/index.js'));
const before = await import(pathToFileURL(beforePath)), after = await import(pathToFileURL(afterPath));
const out = resolve(option('--out') ?? resolve(here, 'results/node26.json'));
mkdirSync(dirname(out), { recursive: true });
const work = mkdtempSync(resolve(dirname(out), 'measure-'));

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.jsonl?$/.test(path)) yield path;
  }
}
const corpus = [];
for (const path of [...files(resolve(root, 'tests/fixtures')), ...[...files(resolve(root, 'studies'))]
  .filter(path => path.includes('/fixtures/'))]) {
  const text = readFileSync(path, 'utf8');
  const run = core => { try { return { result: flat(core.parseTraceText(text)) }; }
    catch (error) { return { error: { name: error.name, message: error.message } }; } };
  const a = run(before), b = run(after);
  assert.deepEqual(b, a, path);
  corpus.push({ path: path.slice(root.length + 1), inputSha256: hash(text),
    resultSha256: hash(json(a)), outcome: a.error ? 'rejected' : 'parsed' });
}
const measurements = [];
try {
  for (const kind of ['history', 'system']) {
    const text = messageWorkload(kind), path = resolve(work, kind + '.json');
    writeFileSync(path, text);
    if (option('--inputs')) {
      mkdirSync(resolve(option('--inputs')), { recursive: true });
      writeFileSync(resolve(option('--inputs'), kind + '.json'), text);
    }
    const runs = [];
    for (let round = 0; round < 5; round++) {
      const phases = round % 2 ? [['after', afterPath], ['before', beforePath]] : [['before', beforePath], ['after', afterPath]];
      for (const [phase, module] of phases) {
        const result = spawnSync(option('--node') ?? process.execPath,
          ['--expose-gc', fileURLToPath(import.meta.url), '--worker', path, '--module', module],
          { encoding: 'utf8', timeout: 60_000 });
        assert.equal(result.status, 0, result.stderr);
        runs.push({ phase, round, ...JSON.parse(result.stdout) });
      }
    }
    assert.equal(new Set(runs.map(r => r.outputSha256)).size, 1, kind);
    const stats = phase => ({ medianMs: median(runs.filter(r => r.phase === phase).flatMap(r => r.milliseconds)),
      medianPeakRssKiB: median(runs.filter(r => r.phase === phase).map(r => r.peakRssKiB)) });
    const baseline = stats('before'), current = stats('after');
    const observation = { kind, bytes: Buffer.byteLength(text), inputSha256: hash(text), baseline, current,
      timeRatio: current.medianMs / baseline.medianMs, peakRssRatio: current.medianPeakRssKiB / baseline.medianPeakRssKiB, runs };
    measurements.push(observation);
    console.log(JSON.stringify({ kind, bytes: observation.bytes, before: baseline, after: current,
      timeRatio: observation.timeRatio, peakRssRatio: observation.peakRssRatio }));
  }
} finally { rmSync(work, { recursive: true, force: true }); }
writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(),
  machine: { platform: platform(), arch: arch(), logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  note: 'Synthetic OTLP message workloads, no model requests. Each phase uses five fresh processes, one warmup and six timed imports per process. Alternating phase order; GC before each import. RSS is a per-process high-water mark before output hashing, not an allocation count.',
  beforeNormalizeSha256: hash(readFileSync(resolve(dirname(beforePath), 'normalize.js'))),
  afterNormalizeSha256: hash(readFileSync(resolve(dirname(afterPath), 'normalize.js'))),
  corpus, measurements }, null, 2) + '\n');
