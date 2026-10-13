import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeId } from '../src/core/identity.js';
import { parseOtlpJson, parseTraceInputs } from '../src/core/otlp-parser.js';

const short = '1234567890abcdef';
const full = `0000000000000000${short}`;
const read = (name: string) => ({ name, text: readFileSync(new URL(`../studies/jaeger64/fixtures/${name}.json`, import.meta.url), 'utf8') });
const gateway = read('gateway.jaeger');
const worker = read('worker.otlp');
const audit = read('audit.otlp');
const jaegerDocument = () => JSON.parse(gateway.text) as { data: { spans: Record<string, unknown>[] }[] };

describe('Jaeger 64-bit trace identities', () => {
  it('assembles service exports in either order and resolves links across traces', () => {
    for (const inputs of [[gateway, worker, audit], [audit, worker, gateway]]) {
      const trace = parseTraceInputs(inputs);
      expect(trace.traceId).toBe(full);
      expect(trace.traces).toHaveLength(2);
      expect(trace.spans).toHaveLength(3);
      expect(trace.roots).toHaveLength(1);
      expect(trace.roots[0]!.children[0]!.children[0]!.name).toBe('chat gpt-4o');
      expect(trace.warnings).toEqual([]);
      const linked = parseTraceInputs(inputs, { traceId: 'a'.repeat(32) });
      expect(linked.spans[0]!.links?.map(link => link.target?.status)).toEqual(['available', 'available']);
    }
  });

  it('selects the complete Jaeger spelling, padded hex or Protobuf byte encoding', () => {
    for (const traceId of [short, short.toUpperCase(), full, Buffer.from(full, 'hex').toString('base64')]) {
      expect(parseTraceInputs([gateway, worker], { traceId }).spans).toHaveLength(3);
    }
  });

  it('rejects overlapping exports even when their trace ID spellings differ', () => {
    expect(() => parseTraceInputs([gateway, read('gateway.otlp')])).toThrow('Duplicate span identity');
    const doc = jaegerDocument();
    doc.data[0]!.spans.push({ ...doc.data[0]!.spans[0], traceID: full });
    expect(() => parseOtlpJson(doc)).toThrow('Duplicate span IDs');
  });

  it('normalizes Jaeger references before same-trace parent and link resolution', () => {
    const doc = jaegerDocument();
    doc.data[0]!.spans.push({ ...doc.data[0]!.spans[0], spanID: '0000000000000002',
      references: [{ refType: 'CHILD_OF', traceID: full, spanID: '0000000000000001' }] });
    const trace = parseOtlpJson(doc);
    expect(trace.roots).toHaveLength(1);
    expect(trace.roots[0]!.children[0]!.links?.[0]?.target?.status).toBe('available');
  });

  it('keeps nonzero high words distinct and prefers a complete 64-bit ID to a prefix', () => {
    const doc = jaegerDocument();
    for (const traceID of [`1111111111111111${short}`, `${short}1111111111111111`]) {
      doc.data[0]!.spans.push({ ...doc.data[0]!.spans[0], traceID });
    }
    const trace = parseOtlpJson(doc, { traceId: short });
    expect(trace.traceId).toBe(full);
    expect(trace.traces).toHaveLength(3);
    expect(trace.spans).toHaveLength(1);
    expect(parseOtlpJson(doc, { traceId: short.slice(0, 8) }).traceId).toBe(`${short}1111111111111111`);
  });

  it('pads only complete 16-hex trace IDs, leaving spans and opaque labels alone', () => {
    expect(normalizeId(short.toUpperCase(), 16)).toBe(full);
    expect(normalizeId(short, 8)).toBe(short);
    for (const value of ['Workflow', 'abc123', 'abc123abc123abc', 'abc123abc123abc12', '1234567890abcdeg']) {
      expect(normalizeId(value, 16)).toBe(value);
    }
  });
});
