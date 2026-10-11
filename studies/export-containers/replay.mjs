// node studies/export-containers/replay.mjs DIST OUTPUT_JSON
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cases, first, second, partial } from './cases.mjs';

const dist = resolve(process.argv[2]);
const output = process.argv[3];
if (!output) throw new Error('Supply DIST OUTPUT_JSON');
const { parseTraceText } = await import(pathToFileURL(`${dist}/core/otlp-parser.js`));
const scratch = await mkdtemp(join(tmpdir(), 'tracelens-containers-'));
const results = [];
try {
  for (const scenario of cases) {
    const file = join(scratch, 'input.json');
    const text = JSON.stringify(scenario.input);
    await writeFile(file, text);
    for (const [index, traceId] of [first, second].entries()) {
      const trace = parseTraceText(text, { traceId });
      const cli = spawnSync(process.execPath, [`${dist}/cli/index.js`, 'timing', file, '--trace', traceId, '--json'], { encoding: 'utf8' });
      if (cli.status !== 0) throw new Error(cli.stderr);
      const timing = JSON.parse(cli.stdout);
      results.push({ name: scenario.name, traceId, retainedSpans: trace.spans.length, warnings: trace.warnings,
        expectedWarningCount: scenario.warnings[index],
        passed: trace.spans.length === 1 && trace.warnings.length === scenario.warnings[index]
          && JSON.stringify(timing.warnings) === JSON.stringify(trace.warnings),
      });
    }
  }
  // Collector-style batches must reach the same diagnostics after joining.
  const jsonl = partial.resourceSpans.map(resource => JSON.stringify({ resourceSpans: [resource] })).join('\n') + '\n';
  const trace = parseTraceText(jsonl, { traceId: second });
  results.push({ name: 'JSON Lines damaged batches', traceId: second, retainedSpans: trace.spans.length,
    warnings: trace.warnings, expectedWarningCount: 4, passed: trace.spans.length === 1 && trace.warnings.length === 4 });
} finally { await rm(scratch, { recursive: true, force: true }); }
const record = { node: process.version,
  parserSha256: createHash('sha256').update(await readFile(`${dist}/core/otlp-parser.js`)).digest('hex'),
  passed: results.filter(row => row.passed).length, total: results.length, results };
await writeFile(output, JSON.stringify(record, null, 2) + '\n');
console.log(`${record.passed}/${record.total} retained-span/diagnostic/CLI cases`);
