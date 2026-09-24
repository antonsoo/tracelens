import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOtlpJson, TraceParseError } from '../src/core/otlp-parser.js';
import { attr, fakeSpan, iv, otlpDoc, sv } from './fixtures.js';

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(EXAMPLES + name, 'utf8'));
}

describe('parseOtlpJson on real SDK-generated fixtures', () => {
  for (const file of ['genai-semconv-trace.json', 'openinference-trace.json']) {
    it(`parses ${file} into a well-formed tree`, () => {
      const trace = parseOtlpJson(loadFixture(file));
      expect(trace.spans.length).toBe(8);
      expect(trace.roots.length).toBe(1);
      expect(trace.roots[0]!.name).toContain('invoke_agent');
      expect(trace.warnings).toEqual([]);

      // every non-root span's parent must resolve to a span actually in the tree
      const ids = new Set(trace.spans.map((s) => s.spanId));
      for (const s of trace.spans) {
        if (s.parentSpanId) expect(ids.has(s.parentSpanId)).toBe(true);
      }

      // depths are consistent with the tree shape (root=0, direct children=1)
      expect(trace.roots[0]!.depth).toBe(0);
      for (const child of trace.roots[0]!.children) expect(child.depth).toBe(1);

      const errorSpans = trace.spans.filter((s) => s.status.code === 'ERROR');
      expect(errorSpans.length).toBe(2);
    });
  }
});

describe('parseOtlpJson structural edge cases', () => {
  it('rejects a document with no resourceSpans array', () => {
    expect(() => parseOtlpJson({ notATrace: true })).toThrow(TraceParseError);
  });

  it('rejects an empty resourceSpans array', () => {
    expect(() => parseOtlpJson({ resourceSpans: [] })).toThrow(TraceParseError);
  });

  it('treats a span whose parent is absent from the file as a root, with a warning', () => {
    const doc = otlpDoc([
      fakeSpan({ spanId: '01'.repeat(8), parentSpanId: 'ff'.repeat(8), startNs: 0, endNs: 1000 }),
    ]);
    const trace = parseOtlpJson(doc);
    expect(trace.roots.length).toBe(1);
    expect(trace.warnings.some((w) => w.message.includes('not present in this file'))).toBe(true);
  });

  it('clamps an end time before its start time (clock skew) instead of producing a negative duration', () => {
    const doc = otlpDoc([fakeSpan({ spanId: '02'.repeat(8), startNs: 5000, endNs: 1000 })]);
    const trace = parseOtlpJson(doc);
    expect(trace.spans[0]!.durationNs).toBe(0n);
    expect(trace.warnings.some((w) => w.message.includes('clock skew'))).toBe(true);
  });

  it('skips spans with a missing spanId rather than crashing', () => {
    const doc = otlpDoc([{ traceId: 'aa'.repeat(16), name: 'broken', startTimeUnixNano: '0', endTimeUnixNano: '1' }]);
    expect(() => parseOtlpJson(doc)).toThrow(TraceParseError); // nothing left to show
  });

  it('builds multi-level parent/child chains correctly', () => {
    const root = fakeSpan({ spanId: '10'.repeat(8), startNs: 0, endNs: 10_000 });
    const mid = fakeSpan({ spanId: '20'.repeat(8), parentSpanId: '10'.repeat(8), startNs: 1000, endNs: 9000 });
    const leaf = fakeSpan({ spanId: '30'.repeat(8), parentSpanId: '20'.repeat(8), startNs: 2000, endNs: 8000 });
    const trace = parseOtlpJson(otlpDoc([root, mid, leaf]));
    expect(trace.roots[0]!.children[0]!.children[0]!.spanId).toBe('30'.repeat(8));
    expect(trace.roots[0]!.children[0]!.children[0]!.depth).toBe(2);
  });

  it('decodes typed AnyValue attributes (string, int, array)', () => {
    const span = fakeSpan({
      spanId: '40'.repeat(8),
      startNs: 0,
      endNs: 1,
      attributes: [attr('gen_ai.request.model', sv('gpt-4o-mini')), attr('gen_ai.usage.input_tokens', iv(42)), attr('gen_ai.response.finish_reasons', { arrayValue: { values: [sv('stop')] } })],
    });
    const trace = parseOtlpJson(otlpDoc([span]));
    const s = trace.spans[0]!;
    expect(s.attributes['gen_ai.request.model']).toBe('gpt-4o-mini');
    expect(s.attributes['gen_ai.usage.input_tokens']).toBe(42);
    expect(s.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });
});

describe('parseOtlpJson performance on a large generated trace', () => {
  it('parses 20,000 spans in well under a second', () => {
    const spans = [];
    const rootId = 'ff'.repeat(8);
    spans.push(fakeSpan({ spanId: rootId, startNs: 0, endNs: 20_000_000 }));
    for (let i = 0; i < 20_000; i++) {
      const id = i.toString(16).padStart(16, '0');
      spans.push(
        fakeSpan({
          spanId: id,
          parentSpanId: rootId,
          name: `execute_tool step-${i}`,
          startNs: i * 1000,
          endNs: i * 1000 + 500,
          attributes: [attr('gen_ai.operation.name', sv('execute_tool')), attr('gen_ai.tool.name', sv(`step-${i}`))],
        }),
      );
    }
    const doc = otlpDoc(spans);
    const start = performance.now();
    const trace = parseOtlpJson(doc);
    const elapsedMs = performance.now() - start;
    expect(trace.spans.length).toBe(20_001);
    expect(trace.roots[0]!.children.length).toBe(20_000);
    // Generous bound: this machine (14 vCPU WSL2, 48GB RAM) parses this in low tens
    // of ms; 1000ms leaves headroom for CI hardware without being a meaningless bound.
    expect(elapsedMs).toBeLessThan(1000);
  });
});
