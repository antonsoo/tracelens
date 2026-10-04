import { expect, it } from 'vitest';
import { jsonPreview, textPreview } from '../src/web/format.js';
import { spanEvidence } from '../src/web/evidence.js';
import { parseOtlpJson } from '../src/core/otlp-parser.js';
import { attr, fakeSpan, otlpDoc, sv } from './fixtures.js';

it('formats complete small JSON like the standard serializer', () => {
  for (const value of [null, 1, true, 'a\n"b', [], {}, { one: [1, 'x', { yes: true }] }]) {
    expect(jsonPreview(value)).toBe(JSON.stringify(value, null, 2));
  }
});

it('bounds strings and stops visiting values beyond the preview budget', () => {
  const huge = 'long '.repeat(100_000);
  const value = { first: huge, get second(): never { throw new Error('preview visited omitted evidence'); } };
  expect(jsonPreview(value, 50)).toContain('download for full value');
  expect(jsonPreview(value, 50).length).toBeLessThan(100);
  expect(textPreview(huge, 50).length).toBeLessThan(100);
  expect(huge.length).toBe(500_000);
});

it('handles circular programmatic values without unbounded fallback stringification', () => {
  const value: unknown[] = [];
  value.push(value);
  expect(jsonPreview(value)).toContain('[circular]');
});

it('exports every attribute and long value without recursively duplicating descendants', () => {
  const payload = 'keep all of this '.repeat(1000);
  const trace = parseOtlpJson(otlpDoc([
    fakeSpan({ spanId: 'root', startNs: 123456789123456789n, endNs: 123456789123456790n, attributes: [attr('payload', sv(payload))] }),
    fakeSpan({ spanId: 'child', parentSpanId: 'root', startNs: 0, endNs: 1 }),
  ]));
  const report = JSON.parse(JSON.stringify(spanEvidence(trace.roots[0]!), (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v));
  expect(report.attributes.payload).toBe(payload);
  expect(report.startTimeUnixNano).toBe('123456789123456789');
  expect(report.children).toEqual(['child']);
  expect(report.schemaVersion).toBe(1);
});
