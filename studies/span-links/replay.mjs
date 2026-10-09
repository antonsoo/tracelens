// Read the SDK oracle independently of the importer. Run against either the
// before-build or an installed package's compiled core, never TS source magic.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const [corePath, output, captureDirectory] = process.argv.slice(2);
if (!corePath || !output) throw new Error('Usage: node studies/span-links/replay.mjs <compiled-core/index.js> <output.json> [capture-directory]');
const core = await import(pathToFileURL(resolve(corePath)).href);
const capture = captureDirectory ? pathToFileURL(resolve(captureDirectory) + '/') : new URL('../../examples/', import.meta.url);
const bytes = await readFile(new URL('queue-links.json', capture));
const oracle = JSON.parse(await readFile(new URL('queue-links.oracle.json', capture), 'utf8'));
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (sha256 !== oracle.sha256) throw new Error('SDK capture no longer matches its oracle');
const sdk = { spans: oracle.spans.length, expectedLinks: 0, observedLinks: 0, mismatchedSpans: [], upstreamTraceStateOmissions: 0 };
for (const record of oracle.spans) {
  const trace = core.parseTraceText(bytes.toString(), { traceId: record.traceId });
  const span = trace.spans.find((s) => s.spanId === record.spanId);
  const expected = record.links.map(({ traceState, ...link }) => link);
  const observed = (span.links ?? []).map((link) => ({ traceId: link.traceId, spanId: link.spanId,
    attributes: link.attributes, droppedAttributesCount: link.droppedAttributesCount ?? 0, targetName: link.target?.name ?? null }));
  sdk.expectedLinks += expected.length;
  sdk.observedLinks += observed.length;
  if (JSON.stringify(expected) !== JSON.stringify(observed) || record.droppedLinksCount !== (span.droppedLinksCount ?? 0)) sdk.mismatchedSpans.push(record.name);
  sdk.upstreamTraceStateOmissions += record.links.filter((link) => link.traceState).length;
}

const tid = (n) => n.toString(16).padStart(32, '0');
const sid = (n) => n.toString(16).padStart(16, '0');
const span = (t, s, name) => ({ traceId: tid(t), spanId: sid(s), name,
  startTimeUnixNano: '1790000000000000000', endTimeUnixNano: '1790000000001000000' });
const doc = (spans) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
const controls = { cases: 0, identityFailures: 0, metadataFailures: 0, timingChanges: 0, jaegerFalseParents: 0, jaegerReferenceLoss: 0 };
// Same span IDs recur in separate traces, with missing spans and missing traces.
// Rotate input/export order; use normal OTLP and Collector JSON Lines.
for (let i = 1; i <= 200; i++) {
  const selected = span(i, 1, 'consumer');
  const links = [
    { traceId: tid(i + 1000), spanId: sid(1), attributes: [{ key: 'job', value: { intValue: String(i) } }], flags: 0x80000301, traceState: 'capture=control', droppedAttributesCount: 2 },
    { traceId: tid(i), spanId: sid(2) },
    { traceId: tid(i + 1000), spanId: sid(3) },
    { traceId: tid(i + 2000), spanId: sid(1) },
  ];
  const rows = [selected, span(i, 2, 'same-trace target'), span(i + 1000, 1, 'cross-trace target')];
  if (i % 2) rows.reverse();
  const plain = core.parseOtlpJson(doc(rows), { traceId: tid(i) });
  selected.links = links;
  selected.droppedLinksCount = 7;
  for (const asLines of [false, true]) {
    const text = asLines ? rows.map((row) => JSON.stringify(doc([row]))).join('\n') : JSON.stringify(doc(rows));
    const parsed = core.parseTraceText(text, { traceId: tid(i) });
    const consumer = parsed.spans.find((s) => s.name === 'consumer');
    controls.cases++;
    const targets = (consumer.links ?? []).map((link) => [link.target?.status, link.target?.name ?? null]);
    if (!isDeepStrictEqual(targets, [['available', 'cross-trace target'], ['available', 'same-trace target'], ['missing-span', null], ['missing-trace', null]])) controls.identityFailures++;
    const first = consumer.links?.[0];
    if (first?.flags !== 0x80000301 || first?.traceState !== 'capture=control' || first?.droppedAttributesCount !== 2 || first?.attributes.job !== i || consumer.droppedLinksCount !== 7) controls.metadataFailures++;
    if (!isDeepStrictEqual(core.buildTiming(parsed), core.buildTiming(plain))) controls.timingChanges++;
  }
  // Native Jaeger references: the preferred parent is in another trace, and
  // a different local span happens to reuse that same span ID.
  const toJaeger = (s) => ({ traceID: s.traceId, spanID: s.spanId, operationName: s.name, startTime: 100, duration: 1 });
  const native = { data: [{ traceID: tid(i), spans: [toJaeger(selected), toJaeger(rows.find((r) => r.name === 'same-trace target'))] },
    { traceID: tid(i + 1000), spans: [{ ...toJaeger(rows.find((r) => r.name === 'cross-trace target')), spanID: sid(2) }] }] };
  native.data[0].spans[0].references = [
    { refType: i % 2 ? 'CHILD_OF' : 'FOLLOWS_FROM', traceID: tid(i + 1000), spanID: sid(2) },
    { refType: 'FOLLOWS_FROM', traceID: tid(i + 3000), spanID: sid(4) },
  ];
  const consumer = core.parseOtlpJson(native, { traceId: tid(i) }).spans.find((s) => s.name === 'consumer');
  controls.cases++;
  if (consumer.parentSpanId !== undefined) controls.jaegerFalseParents++;
  if (consumer.links?.length !== 2 || consumer.links[0].target?.name !== 'cross-trace target') controls.jaegerReferenceLoss++;
}
const outputData = { runtime: process.version, captureSha256: sha256, sdk, controls };
await writeFile(output, JSON.stringify(outputData, null, 2) + '\n');
console.log(JSON.stringify(outputData));

if (sdk.mismatchedSpans.length || sdk.expectedLinks !== sdk.observedLinks ||
    Object.entries(controls).some(([key, value]) => key !== 'cases' && value !== 0)) {
  throw new Error('Span-link replay disagrees with SDK evidence or identity controls; see output report');
}
