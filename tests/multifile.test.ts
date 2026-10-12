import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTraceInputs, parseTraceText, MAX_TRACE_INPUTS } from '../src/core/otlp-parser.js';
import { flattenTrace, restoreTrace } from '../src/web/trace-transfer.js';
import { fakeSpan, otlpDoc } from './fixtures.js';

const span = (spanId: string, extra = {}) => fakeSpan({ spanId, startNs: 1000, endNs: 9000, ...extra });
const file = (name: string, spans: unknown[]) => ({ name, text: JSON.stringify(otlpDoc(spans)) });
const a = 'a'.repeat(32), b = 'b'.repeat(32);

describe('combined trace imports', () => {
  it('restores SDK-captured parents and links across JSONL and JSON, with provenance through worker transfer', () => {
    const inputs = ['worker.json', 'gateway.jsonl', 'audit.jsonl'].map(name => ({ name,
      text: readFileSync(new URL(`../studies/multifile/fixtures/${name}`, import.meta.url), 'utf8') }));
    const trace = restoreTrace(structuredClone(flattenTrace(parseTraceInputs(inputs))));
    expect(trace.spans).toHaveLength(7);
    expect(trace.roots.map(s => s.name)).toEqual(['run document checks']);
    expect(trace.warnings).toEqual([]);
    expect(trace.spans.filter(s => s.name === 'POST /digest').map(s => s.depth)).toEqual([2, 2]);
    expect(trace.spans.filter(s => s.name === 'sha256').map(s => s.depth)).toEqual([3, 3]);
    expect(trace.spans.filter(s => s.sourceFile?.name === 'worker.json')).toHaveLength(4);
    const auditId = trace.traces.find(t => t.rootName === 'commit audit batch')!.traceId;
    const audit = parseTraceInputs(inputs, { traceId: auditId });
    expect(audit.roots[0]!.links?.map(l => l.target?.status)).toEqual(['available', 'available']);
    expect(audit.roots[0]!.sourceFile).toEqual({ index: 3, name: 'audit.jsonl' });
    const reordered = parseTraceInputs([...inputs].reverse());
    expect(reordered.traceId).toBe(trace.traceId);
    expect(reordered.roots[0]!.children.map(s => s.spanId)).toEqual(trace.roots[0]!.children.map(s => s.spanId));
    expect(reordered.traces).toEqual(trace.traces);
  });

  it('leaves single-file parsing unchanged', () => {
    const input = file('one.json', [span('root')]);
    expect(parseTraceInputs([input])).toEqual(parseTraceText(input.text));
    expect(parseTraceInputs([input]).inputFiles).toBeUndefined();
  });

  it('joins OTLP and Jaeger after ID normalization, without crossing trace identities', () => {
    const inputs = [file('otlp.json', [span('parent', { traceId: a }), span('parent', { traceId: b })]),
      { name: 'jaeger.json', text: JSON.stringify({ data: [{ traceID: a, spans: [{ traceID: a,
        spanID: 'child', operationName: 'child', startTime: 2, duration: 2, tags: [], logs: [],
        references: [{ refType: 'CHILD_OF', traceID: a, spanID: 'parent' }], process: { serviceName: 'jaeger-service' },
      }] }] }) }];
    const trace = parseTraceInputs(inputs);
    expect(trace.sourceFormat).toBe('mixed-json');
    expect(trace.spans).toHaveLength(2);
    expect(trace.roots[0]!.children[0]!.name).toBe('child');
    expect(trace.roots[0]!.children[0]!.resourceAttributes['service.name']).toBe('jaeger-service');
    expect(parseTraceInputs(inputs, { traceId: b }).spans).toHaveLength(1);
  });

  for (const changed of [false, true]) it(`rejects overlapping identities even when records ${changed ? 'differ' : 'match'}`, () => {
    expect(() => parseTraceInputs([file('export.json', [span('root')]), file('export.json', [span('root', changed ? { endNs: 10000 } : {})])]))
      .toThrow(/file 1 \(export.json\) and file 2 \(export.json\)/);
  });

  it('checks duplicates in unselected traces and after base64 normalization', () => {
    const id = 'c'.repeat(16);
    const first = file('first.json', [span('root', { traceId: a }), span(id, { traceId: b })]);
    const second = file('second.json', [span(Buffer.from(id, 'hex').toString('base64'), { traceId: Buffer.from(b, 'hex').toString('base64') })]);
    expect(() => parseTraceInputs([first, second], { traceId: a })).toThrow('Duplicate span identity');
  });

  it('rejects a whole unreadable file or parent cycle spanning files', () => {
    const valid = file('valid.json', [span('root')]);
    for (const text of ['bad JSON', '{}', JSON.stringify(otlpDoc([]))]) {
      expect(() => parseTraceInputs([valid, { name: 'broken.json', text }])).toThrow('File 2 (broken.json):');
    }
    expect(() => parseTraceInputs([file('one', [span('one', { parentSpanId: 'two' })]), file('two', [span('two', { parentSpanId: 'one' })])])).toThrow('Cyclic span parents');
  });

  it('keeps malformed-span and truncated-line warnings attached to their file', () => {
    const broken = file('partial.jsonl', [span('orphan', { parentSpanId: 'absent' }), { ...span('bad'), endTimeUnixNano: 'invalid' }]);
    broken.text += '\n{"resourceSpans":';
    const trace = parseTraceInputs([file('first.json', [span('root')]), broken]);
    expect(trace.spans).toHaveLength(2);
    expect(trace.warnings).toHaveLength(3);
    expect(trace.warnings.every(w => w.sourceFile?.index === 2 && w.sourceFile.name === 'partial.jsonl')).toBe(true);
    expect(trace.warnings.some(w => w.message.includes('not present in the selected files'))).toBe(true);
  });

  it('bounds the group before reading any input', () => {
    expect(() => parseTraceInputs([])).toThrow('between 1 and 32');
    expect(() => parseTraceInputs(Array.from({ length: MAX_TRACE_INPUTS + 1 }, () => ({ name: 'unused', text: 'bad JSON' })))).toThrow('between 1 and 32');
  });
});
