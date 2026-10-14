// Native SDK controls plus explicitly damaged imports; no live model or collector calls.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function comparisonCases(root) {
  const folder = resolve(root, 'tests/fixtures/census');
  const text = readFileSync(resolve(folder, 'strands-operation-details-events-tool-call.json'), 'utf8');
  const native = JSON.parse(text), clone = () => structuredClone(native);
  const spans = doc => doc.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans));
  const first = doc => spans(doc)[0];
  const cases = [];
  const add = (id, candidate, reject, extra = {}) => cases.push({ id, baseline: text,
    candidate: typeof candidate === 'string' ? candidate : JSON.stringify(candidate), reject,
    scope: 'Constructed variant of a native SDK export', ...extra });
  for (const name of readdirSync(folder).filter(name => name.endsWith('.json')).sort()) {
    const bytes = readFileSync(resolve(folder, name), 'utf8');
    cases.push({ id: `native-${name}`, baseline: bytes, candidate: bytes, reject: false,
      scope: 'Unmodified native SDK census capture' });
  }
  for (const field of ['startTimeUnixNano', 'endTimeUnixNano', 'spanId', 'traceId']) {
    const doc = clone(); delete first(doc)[field]; add(`missing-${field}`, doc, true);
  }
  for (const value of [true, '12.5', '-1']) {
    const doc = clone(); first(doc).endTimeUnixNano = value;
    add(`invalid-end-${String(value)}`, doc, true);
  }
  const reversed = clone(); first(reversed).endTimeUnixNano = String(BigInt(first(reversed).startTimeUnixNano) - 1n);
  add('reversed-interval', reversed, true);
  const parentId = first(native).parentSpanId;
  for (const value of [42, false]) {
    const doc = clone(); first(doc).parentSpanId = value;
    add(`invalid-parent-${String(value)}`, doc, true);
  }
  const orphan = clone();
  for (const resource of orphan.resourceSpans) for (const scope of resource.scopeSpans) {
    scope.spans = scope.spans.filter(span => span.spanId !== parentId);
  }
  add('missing-parent', orphan, true);
  const resource = clone(); resource.resourceSpans.push(false); add('nonobject-resource', resource, true);
  const scope = clone(); scope.resourceSpans[0].scopeSpans.push(null); add('nonobject-scope', scope, true);
  const entry = clone(); entry.resourceSpans[0].scopeSpans[0].spans.push(false); add('nonobject-span', entry, true);
  const badSpans = clone(); badSpans.resourceSpans[0].scopeSpans[0].spans = 'unreadable'; add('nonarray-spans', badSpans, true);
  const badScopes = clone(); badScopes.resourceSpans[0].scopeSpans = false; add('nonarray-scopes', badScopes, true);
  add('truncated-jsonl-tail', JSON.stringify(native) + '\n{"resourceSpans":[', true);
  const other = clone(); for (const span of spans(other)) span.traceId = 'bb'.repeat(16);
  delete first(other).endTimeUnixNano;
  const multitrace = { resourceSpans: [...clone().resourceSpans, ...other.resourceSpans] };
  add('selected-complete-trace', multitrace, false, { candidateTrace: first(native).traceId });
  add('selected-incomplete-trace', multitrace, true, { candidateTrace: 'bb'.repeat(16) });
  const zero = clone(); first(zero).endTimeUnixNano = first(zero).startTimeUnixNano;
  add('recorded-zero-duration', zero, false);
  const events = clone(); first(events).events = [null]; add('optional-event-warning', events, false);
  const dropped = clone(); first(dropped).droppedEventsCount = 5; add('reported-dropped-events', dropped, false);
  add('unrelated-metric-jsonl', JSON.stringify(native) + '\n{"resourceMetrics":[]}\n', false);
  const partition = clone();
  add('resolved-parent-files', partition, false, { candidateParts: [
    JSON.stringify({ resourceSpans: [partition.resourceSpans[0]] }),
    JSON.stringify({ resourceSpans: partition.resourceSpans.slice(1) }),
  ] });

  const jaegerText = readFileSync(resolve(root, 'examples/jaeger-genai-trace.json'), 'utf8');
  const jaeger = JSON.parse(jaegerText);
  const addJaeger = (id, doc, reject, extra = {}) => cases.push({ id, baseline: jaegerText, candidate: JSON.stringify(doc), reject,
    scope: 'Constructed variant of the repository Jaeger example; no Jaeger server replay', ...extra });
  const je = structuredClone(jaeger); je.data[0].spans.push(null); addJaeger('jaeger-nonobject-span', je, true);
  const jt = structuredClone(jaeger); jt.data.push({ traceID: jt.data[0].traceID, spans: false });
  addJaeger('jaeger-unreadable-same-trace', jt, true, { parserReject: true });
  const ju = structuredClone(jaeger); ju.data.push(false); addJaeger('jaeger-unknown-trace-entry', ju, true, { parserReject: true });
  const jf = structuredClone(jaeger), foreign = structuredClone(jaeger.data[0]);
  foreign.traceID = 'bb'.repeat(16);
  for (const span of foreign.spans) span.traceID = 'bb'.repeat(16);
  delete foreign.spans[0].duration;
  jf.data.push(foreign);
  addJaeger('jaeger-unreadable-other-trace', jf, false);
  const jd = structuredClone(jaeger); delete jd.data[0].spans[0].duration;
  addJaeger('jaeger-missing-duration', jd, true);
  return cases;
}
