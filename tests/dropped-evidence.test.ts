import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOtlpJson } from '../src/core/otlp-parser.js';
import { flattenTrace, restoreTrace } from '../src/web/trace-transfer.js';
import { spanEvidence } from '../src/web/evidence.js';
import { fakeSpan, otlpDoc } from './fixtures.js';

interface ExpectedEvent { name: string; timeUnixNano: string; attributes: Record<string, unknown>; droppedAttributesCount: number }
interface ExpectedSpan { traceId: string; spanId: string; name: string; attributes: Record<string, unknown>; droppedAttributesCount: number; droppedEventsCount: number; events: ExpectedEvent[] }
const fixture = (file: string): unknown => JSON.parse(readFileSync(new URL(`../studies/dropped-evidence/fixtures/${file}`, import.meta.url), 'utf8'));
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? String(v) : v));
const oracle = fixture('oracle.json') as { spans: ExpectedSpan[] };

describe('SDK omission evidence', () => {
  for (const format of ['otlp', 'proto', 'proto-snake']) {
    for (const expected of oracle.spans) {
      it(`${format}: keeps omitted and retained data separate for ${expected.name}`, () => {
        const trace = restoreTrace(structuredClone(flattenTrace(parseOtlpJson(fixture(`capture.${format}.json`), { traceId: expected.traceId }))));
        const span = trace.spans[0]!;
        expect(span.droppedAttributesCount ?? 0).toBe(expected.droppedAttributesCount);
        expect(span.droppedEventsCount ?? 0).toBe(expected.droppedEventsCount);
        expect(plain(span.attributes)).toEqual(expected.attributes);
        expect(plain(span.events.map(event => ({ ...event, droppedAttributesCount: event.droppedAttributesCount ?? 0 })))).toEqual(expected.events);
        const count = Number(expected.droppedAttributesCount > 0) + Number(expected.droppedEventsCount > 0)
          + expected.events.filter(event => event.droppedAttributesCount > 0).length;
        expect(trace.warnings).toHaveLength(count);
        expect(trace.warnings.every(w => w.traceId === expected.traceId && w.spanId === expected.spanId)).toBe(true);
        expect(plain(spanEvidence(span))).toMatchObject({ events: plain(span.events), attributes: expected.attributes });
      });
    }
  }
});

function counted(value: unknown) {
  return otlpDoc([{ ...fakeSpan({ spanId: '1', startNs: 1, endNs: 2 }),
    droppedAttributesCount: value, droppedEventsCount: value,
    events: [{ name: 'checkpoint', timeUnixNano: '1', droppedAttributesCount: value }],
  }]);
}

it.each([-1, 1.5, 4294967296, true, '', '0x10', 'bad', {}, [], '1e400'])('keeps invalid omission count %j unknown with warnings', value => {
  const trace = parseOtlpJson(counted(value));
  expect(trace.spans[0]!.droppedAttributesCount).toBeUndefined();
  expect(trace.spans[0]!.droppedEventsCount).toBeUndefined();
  expect(trace.spans[0]!.events[0]!.droppedAttributesCount).toBeUndefined();
  expect(trace.warnings).toHaveLength(3);
  expect(trace.warnings.every(w => w.message.includes('value is unknown'))).toBe(true);
});

it.each([undefined, null, 0, '0'])('does not invent omissions for absent or zero count %j', value => {
  const trace = parseOtlpJson(counted(value));
  expect(trace.warnings).toEqual([]);
  expect(trace.spans[0]!.droppedEventsCount ?? 0).toBe(0);
});

it.each([1, 4294967295, '3', '2.0', '1e2'])('accepts numeric and quoted uint32 count %j', value => {
  const trace = parseOtlpJson(counted(value));
  expect(trace.spans[0]!.droppedEventsCount).toBe(Number(value));
  expect(trace.warnings).toHaveLength(3);
});

it('retains event omission evidence when the event timestamp is invalid', () => {
  const trace = parseOtlpJson(otlpDoc([{ ...fakeSpan({ spanId: '1', startNs: 1, endNs: 2 }),
    events: [{ name: 'checkpoint', timeUnixNano: '-1', droppedAttributesCount: 3 }],
  }]));
  expect(trace.spans[0]!.events).toEqual([]);
  expect(trace.warnings.some(w => w.message.includes('invalid timestamp'))).toBe(true);
  expect(trace.warnings.some(w => w.message.includes('reports 3 dropped attributes'))).toBe(true);
});
