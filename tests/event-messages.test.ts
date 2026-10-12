import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseOtlpJson } from '../src/core/otlp-parser.js';

// Real Strands output from recorded provider responses; modifications below
// are controlled damaged/hybrid exports, not additional captured incidents.
interface Attribute { key: string; value: { stringValue?: string } }
interface CapturedSpan {
  traceId: string; spanId: string; parentSpanId?: string;
  attributes: Attribute[]; events: { name: string; attributes: Attribute[] }[];
}
interface Capture { resourceSpans: { scopeSpans: { spans: CapturedSpan[] }[] }[] }
function capture(mode = 'legacy') {
  return JSON.parse(readFileSync(new URL(`./fixtures/census/strands-${mode}-events-tool-call.json`, import.meta.url), 'utf8')) as Capture;
}
const firstSpan = (doc: Capture) => doc.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
function replaceOutput(doc: Capture, content: string) {
  const ev = firstSpan(doc).events.find((e) => e.name === 'gen_ai.choice')!;
  ev.attributes.find((a) => a.key === 'message')!.value.stringValue = content;
}

describe('legacy event content damage stays local to the message', () => {
  it.each(['toolUse', 'toolResult'])('retains raw %s blocks and every span with a scoped diagnostic', (key) => {
    for (const value of ['broken', 1, true, false, null, [], {}, { toolUseId: 'id' }]) {
      const doc = capture();
      const content = JSON.stringify([{ text: 'before' }, { [key]: value }, { text: 'after' }]);
      replaceOutput(doc, content);
      const raw = firstSpan(doc);
      const trace = parseOtlpJson(doc, { traceId: raw.traceId });
      expect(trace.spans).toHaveLength(6);
      const span = trace.spans.find((s) => s.spanId === raw.spanId)!;
      expect(span.genai?.outputMessages).toEqual([{ role: 'assistant', parts: [{ type: 'text', content }] }]);
      expect(span.events[1]?.attributes.message).toBe(content);
      expect(trace.warnings).toEqual([{
        spanId: raw.spanId, traceId: raw.traceId,
        message: expect.stringContaining('events[1] (gen_ai.choice) content block [1]'),
      }]);
    }
  });

  it('does not choose one of two conflicting content members', () => {
    const doc = capture();
    const content = '[{"text":"keep me","toolUse":{"toolUseId":"id","name":"weather","input":{}}}]';
    replaceOutput(doc, content);
    const trace = parseOtlpJson(doc);
    expect(trace.spans[0]?.genai?.outputMessages?.[0]?.parts).toEqual([{ type: 'text', content }]);
    expect(trace.warnings).toHaveLength(1);
  });

  it('accepts JSON whitespace and retains null tool inputs as explicit values', () => {
    const doc = capture();
    replaceOutput(doc, ' \n[{"toolUse":{"toolUseId":"id","name":"weather","input":null}}]\t');
    const trace = parseOtlpJson(doc);
    expect(trace.spans[0]?.genai?.outputMessages?.[0]?.parts).toEqual([{ type: 'tool_call', id: 'id', name: 'weather', arguments: null }]);
    expect(trace.warnings).toEqual([]);
  });

  it('keeps warnings scoped to the selected trace', () => {
    const doc = capture();
    const other = structuredClone(firstSpan(doc));
    other.traceId = 'ffffffffffffffffffffffffffffffff';
    delete other.parentSpanId;
    replaceOutput(doc, '[{"toolResult":true}]');
    doc.resourceSpans[0]!.scopeSpans[0]!.spans.push(other);
    expect(parseOtlpJson(doc, { traceId: other.traceId }).warnings).toEqual([]);
    expect(parseOtlpJson(doc, { traceId: firstSpan(doc).traceId }).warnings).toHaveLength(1);
  });

  it('still refuses payloads that exceed the nesting bound', () => {
    const doc = capture();
    replaceOutput(doc, '[{"toolUse":{"toolUseId":"id","name":"weather","input":' + '['.repeat(129) + '0' + ']'.repeat(129) + '}}]');
    expect(() => parseOtlpJson(doc)).toThrow(/exceeds 128 nested/);
  });
});

describe.each(['legacy', 'operation-details'])('message sources in %s events', (mode) => {
  it.each(['input', 'output'])('uses the %s attribute without suppressing the opposite event direction', (direction) => {
    const doc = capture(mode);
    const raw = firstSpan(doc);
    const original = parseOtlpJson(doc).spans.find((s) => s.spanId === raw.spanId)!.genai!;
    const messages = [{ role: direction === 'input' ? 'user' : 'assistant', parts: [{ type: 'text', content: 'attribute takes precedence' }] }];
    raw.attributes.push({ key: `gen_ai.${direction}.messages`, value: { stringValue: JSON.stringify(messages) } });
    const trace = parseOtlpJson(doc);
    const genai = trace.spans.find((s) => s.spanId === raw.spanId)!.genai!;
    expect(genai).toEqual({ ...original, [`${direction}Messages`]: messages });
    expect(trace.warnings).toEqual([]);
  });
});
