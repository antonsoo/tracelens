// A trace file is not always one JSON document holding one trace. The OpenTelemetry Collector's
// file exporter writes a line per batch, and whatever passed through the collector is in it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSummary, DEFAULT_PRICE_TABLE, parseOtlpJson, parseTraceText, TraceParseError } from '../src/core/index.js';
import type { ParsedTrace } from '../src/core/index.js';
import { fakeSpan, otlpDoc } from './fixtures.js';

const example = (name: string): string => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');

interface OtlpDoc {
  resourceSpans: Array<{ resource: unknown; scopeSpans: Array<{ scope: unknown; spans: unknown[] }> }>;
}

/** The document as the file exporter would have written it: its spans in batches, one export per line. */
function asLines(text: string, batchSizes: number[]): string[] {
  const doc = JSON.parse(text) as OtlpDoc;
  const resource = doc.resourceSpans[0]!;
  const scope = resource.scopeSpans[0]!;
  const lines: string[] = [];
  let at = 0;
  for (const size of batchSizes) {
    lines.push(JSON.stringify({ resourceSpans: [{ ...resource, scopeSpans: [{ ...scope, spans: scope.spans.slice(at, at + size) }] }] }));
    at += size;
  }
  expect(at).toBe(scope.spans.length);
  return lines;
}

/** What a reader of the trace sees, without the object identities. */
function shape(trace: ParsedTrace): unknown {
  const summary = buildSummary(trace, DEFAULT_PRICE_TABLE);
  return {
    traceId: trace.traceId,
    spans: trace.spans.map((s) => [s.spanId, s.parentSpanId, s.name, s.depth, s.startTimeUnixNano, s.endTimeUnixNano, s.agentKind]).sort(),
    roots: trace.roots.map((s) => s.spanId),
    summary: { ...summary, criticalPath: summary.criticalPath.map((s) => s.spanId) },
    traces: trace.traces,
  };
}

describe('parseTraceText', () => {
  const genai = example('genai-semconv-trace.json');
  const whole = parseTraceText(genai);

  it('reads a single JSON document as parseOtlpJson does', () => {
    expect(shape(whole)).toEqual(shape(parseOtlpJson(JSON.parse(genai))));
    expect(whole.warnings).toEqual([]);
    expect(whole.traces).toEqual([
      { traceId: whole.traceId, spanCount: 16, rootName: 'invoke_agent incident-analyst', startNs: whole.minStartNs, durationNs: whole.maxEndNs - whole.minStartNs },
    ]);
  });

  it('reads Jaeger JSON, which is one document', () => {
    const jaeger = parseTraceText(example('jaeger-genai-trace.json'));
    expect(jaeger.sourceFormat).toBe('jaeger-json');
    expect(jaeger.spans).toHaveLength(16);
  });

  it("reads a collector's JSON Lines as one export, whatever the batching and the line endings", () => {
    for (const batches of [[16], [5, 6, 5], [1, 14, 1], Array.from({ length: 16 }, () => 1)]) {
      const lines = asLines(genai, batches);
      for (const text of [lines.join('\n') + '\n', lines.join('\r\n'), lines.join('\r'), '\n\n' + lines.join('\n\n  \n') + '\n\n']) {
        const trace = parseTraceText(text);
        expect(shape(trace)).toEqual(shape(whole));
        expect(trace.warnings).toEqual([]);
      }
    }
  });

  it('skips a last line that was cut short, and says so', () => {
    const lines = asLines(genai, [5, 6, 5]);
    const cut = [lines[0], lines[1], lines[2]!.slice(0, 200)].join('\n');
    const trace = parseTraceText(cut);
    expect(trace.spans).toHaveLength(11);
    expect(trace.warnings[0]!.message).toBe('The last line (3) is not complete JSON and was skipped: the export may still have been in progress.');
  });

  it('refuses a broken line in the middle, naming it', () => {
    const lines = asLines(genai, [5, 6, 5]);
    expect(() => parseTraceText([lines[0], '{"resourceSpans": [', lines[2]].join('\n'))).toThrow(/^Not valid JSON, and not JSON Lines either: line 2: /);
    expect(() => parseTraceText([lines[0], '{"resourceSpans": [', lines[2]].join('\n'))).toThrow(TraceParseError);
  });

  it('skips lines of metrics and logs written to the same file, and counts them', () => {
    const lines = asLines(genai, [8, 8]);
    const text = ['{"resourceMetrics":[{"scopeMetrics":[]}]}', lines[0], '{"resourceLogs":[]}', '{"resourceMetrics":[]}', lines[1]].join('\n');
    const trace = parseTraceText(text);
    expect(trace.spans).toHaveLength(16);
    expect(trace.warnings.map((w) => w.message)).toEqual(['Skipped 3 lines of metrics, logs or profiles: only traces are read.']);
    expect(() => parseTraceText('{"resourceMetrics":[]}\n{"resourceLogs":[]}\n')).toThrow('no resourceSpans');
  });

  it('refuses a line that is some other JSON', () => {
    const lines = asLines(genai, [8, 8]);
    expect(() => parseTraceText([lines[0], '{"hello": "world"}', lines[1]].join('\n'))).toThrow('Line 2 is not an OTLP/JSON trace export');
    expect(() => parseTraceText([lines[0], '42'].join('\n'))).toThrow('Line 2 is not an OTLP/JSON trace export');
  });

  it('says a file is not JSON when it is neither a document nor lines of them', () => {
    for (const text of ['', '   ', '{bad', 'not json at all', '{"resourceSpans": [\n{bad\n]}', '<html>\n<body>\n</body>\n</html>']) {
      expect(() => parseTraceText(text), JSON.stringify(text)).toThrow(/^Not valid JSON: /);
      expect(() => parseTraceText(text)).toThrow(TraceParseError);
    }
  });

  it('accepts bare resourceSpans arrays as lines', () => {
    const doc = JSON.parse(genai) as OtlpDoc;
    const trace = parseTraceText(`${JSON.stringify(doc.resourceSpans)}\n${JSON.stringify(doc.resourceSpans.slice(0, 0))}\n`);
    expect(trace.spans).toHaveLength(16);
  });
});

