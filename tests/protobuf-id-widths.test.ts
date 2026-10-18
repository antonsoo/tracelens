import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeTraceFile } from '../src/core/trace-file.js';
import { parseTraceInputs } from '../src/core/otlp-parser.js';
const directory = new URL('../studies/protobuf-id-widths/fixtures/', import.meta.url);
const load = (name: string): Uint8Array => readFileSync(new URL(name, directory));
const oracle = JSON.parse(readFileSync(new URL('oracle.json', directory), 'utf8')) as { cases: { file: string; collectorAccepted: boolean; collectorStatus: number }[] };

describe('exact native byte widths, independently checked by the Collector', () => {
  it.each(oracle.cases)('$file agrees with native HTTP $collectorStatus', control => {
    if (!control.collectorAccepted) {
      expect(() => decodeTraceFile(load(control.file), control.file)).toThrow(/OTLP requires (8|16) bytes/);
    } else {
      const decoded = decodeTraceFile(load(control.file), control.file);
      expect(decoded.sourceFormat).toBe('otlp-protobuf');
      if (control.file.endsWith('.traces.pb')) expect(parseTraceInputs([decoded]).spans).toHaveLength(2);
      else {
        const trace = decodeTraceFile(load('native-control.traces.pb'), 'native-control.traces.pb');
        expect(parseTraceInputs([trace, decoded]).unmatchedLogs).toHaveLength(1);
      }
    }
  });

  it('refuses the complete framed import when a later batch has a wrong-width ID', () => {
    const valid = load('native-control.traces.pb'), invalid = load('trace-short.traces.pb');
    const body = new Uint8Array(8 + valid.length + invalid.length);
    const view = new DataView(body.buffer);
    view.setUint32(0, valid.length, false); body.set(valid, 4);
    view.setUint32(4 + valid.length, invalid.length, false); body.set(invalid, 8 + valid.length);
    expect(() => decodeTraceFile(body, 'run.traces.otlp')).toThrow(/batch 2.*No batches were imported/);
  });

  it('does not impose native byte interpretation on opaque legacy JSON identifiers', () => {
    const text = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'legacy-run', spanId: 'opaque-step', name: 'legacy', startTimeUnixNano: '1', endTimeUnixNano: '2' }] }] }] });
    const trace = parseTraceInputs([decodeTraceFile(new TextEncoder().encode(text), 'legacy.json')]);
    expect(trace.traceId).toBe('legacy-run'); expect(trace.spans[0]!.spanId).toBe('opaque-step');
  });
});
