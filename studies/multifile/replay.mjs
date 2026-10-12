import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  core: { type: 'string', default: 'dist-cli/core/index.js' },
  cli: { type: 'string', default: 'dist-cli/cli/index.js' },
  output: { type: 'string' },
} });
const core = await import(pathToFileURL(resolve(args.core)));
const directory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const oracle = JSON.parse(await readFile(join(directory, 'oracle.json')));
const files = [];
for (const input of oracle.files) {
  const content = await readFile(join(directory, input.name));
  assert.equal(createHash('sha256').update(content).digest('hex'), input.sha256);
  files.push({ name: input.name, text: content.toString() });
}
const individual = files.map(input => {
  const trace = core.parseTraceText(input.text);
  return { name: input.name, traceId: trace.traceId, spans: trace.spans.length, roots: trace.roots.length,
    warnings: trace.warnings, links: core.buildLinksReport(trace) };
});
const combined = [];
if (core.parseTraceInputs) {
  for (const id of [oracle.run.traceId, oracle.audit.traceId]) {
    const trace = core.parseTraceInputs(files, { traceId: id });
    const expected = oracle.spans.filter(span => span.traceId === id);
    assert.equal(trace.spans.length, expected.length);
    assert.equal(trace.roots.length, 1);
    assert.equal(trace.warnings.length, 0);
    for (const span of trace.spans) {
      const sdk = expected.find(other => other.spanId === span.spanId);
      assert.ok(sdk);
      assert.equal(span.name, sdk.name);
      assert.equal(span.startTimeUnixNano.toString(), sdk.startTimeUnixNano);
      assert.equal(span.endTimeUnixNano.toString(), sdk.endTimeUnixNano);
      assert.equal(span.parentSpanId ?? null, sdk.parentSpanId);
      assert.equal(span.resourceAttributes['service.name'], sdk.service);
      assert.deepEqual(JSON.parse(JSON.stringify(span.attributes)), sdk.attributes);
      assert.deepEqual((span.links ?? []).map(link => ({ traceId: link.traceId, spanId: link.spanId })), sdk.links);
      for (const link of span.links ?? []) assert.equal(link.target.status, 'available');
    }
    combined.push({ traceId: id, spans: trace.spans.length, roots: trace.roots.length,
      warnings: trace.warnings, links: core.buildLinksReport(trace) });
  }
}
const cli = spawnSync(process.execPath, [resolve(args.cli), 'links', ...files.map(file => file.name), '--trace', oracle.audit.traceId, '--json'], { encoding: 'utf8', cwd: directory });
if (core.parseTraceInputs) {
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), JSON.parse(JSON.stringify(combined[1].links)));
} else assert.notEqual(cli.status, 0);
const result = { input: 'Controlled real SDK capture over loopback HTTP and a local Queue; no model calls',
  sdkSpanCount: oracle.spans.length, individual, combinedImportAvailable: !!core.parseTraceInputs, combined,
  cli: { status: cli.status, stdout: cli.stdout, stderr: cli.stderr.replaceAll(directory, '<fixtures>') } };
if (args.output) await writeFile(args.output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ individual: individual.map(({ name, spans, roots }) => ({ name, spans, roots })),
  combinedImportAvailable: result.combinedImportAvailable, combined: combined.map(({ traceId, spans, roots }) => ({ traceId, spans, roots })), cliStatus: cli.status }));
