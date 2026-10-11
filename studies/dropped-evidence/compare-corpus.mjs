// Compare the retained parsed evidence, ignoring only the new omission counters
// and their warnings. Non-trace metadata must reject identically.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { before: { type: 'string' }, current: { type: 'string' }, output: { type: 'string' } } });
assert(values.before && values.current && values.output, '--before, --current and --output are required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const old = await import(pathToFileURL(resolve(values.before, 'core/index.js')).href);
const current = await import(pathToFileURL(resolve(values.current, 'core/index.js')).href);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item instanceof Map ? [...item] : item);
async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) found.push(...await files(child));
    else if (/\.jsonl?$/.test(entry.name)) found.push(child);
  }
  return found.sort();
}
function withoutOmissions(trace) {
  const cleanSpan = (span) => {
    const { droppedAttributesCount: _attributes, droppedEventsCount: _events, ...rest } = span;
    return { ...rest, children: span.children.map(cleanSpan), events: span.events.map(({ droppedAttributesCount: _count, ...event }) => event) };
  };
  return { ...trace, spans: trace.spans.map(cleanSpan), roots: trace.roots.map(cleanSpan),
    warnings: trace.warnings.filter(w => !/reports \d+ dropped (?:events|attributes);/.test(w.message)) };
}
function inspect(core, text) {
  try {
    const parsed = core.parseTraceText(text);
    const traces = parsed.traces.map(({ traceId }) => core.parseTraceText(text, { traceId }));
    return { accepted: true, traces: traces.length, spans: traces.reduce((n, t) => n + t.spans.length, 0), result: canonical(traces.map(withoutOmissions)), omissionWarnings: traces.flatMap(t => t.warnings).filter(w => /reports \d+ dropped (?:events|attributes);/.test(w.message)).length };
  } catch (error) { return { accepted: false, traces: 0, spans: 0, result: error.message }; }
}
const rows = [];
for (const path of [...await files(join(root, 'examples')), ...await files(join(root, 'tests/fixtures'))]) {
  const bytes = await readFile(path);
  const before = inspect(old, bytes.toString());
  const after = inspect(current, bytes.toString());
  rows.push({ file: relative(root, path), bytes: bytes.length, source_sha256: hash(bytes),
    unchanged: before.result === after.result && before.accepted === after.accepted, omissionWarnings: after.omissionWarnings ?? 0, accepted: after.accepted, traces: after.traces, spans: after.spans,
    before_sha256: hash(before.result), after_sha256: hash(after.result) });
}
const report = { node: process.version, driver_sha256: hash(await readFile(fileURLToPath(import.meta.url))),
  files: rows.length, traces: rows.reduce((n, row) => n + row.traces, 0), spans: rows.reduce((n, row) => n + row.spans, 0),
  unchanged: rows.filter((row) => row.unchanged).length, omissionWarnings: rows.reduce((n, row) => n + row.omissionWarnings, 0), cases: rows };
await mkdir(dirname(resolve(values.output)), { recursive: true });
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.unchanged}/${report.files} file outcomes unchanged; ${report.traces} traces, ${report.spans} spans`);
if (report.unchanged !== report.files) process.exitCode = 1;
