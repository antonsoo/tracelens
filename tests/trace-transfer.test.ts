import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseOtlpJson, parseTraceText } from '../src/core/otlp-parser.js';
import { buildSummary } from '../src/core/summary.js';
import { compareTraces } from '../src/core/compare.js';
import { flattenTrace, restoreTrace } from '../src/web/trace-transfer.js';
import { fakeSpan, otlpDoc } from './fixtures.js';

it('keeps source order for roots and siblings with identical timestamps', () => {
  const spans = Array.from({ length: 126 }, (_, i) => fakeSpan({ spanId: String(i), startNs: 0, endNs: 1 }));
  expect(parseOtlpJson(otlpDoc(spans)).roots.map((span) => span.spanId)).toEqual(spans.map((span) => span.spanId));
  for (const child of spans.slice(1)) Object.assign(child, { parentSpanId: '0' });
  expect(parseOtlpJson(otlpDoc(spans)).roots[0]!.children.map((span) => span.spanId)).toEqual(spans.slice(1).map((span) => span.spanId));
});

it('does not infer retries from the file order of instantaneous equal-start calls', () => {
  const attributes = [{ key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } }];
  const failed = fakeSpan({ spanId: 'failed', name: 'same tool', startNs: 0, endNs: 0, statusCode: 2, attributes });
  const success = fakeSpan({ spanId: 'success', name: 'same tool', startNs: 0, endNs: 0, attributes });
  for (const spans of [[failed, success], [success, failed]]) expect(buildSummary(parseOtlpJson(otlpDoc(spans)), []).retryCount).toBe(0);
  const later = { ...success, startTimeUnixNano: '1', endTimeUnixNano: '2' };
  expect(buildSummary(parseOtlpJson(otlpDoc([failed, later])), []).retryCount).toBe(1);
});

it('transports a 6000-level span graph without recursive cloning or duplicated identities', () => {
  const spans = Array.from({ length: 6000 }, (_, i) => fakeSpan({ spanId: String(i), ...(i ? { parentSpanId: String(i - 1) } : {}), startNs: 0, endNs: 100 }));
  const original = parseOtlpJson(otlpDoc(spans));
  const restored = restoreTrace(structuredClone(flattenTrace(original)));
  expect(restored.roots[0]).toBe(restored.spans[0]);
  for (let i = 1; i < restored.spans.length; i++) expect(restored.spans[i - 1]!.children[0]).toBe(restored.spans[i]);
  expect(restored.spans.at(-1)!.depth).toBe(5999);
  expect(restored.spans.at(-1)!.durationNs).toBe(100n);
});

it('keeps summary and comparison evidence identical after actual structured cloning', () => {
  const traces = ['baseline', 'candidate'].map((side) => parseTraceText(readFileSync(new URL(`../examples/comparison-${side}.json`, import.meta.url), 'utf8')));
  const copies = traces.map((trace) => restoreTrace(structuredClone(flattenTrace(trace))));
  for (let i = 0; i < traces.length; i++) expect(buildSummary(copies[i]!, [])).toEqual(buildSummary(traces[i]!, []));
  expect(compareTraces(copies[0]!, copies[1]!, [])).toEqual(compareTraces(traces[0]!, traces[1]!, []));
});
