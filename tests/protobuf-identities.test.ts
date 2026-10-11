import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeId } from '../src/core/identity.js';
import { decodeAnyValue, parseOtlpJson } from '../src/core/otlp-parser.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../studies/protobuf-identities/fixtures/${name}.json`, import.meta.url), 'utf8'));
const first = '00000000000000000000000000000001';
const second = '68000000000000000000000000000001';

describe('real SDK Protobuf JSON identities', () => {
  for (const format of ['proto', 'proto-snake', 'otlp']) {
    it(`${format}: preserves distinct spans, trace selection and cross-trace links`, () => {
      const data = fixture(`all.${format}`);
      const trace = parseOtlpJson(data);
      expect(trace.traceId).toBe(first);
      expect(trace.traces.map((t) => [t.traceId, t.spanCount])).toEqual([[first, 2], [second, 2]]);
      expect(trace.spans.map((s) => s.spanId).sort()).toEqual(['0000000000000001', '6800000000000001']);
      expect(trace.roots).toHaveLength(1);
      expect(trace.roots[0]!.children[0]!.name).toBe('first tool');
      for (const selector of [second, second.toUpperCase(), Buffer.from(second, 'hex').toString('base64')]) {
        const chosen = parseOtlpJson(data, { traceId: selector });
        expect(chosen.traceId).toBe(second);
        expect(chosen.spans).toHaveLength(2);
        const link = chosen.spans.find((s) => s.spanId === '0000000000000002')!.links![0]!;
        expect(link.traceId).toBe(first);
        expect(link.spanId).toBe('6800000000000001');
        expect(link.target).toEqual({ status: 'available', name: 'first tool' });
      }
    });
  }

  it('keeps the complete parsed trace identical to its OTLP encoding', () => {
    for (const traceId of [first, second]) {
      const expected = parseOtlpJson(fixture('all.otlp'), { traceId });
      expect(parseOtlpJson(fixture('all.proto'), { traceId })).toEqual(expected);
      expect(parseOtlpJson(fixture('all.proto-snake'), { traceId })).toEqual(expected);
    }
  });

  it('does not mistake an uppercase hexadecimal trace prefix for base64', () => {
    const data = { resourceSpans: [{ scopeSpans: [{ spans: [{
      traceId: 'a'.repeat(32), spanId: '1'.repeat(16), name: 'prefix control',
      startTimeUnixNano: '1', endTimeUnixNano: '2',
    }] }] }] };
    expect(parseOtlpJson(data, { traceId: 'A'.repeat(22) }).traceId).toBe('a'.repeat(32));
  });
});

describe('identifier encodings', () => {
  it('normalizes canonical standard and URL-safe base64, with or without padding', () => {
    for (const length of [8, 16] as const) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i % 2 ? 255 : 251)));
      for (const format of ['base64', 'base64url'] as const) {
        const encoded = bytes.toString(format);
        expect(normalizeId(encoded, length)).toBe(bytes.toString('hex'));
        expect(normalizeId(encoded.replace(/=+$/, ''), length)).toBe(bytes.toString('hex'));
      }
      expect(normalizeId(bytes.toString('hex').toUpperCase(), length)).toBe(bytes.toString('hex'));
    }
  });

  it('preserves unknown case-sensitive identifiers and malformed encodings', () => {
    for (const id of ['Workflow', 'Span_A', 'Span_a', 'AAAAAAAAAAF=', 'AQ==', ' AAAAAAAAAAE=', 'AAAAAAAAAAE===']) {
      expect(normalizeId(id, 8)).toBe(id);
    }
    expect(normalizeId(null, 8)).toBe('');
  });
});

it('reads nested original AnyValue field names without changing camelCase precedence', () => {
  expect(decodeAnyValue({ kvlist_value: { values: [{ key: 'payload', value: { array_value: { values: [
    { int_value: '9007199254740993' }, { bytes_value: 'AQI=' }, { bool_value: false },
    { double_value: 0.25 }, { string_value: 'recorded' },
  ] } } }] } })).toEqual({ payload: ['9007199254740993', 'AQI=', false, 0.25, 'recorded'] });
  expect(decodeAnyValue({ boolValue: false, bool_value: true })).toEqual({ invalidAnyValue: { boolValue: false, bool_value: true } });
});
