import { expect, it } from 'vitest';
import { parseOtlpJson } from '../src/core/otlp-parser.js';
import { buildTiming } from '../src/core/timing.js';
import { buildCostReport } from '../src/core/cost-report.js';
import { fakeSpan, otlpDoc } from './fixtures.js';

const good = (id = 'aa') => otlpDoc([fakeSpan({ traceId: id, spanId: '1', startNs: 0, endNs: 1 })]).resourceSpans[0]!;

it.each([
  [null, 'resourceSpans[1]'], [5, 'resourceSpans[1]'], [[], 'resourceSpans[1]'],
  [{ scopeSpans: {} }, 'resourceSpans[1].scopeSpans'],
  [{ scope_spans: false }, 'resourceSpans[1].scopeSpans'],
  [{ scopeSpans: [null] }, 'resourceSpans[1].scopeSpans[0]'],
  [{ scopeSpans: [[]] }, 'resourceSpans[1].scopeSpans[0]'],
  [{ scopeSpans: [{ spans: {} }] }, 'resourceSpans[1].scopeSpans[0].spans'],
  [{ scopeSpans: [{ spans: false }] }, 'resourceSpans[1].scopeSpans[0].spans'],
])('retains readable spans and diagnoses malformed container %j', (damaged, path) => {
  const input = { resourceSpans: [good(), damaged, good('bb')] };
  for (const traceId of ['aa', 'bb']) {
    const trace = parseOtlpJson(input, { traceId });
    expect(trace.spans).toHaveLength(1);
    expect(trace.warnings).toHaveLength(1);
    expect(trace.warnings[0]!.message).toContain(path);
    expect(trace.warnings[0]!.traceId).toBeUndefined(); // Cannot assign lost evidence to a known trace.
    expect(buildTiming(trace).warnings).toEqual(trace.warnings);
    expect(buildCostReport(trace, []).warnings).toEqual([trace.warnings[0]!.message]);
  }
});

it.each([{}, { scopeSpans: null }, { scopeSpans: [] }, { scope_spans: [] },
  { scopeSpans: [{}, { spans: null }, { spans: [] }] }])('accepts legal empty or unset containers %j', empty => {
  expect(parseOtlpJson({ resourceSpans: [good(), empty] }).warnings).toEqual([]);
});

it('scopes an incomplete span when its trace ID is known', () => {
  const input = otlpDoc([
    fakeSpan({ traceId: 'aa', spanId: '1', startNs: 0, endNs: 1 }),
    fakeSpan({ traceId: 'aa', spanId: '', startNs: 0, endNs: 1 }),
    fakeSpan({ traceId: 'bb', spanId: '1', startNs: 0, endNs: 1 }),
  ]);
  expect(parseOtlpJson(input, { traceId: 'aa' }).warnings[0]).toMatchObject({ traceId: 'aa' });
  expect(parseOtlpJson(input, { traceId: 'bb' }).warnings).toEqual([]);
});

it('does not contaminate another trace with a skipped Jaeger span record', () => {
  const span = { spanID: '1', operationName: 'control', startTime: 1, duration: 1 };
  const input = { data: [{ traceID: 'aa', spans: [null, span] }, { traceID: 'bb', spans: [span] }] };
  expect(parseOtlpJson(input, { traceId: 'aa' }).warnings).toEqual([
    { comparisonIssue: 'span-inventory', message: 'Jaeger spans[0]: skipped a non-object span entry.', traceId: 'aa' },
  ]);
  expect(parseOtlpJson(input, { traceId: 'bb' }).warnings).toEqual([]);
});