describe('a file with several traces', () => {
  const genai = example('genai-semconv-trace.json');
  const baseline = example('comparison-baseline.json');
  const candidate = example('comparison-candidate.json');
  // Three runs through one collector: the 16-span example and the two 6-span comparison runs.
  const text = [...asLines(genai, [5, 6, 5]), baseline.replace(/\s*\n\s*/g, ''), candidate.replace(/\s*\n\s*/g, '')].join('\n');
  const ids = {
    genai: parseTraceText(genai).traceId,
    baseline: parseTraceText(baseline).traceId,
    candidate: parseTraceText(candidate).traceId,
  };

  it('reads the trace with the most spans, and lists every trace in order of start time', () => {
    const trace = parseTraceText(text);
    expect(trace.traceId).toBe(ids.genai);
    expect(shape({ ...trace, traces: [] })).toEqual(shape({ ...parseTraceText(genai), traces: [] }));
    expect(trace.traces.map((t) => t.traceId).sort()).toEqual(Object.values(ids).sort());
    const starts = trace.traces.map((t) => t.startNs);
    expect(starts).toEqual([...starts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const listed = trace.traces.find((t) => t.traceId === ids.baseline)!;
    const alone = parseTraceText(baseline);
    expect(listed).toEqual({ traceId: ids.baseline, spanCount: alone.spans.length, rootName: alone.roots[0]!.name, startNs: alone.minStartNs, durationNs: alone.maxEndNs - alone.minStartNs });
  });

  it('reads the trace that is asked for, by ID or by the start of one', () => {
    for (const [name, source] of [['baseline', baseline], ['candidate', candidate], ['genai', genai]] as const) {
      const id = ids[name];
      const alone = { ...parseTraceText(source), traces: [] };
      expect(shape({ ...parseTraceText(text, { traceId: id }), traces: [] })).toEqual(shape(alone));
      expect(shape({ ...parseTraceText(text, { traceId: `  ${id.toUpperCase()} ` }), traces: [] })).toEqual(shape(alone));
    }
    expect(parseTraceText(text, { traceId: ids.genai.slice(0, 6) }).traceId).toBe(ids.genai);
  });

  it('breaks a tie in span count by start time', () => {
    const tied = [baseline.replace(/\s*\n\s*/g, ''), candidate.replace(/\s*\n\s*/g, '')];
    const first = parseTraceText(tied.join('\n'));
    expect(first.traceId).toBe(first.traces[0]!.traceId);
    expect(parseTraceText(tied.reverse().join('\n')).traceId).toBe(first.traceId);
  });

  it('refuses an ID that names no trace, or more than one, and says what the file holds', () => {
    expect(() => parseTraceText(text, { traceId: 'ffff0000' })).toThrow(`No trace in this file has the ID "ffff0000". It holds: `);
    expect(() => parseTraceText(text, { traceId: '' })).toThrow('No trace in this file has the ID ""');
    const twins = otlpDoc([
      fakeSpan({ traceId: 'abc1', spanId: 'a', startNs: 0, endNs: 1, name: 'first' }),
      fakeSpan({ traceId: 'abc2', spanId: 'a', startNs: 5, endNs: 6, name: 'second' }),
    ]);
    expect(() => parseOtlpJson(twins, { traceId: 'abc' })).toThrow('"abc" is the start of 2 trace IDs in this file: abc1 (first, 1 span); abc2 (second, 1 span).');
    expect(parseOtlpJson(twins, { traceId: 'abc2' }).roots[0]!.name).toBe('second');
    expect(() => parseOtlpJson(twins, { traceId: 'abc' })).toThrow(TraceParseError);
  });

  it("names a trace by its earliest root, and keeps each trace's warnings to itself", () => {
    const doc = otlpDoc([
      fakeSpan({ traceId: 'a1', spanId: 'late-root', startNs: 50, endNs: 60, name: 'late root' }),
      fakeSpan({ traceId: 'a1', spanId: 'root', startNs: 10, endNs: 40, name: 'the run' }),
      fakeSpan({ traceId: 'a1', spanId: 'child', parentSpanId: 'root', startNs: 5, endNs: 20, name: 'early child' }),
      fakeSpan({ traceId: 'b2', spanId: 'orphan', parentSpanId: 'missing', startNs: 100, endNs: 90, name: 'orphan' }),
      { ...fakeSpan({ traceId: 'b2', spanId: 'broken', startNs: 0, endNs: 1, name: 'broken' }), startTimeUnixNano: 'soon' },
    ]);
    const a1 = parseOtlpJson(doc);
    expect(a1.traceId).toBe('a1');
    expect(a1.traces.map((t) => [t.traceId, t.rootName, t.spanCount, t.startNs, t.durationNs])).toEqual([
      ['a1', 'the run', 3, 5n, 55n],
      ['b2', 'orphan', 1, 100n, 0n],
    ]);
    expect(a1.warnings).toEqual([]);
    const b2 = parseOtlpJson(doc, { traceId: 'b2' });
    expect(b2.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('end time before its start time'),
      expect.stringContaining('Skipped span "broken"'),
      expect.stringContaining('references a parent (missing) not present'),
    ]);
  });

  it('stays quick on a collector file of many traces', () => {
    const spans: unknown[] = [];
    for (let t = 0; t < 2_000; t++) {
      const traceId = t.toString(16).padStart(32, '0');
      for (let i = 0; i < 10; i++) spans.push(fakeSpan({ traceId, spanId: `s${i}`, ...(i ? { parentSpanId: 's0' } : {}), startNs: t * 1000 + i, endNs: t * 1000 + i + 5 }));
    }
    const text = Array.from({ length: 200 }, (_, k) => JSON.stringify(otlpDoc(spans.slice(k * 100, (k + 1) * 100)))).join('\n');
    const started = performance.now();
    const trace = parseTraceText(text, { traceId: (1234).toString(16).padStart(32, '0') });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(trace.traces).toHaveLength(2_000);
    expect(trace.spans).toHaveLength(10);
    expect(trace.roots[0]!.children).toHaveLength(9);
  });
});
