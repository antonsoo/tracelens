import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeTraceFile } from '../src/core/trace-file.js';
import { decodeZstdCarrier } from '../src/core/zstd.js';
import { parseTraceInputs } from '../src/core/otlp-parser.js';
import { buildTiming } from '../src/core/timing.js';
import type { ParsedTrace } from '../src/core/types.js';

const root = new URL('../studies/zstd-collector/', import.meta.url);
const read = (file: string): Uint8Array => readFileSync(new URL(file, root));
const oracle = JSON.parse(readFileSync(new URL('fixtures/oracle.json', root), 'utf8')) as {
  observations: { file: string; format: string; decodedSha256: string }[];
};
const controls = JSON.parse(readFileSync(new URL('controls/oracle.json', root), 'utf8')) as {
  cases: { file: string; expected: string }[];
};

/** Retain every normalized value; only carrier provenance differs. In particular,
 * do not recursively erase user attributes named source, line or sourceFile. */
function observations(trace: ParsedTrace) {
  return {
    traceId: trace.traceId, traces: trace.traces, roots: trace.roots.map(span => span.spanId),
    spans: trace.spans.map(({ children, sourceFile: _source, logs, ...span }) => ({
      ...span, children: children.map(child => child.spanId),
      logs: logs?.map(({ source: _source, ...log }) => log),
    })),
    timing: { ...buildTiming(trace), warnings: [] },
  };
}

describe('actual Zstandard Collector exports', () => {
  it.each(oracle.observations)('matches the independent decoded bytes for $file', row => {
    const decoded = decodeZstdCarrier(read(`fixtures/${row.file}`), row.format === 'json' ? 'text' : 'collector');
    expect(createHash('sha256').update(decoded.bytes).digest('hex')).toBe(row.decodedSha256);
  });

  for (const mode of ['legacy', 'native']) for (const format of ['json', 'proto']) {
    it(`keeps all traces, logs, typed values, clocks and links: ${mode} ${format}`, () => {
      const names = format === 'json' ? ['traces.jsonl', 'logs.jsonl'] : ['traces.traces.otlp', 'logs.logs.otlp'];
      const plain = names.map(name => decodeTraceFile(read(`fixtures/${mode}/${name}`), name));
      const compressed = names.map(name => decodeTraceFile(read(`fixtures/${mode}/${name}.zst`), name + '.zst'));
      const choices = parseTraceInputs(plain).traces;
      expect(choices).toHaveLength(2);
      for (const choice of choices) {
        const expected = parseTraceInputs(plain, { traceId: choice.traceId });
        const actual = parseTraceInputs(compressed, { traceId: choice.traceId });
        expect(observations(actual)).toEqual(observations(expected));
        expect(actual.warnings).toEqual(expected.warnings);
        expect(actual.inputFiles?.every(file => file.compression?.format === 'zstd')).toBe(true);
      }
    });
  }

  it('preserves a raw SDK request and ignores unrelated bytes outside a supplied view', () => {
    const name = 'raw.traces.pb.zst', data = read(`controls/${name}`);
    const padded = new Uint8Array(data.length + 23).fill(255);
    padded.set(data, 13);
    const actual = decodeTraceFile(padded.subarray(13, 13 + data.length), name);
    const original = readFileSync(new URL('../studies/otlp-binary/fixtures/http-01.traces.pb', import.meta.url));
    const expected = decodeTraceFile(original, 'request.traces.pb');
    expect(actual.text).toEqual(expected.text);
    expect(actual.sourceFormat).toBe(expected.sourceFormat);
    expect(parseTraceInputs([actual]).compression?.carrier).toBe('native-file');
  });
});

describe('atomic compressed-input failures', () => {
  it.each(controls.cases.filter(row => row.expected !== 'accept'))('refuses $file without returning earlier batches', row => {
    expect(() => decodeTraceFile(read(`controls/${row.file}`), row.file)).toThrow('No compressed batches were imported');
  });
  it('keeps signal/framing explicit and refuses a raw request declaration for a Collector carrier', () => {
    const bytes = read('fixtures/legacy/traces.traces.otlp.zst');
    expect(() => decodeTraceFile(bytes, 'capture.zst')).toThrow('Declare the compressed payload');
    expect(() => decodeTraceFile(bytes, 'capture.traces.pb.zst')).toThrow('use .otlp.zst');
  });
  it('does not infer retransmissions are new spans when compressed and plain files overlap', () => {
    const plain = decodeTraceFile(read('fixtures/native/traces.jsonl'), 'traces.jsonl');
    const compressed = decodeTraceFile(read('fixtures/native/traces.jsonl.zst'), 'traces.jsonl.zst');
    expect(() => parseTraceInputs([plain, compressed])).toThrow('Duplicate span identity');
  });
});
