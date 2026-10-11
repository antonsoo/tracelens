import { describe, expect, it } from 'vitest';
import { parseOtlpJson } from '../src/core/otlp-parser.js';
import { fakeSpan, otlpDoc } from './fixtures.js';

const span = (spanID: string, extra: Record<string, unknown> = {}) => ({ spanID, operationName: spanID, startTime: 1700000000000000, duration: 100, ...extra });
const trace = (spans: unknown[], traceID = 'abc') => ({ traceID, spans, processes: {} });
const doc = (extra: Record<string, unknown>) => ({ data: [trace([span('valid'), span('affected', extra)])] });

describe('Jaeger timestamp conversion', () => {
  it.each([undefined, null, -1, 1.5, 'unknown', Number.MAX_SAFE_INTEGER + 1])('skips unknown/invalid duration %j instead of measuring zero', duration => {
    const parsed = parseOtlpJson(doc({ duration }));
    expect(parsed.spans.map(s => s.spanId)).toEqual(['valid']);
    expect(parsed.warnings).toEqual([expect.objectContaining({ spanId: 'affected', traceId: 'abc', message: expect.stringContaining('invalid timestamps') })]);
    expect(parsed.warnings[0]!.message).not.toContain('clock skew');
  });
  it.each([undefined, null, '100000000000000000', Number.MAX_SAFE_INTEGER + 1])('never falls back to raw microseconds for invalid start %j', startTime => {
    expect(parseOtlpJson(doc({ startTime })).spans.map(s => s.spanId)).toEqual(['valid']);
  });
  it.each([0, '0', 100, '100'])('retains measured duration %j in the correct units', duration => {
    const parsed = parseOtlpJson(doc({ duration }));
    expect(parsed.spans.find(s => s.spanId === 'affected')!.durationNs).toBe(BigInt(duration) * 1000n);
    expect(parsed.warnings).toEqual([]);
  });
  it('keeps representable decimal strings exact and skips an overflowing end', () => {
    const parsed = parseOtlpJson({ data: [trace([span('max', { startTime: '18446744073709551', duration: 0 }), span('overflow', { startTime: '18446744073709551', duration: 1 })])] });
    expect(parsed.spans.map(s => s.spanId)).toEqual(['max']);
    expect(parsed.spans[0]!.startTimeUnixNano).toBe(18446744073709551000n);
    expect(parsed.warnings).toHaveLength(1);
  });
  it('rejects an entirely untimed file', () => {
    expect(() => parseOtlpJson({ data: [trace([span('missing', { duration: undefined })])] })).toThrow('No valid spans');
  });
});

it('keeps valid Jaeger logs, rejects unknown times and scopes conversion warnings', () => {
  const broken = span('affected', { logs: [null, 7, { fields: [] }, { timestamp: '100000000000000000' }, { timestamp: 0, fields: [] }, { timestamp: '1700000000000001', fields: [] }] });
  const input = { data: [trace([broken]), trace([span('control')], 'def')] };
  const parsed = parseOtlpJson(input, { traceId: 'abc' });
  expect(parsed.spans[0]!.events.map(e => e.timeUnixNano)).toEqual([0n, 1700000000000001000n]);
  expect(parsed.warnings).toHaveLength(4);
  expect(parsed.warnings.every(w => w.spanId === 'affected' && w.traceId === 'abc')).toBe(true);
  expect(parseOtlpJson(input, { traceId: 'def' }).warnings).toEqual([]);
});

it('rejects non-object OTLP events while preserving the Protobuf default timestamp', () => {
  const parsed = parseOtlpJson(otlpDoc([{ ...fakeSpan({ spanId: 'a', startNs: 0, endNs: 100 }), events: [null, false, [], {}, { name: 'zero', timeUnixNano: '0' }] }]));
  expect(parsed.spans[0]!.events.map(e => [e.name, e.timeUnixNano])).toEqual([['', 0n], ['zero', 0n]]);
  expect(parsed.warnings).toHaveLength(3);
  expect(parsed.warnings.every(w => w.message.includes('non-object'))).toBe(true);
});

it.each([{}, 'missing events', 7])('reports malformed event collections %j instead of an unexplained empty list', events => {
  const otlp = parseOtlpJson(otlpDoc([{ ...fakeSpan({ spanId: 'a', startNs: 1, endNs: 2 }), events }]));
  const jaeger = parseOtlpJson(doc({ logs: events }));
  expect(otlp.warnings[0]!.message).toContain('Invalid events collection');
  expect(jaeger.warnings[0]!.message).toContain('Invalid Jaeger logs collection');
});

it.each([null, undefined, []])('accepts unset or empty event collections %j', events => {
  expect(parseOtlpJson(otlpDoc([{ ...fakeSpan({ spanId: 'a', startNs: 1, endNs: 2 }), events }])).warnings).toEqual([]);
  expect(parseOtlpJson(doc({ logs: events })).warnings).toEqual([]);
});
