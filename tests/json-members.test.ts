import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTraceInputs, parseTraceText, TraceParseError } from '../src/core/index.js';

// Actual SDK export; the duplicate members below are controlled file damage,
// not evidence that the native exporter produced ambiguous JSON.
const native = readFileSync(new URL('./fixtures/small-genai-semconv-trace.json', import.meta.url), 'utf8');
const compact = JSON.stringify(JSON.parse(native));
const ambiguous = compact.replace(/"code":(?:2|"STATUS_CODE_ERROR")/, '"code":2,"code":1');

describe('original JSON members must remain unambiguous', () => {
  it.each(['"code":2,"code":1', '"code":1,"code":2', '"code":2,"\\u0063ode":1',
    '"code":2,"code":2'])('refuses %s before choosing a status', members => {
    const text = compact.replace(/"code":(?:2|"STATUS_CODE_ERROR")/, members);
    expect(() => parseTraceText(text)).toThrow(/Duplicate JSON object field/);
  });

  it.each(['resourceSpans', 'scopeSpans', 'spans'])('refuses a repeated %s inventory field', key => {
    const text = compact.replace(`"${key}":`, `"${key}":[],"${key}":`);
    expect(() => parseTraceText(text)).toThrow(TraceParseError);
    expect(() => parseTraceText(text)).toThrow(/Duplicate JSON object field/);
  });

  it.each(['first', 'middle', 'last'])('never salvages a complete ambiguous %s JSONL record', at => {
    const lines = ['{"resourceSpans":[]}', '{"resourceSpans":[]}', '{"resourceSpans":[]}'];
    const index = ['first', 'middle', 'last'].indexOf(at);
    lines[index] = ambiguous;
    expect(() => parseTraceText(lines.join('\n'))).toThrow(new RegExp(`Line ${index + 1}: Duplicate JSON object field`));
  });

  it('does not import only the good file from a group containing ambiguous log evidence', () => {
    expect(() => parseTraceInputs([
      { name: 'trace.json', text: native },
      { name: 'logs.json', text: '{"resourceLogs":[],"resourceLogs":[]}' },
    ])).toThrow(/File 2 \(logs.json\): Duplicate JSON object field/);
  });

  it('refuses duplicated unknown metadata and prototype-shaped names too', () => {
    for (const members of ['"future":null,"future":null', '"__proto__":{},"__proto__":{}',
      '"constructor":1,"constructor":2', '"":1,"":2']) {
      expect(() => parseTraceText(`{${members},${compact.slice(1)}`)).toThrow(/Duplicate JSON object field/);
    }
  });

  it('allows repeated names in different objects and JSON-looking literal text', () => {
    const tail = ',"future":[{"key":"a"},{"key":"b"}],"text":' +
      JSON.stringify('{"code":2,"code":1} \\" [ ] { } : ,') + '}';
    const text = compact.slice(0, -1) + tail;
    const result = parseTraceText(text);
    expect(result.spans).toHaveLength(8);
    expect(result.spans.filter(span => span.status.code === 'ERROR')).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it('recognizes escaped quotes and either parity of backslashes at string boundaries', () => {
    for (let count = 0; count < 12; count++) {
      const key = `field${'\\'.repeat(count)}"`, spelling = JSON.stringify(key);
      const literal = JSON.stringify(`value${'\\'.repeat(count)}" {"code":2,"code":1}`);
      expect(() => parseTraceText(`{${spelling}:${literal},${compact.slice(1)}`)).not.toThrow();
      expect(() => parseTraceText(`{${spelling}:${literal},${spelling}:null,${compact.slice(1)}`))
        .toThrow(/Duplicate JSON object field/);
    }
  });

  it('keeps genuinely unfinished final JSONL records as explicit partial imports', () => {
    const result = parseTraceText(compact + '\n{"resourceSpans":[');
    expect(result.spans).toHaveLength(8);
    expect(result.warnings).toEqual([expect.objectContaining({ comparisonIssue: 'span-inventory',
      message: expect.stringContaining('last line (2)') })]);
  });

  it('does not misclassify unfinished duplicate syntax as a complete ambiguous record', () => {
    const result = parseTraceText(compact + '\n{"resourceSpans":[],"resourceSpans":[');
    expect(result.spans).toHaveLength(8);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain('not complete JSON');
  });
});
