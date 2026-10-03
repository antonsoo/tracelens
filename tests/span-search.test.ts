import { describe, expect, it } from 'vitest';
import { parseOtlpJson } from '../src/core/index.js';
import { searchSpans } from '../src/web/span-search.js';
import { flattenVisible } from '../src/web/tree-flatten.js';
import { attr, fakeSpan, otlpDoc, sv } from './fixtures.js';

const trace = parseOtlpJson(otlpDoc([
  fakeSpan({ spanId: 'root', name: 'workflow', startNs: 0, endNs: 10 }),
  fakeSpan({ spanId: 'chain', parentSpanId: 'root', name: 'analysis', startNs: 1, endNs: 9 }),
  fakeSpan({ spanId: 'call-a', parentSpanId: 'chain', name: 'chat answer', startNs: 2, endNs: 4, statusCode: 2,
    attributes: [attr('gen_ai.operation.name', sv('chat')), attr('gen_ai.request.model', sv('test-model')),
      attr('gen_ai.input.messages', sv('private-prompt-needle'))] }),
  fakeSpan({ spanId: 'call-b', parentSpanId: 'root', name: 'chat success', startNs: 5, endNs: 7 }),
], [attr('service.name', sv('Research-Service')), attr('service.namespace', sv('prod'))]));

describe('span search', () => {
  it('leaves an unfiltered tree and its saved folds alone', () => {
    expect(searchSpans(trace, { query: ' \n ', errorsOnly: false })).toBeNull();
    expect(flattenVisible(trace, new Set(['root'])).map((s) => s.spanId)).toEqual(['root']);
  });
  it('counts matches separately from shared ancestor context', () => {
    const found = searchSpans(trace, { query: 'chat', errorsOnly: false })!;
    expect([...found.matches]).toEqual(['call-a', 'call-b']);
    expect(found.included.size).toBe(4);
    expect(flattenVisible(trace, new Set(['root', 'chain']), found.included).map((s) => s.spanId)).toEqual(['root', 'chain', 'call-a', 'call-b']);
  });
  it.each(['CALL-A', 'test-model', 'ReSeArCh-SeRvIcE test-model', 'prod ERROR'])('finds identity fields with query %s', (query) => {
    expect([...searchSpans(trace, { query, errorsOnly: false })!.matches]).toEqual(['call-a']);
  });
  it('combines errors-only and AND-word search', () => {
    expect([...searchSpans(trace, { query: 'chat', errorsOnly: true })!.matches]).toEqual(['call-a']);
    expect(searchSpans(trace, { query: 'success', errorsOnly: true })!.included.size).toBe(0);
    expect([...searchSpans(trace, { query: '', errorsOnly: true })!.matches]).toEqual(['call-a']);
  });
  it('does not search private payloads or treat regex characters as patterns', () => {
    for (const query of ['private-prompt-needle', '.*', '<img onerror>']) {
      expect(searchSpans(trace, { query, errorsOnly: false })!.matches.size).toBe(0);
    }
  });
  it('does not include nonmatching descendants of a matching ancestor', () => {
    const found = searchSpans(trace, { query: 'workflow', errorsOnly: false })!;
    expect(flattenVisible(trace, new Set(), found.included).map((s) => s.spanId)).toEqual(['root']);
  });
  it('preserves the trace and handles deep ancestry iteratively', () => {
    const long = parseOtlpJson(otlpDoc(Array.from({ length: 6000 }, (_, i) => fakeSpan({
      spanId: String(i), ...(i ? { parentSpanId: String(i - 1) } : {}),
      name: i === 5999 ? 'needle' : 'step', startNs: 0, endNs: 10,
    }))));
    const found = searchSpans(long, { query: 'needle', errorsOnly: false })!;
    expect(found.matches.size).toBe(1);
    expect(found.included.size).toBe(6000);
    expect(flattenVisible(long, new Set(['0']), found.included)).toHaveLength(6000);
    expect(long.spans[0]!.children).toHaveLength(1);
    expect(searchSpans(long, { query: 'missing', errorsOnly: false })!.matches.size).toBe(0);
  });
});
