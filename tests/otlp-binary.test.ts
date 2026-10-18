import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeTraceFile, protobufFormat, MAX_PROTOBUF_BYTES } from '../src/core/trace-file.js';
import { parseTraceInputs } from '../src/core/otlp-parser.js';
import { buildTiming } from '../src/core/timing.js';
import { buildCostReport } from '../src/core/cost-report.js';
import type { ParsedSpan, ParsedTrace, TraceInput } from '../src/core/types.js';

const directory = new URL('../studies/otlp-binary/fixtures/', import.meta.url);
const bytes = (name: string): Uint8Array => readFileSync(new URL(name, directory));
const input = (name: string): TraceInput => decodeTraceFile(bytes(name), name);
interface NativeSpan { traceId: string; spanId: string; name: string; start: string; end: string; parentSpanId: string | null; status: string; attributes: Record<string, unknown>; links: { traceId: string; spanId: string }[] }
interface NativeOracle { spans: NativeSpan[]; logs: { traceId: string; spanId: string; timestamp: string | null; observedTimestamp: string | null; eventName: string; attributes: unknown; body: unknown }[]; requests: { file: string }[] }
const oracle = JSON.parse(readFileSync(new URL('oracle.json', directory), 'utf8')) as NativeOracle;
const nativeTraces = [...new Set(oracle.spans.map(s => s.traceId))];
const collector = ['collector.traces.otlp', 'collector.logs.otlp'].map(input);
const jsonControls = ['collector-traces.jsonl', 'collector-logs.jsonl'].map(input);
const raw = oracle.requests.map(row => input(row.file));
const controlsDirectory = new URL('../studies/otlp-binary/controls/', import.meta.url);
const controls = JSON.parse(readFileSync(new URL('oracle.json', controlsDirectory), 'utf8')) as { cases: { name: string; file: string; googleAccepted: boolean; jsonControl: string | null }[] };

/** Compare normalized evidence, without erasing user attribute names or values. */
function evidence(trace: ParsedTrace): unknown {
  return {
    traceId: trace.traceId, traces: trace.traces, roots: trace.roots.map(s => s.spanId),
    spans: trace.spans.map((span: ParsedSpan) => ({
      traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
      name: span.name, kind: span.kind, start: span.startTimeUnixNano, end: span.endTimeUnixNano,
      status: span.status, attributes: span.attributes, resourceAttributes: span.resourceAttributes,
      scopeName: span.scopeName, scopeVersion: span.scopeVersion, events: span.events,
      links: span.links, genai: span.genai, agentKind: span.agentKind,
      logs: span.logs?.map(log => ({ traceId: log.traceId, spanId: log.spanId,
        eventName: log.eventName, timestamp: log.timeUnixNano,
        attributes: log.attributes, body: log.body, resourceAttributes: log.resourceAttributes,
        scopeName: log.scopeName, scopeVersion: log.scopeVersion })),
    })),
    timing: { ...buildTiming(trace), warnings: [] }, cost: buildCostReport(trace, []),
  };
}

describe('actual SDK HTTP and Collector protobuf exports', () => {
  it.each(nativeTraces)('matches the actual JSON controls and original SDK observations for %s', traceId => {
    const expected = parseTraceInputs(jsonControls, { traceId });
    for (const files of [collector, raw]) {
      const trace = parseTraceInputs(files, { traceId });
      expect(evidence(trace)).toEqual(evidence(expected));
      expect(trace.sourceFormat).toBe(files === collector ? 'otlp-protobuf-framed' : 'otlp-protobuf');
      for (const observed of oracle.spans.filter(s => s.traceId === traceId)) {
        const span = trace.spans.find(s => s.spanId === observed.spanId)!;
        expect(span.name).toBe(observed.name);
        expect(span.parentSpanId ?? null).toBe(observed.parentSpanId);
        expect(span.startTimeUnixNano).toBe(BigInt(observed.start));
        expect(span.endTimeUnixNano).toBe(BigInt(observed.end));
        expect(span.attributes).toEqual(observed.attributes);
        expect(span.status.code).toBe(observed.status);
        expect(span.links?.map(link => ({ traceId: link.traceId, spanId: link.spanId })) ?? []).toEqual(observed.links);
      }
      const logs = trace.spans.flatMap(span => span.logs ?? []);
      const nativeLogs = oracle.logs.filter(log => log.traceId === traceId);
      expect(logs).toHaveLength(nativeLogs.length);
      for (const log of nativeLogs) {
        const matched = logs.find(item => item.spanId === log.spanId)!;
        expect(matched.timeUnixNano).toBe(log.timestamp === null ? undefined : BigInt(log.timestamp));
        expect(matched.observedTimeUnixNano).toBe(log.observedTimestamp === null ? undefined : BigInt(log.observedTimestamp));
        expect(matched.eventName).toBe(log.eventName);
        expect(matched.attributes).toEqual(log.attributes);
        expect(matched.body).toEqual(log.body);
        // A protobuf batch is not a physical line in the binary file.
        expect(matched.source.line).toBeUndefined();
      }
    }
  });

  it('keeps protobuf context when a single framed file is reparsed to choose another trace', () => {
    const source = input('collector.traces.otlp');
    expect(source.sourceFormat).toBe('otlp-protobuf-framed');
    for (const traceId of nativeTraces) {
      const parsed = parseTraceInputs([source], { traceId });
      expect(parsed.traceId).toBe(traceId);
      expect(parsed.sourceFormat).toBe(source.sourceFormat);
      expect(parsed.spans).toHaveLength(oracle.spans.filter(s => s.traceId === traceId).length);
    }
  });

  it('handles Buffer views with unrelated bytes on both sides', () => {
    const payload = bytes('collector.traces.otlp');
    const buffer = new Uint8Array(payload.length + 37).fill(0xff);
    buffer.set(payload, 13);
    expect(decodeTraceFile(buffer.subarray(13, 13 + payload.length), 'traces.otlp')).toEqual({ ...input('collector.traces.otlp'), name: 'traces.otlp' });
  });

  it('supports mixed JSON/protobuf groups and rejects retransmitted span identities', () => {
    const mixed = parseTraceInputs([input('collector.traces.otlp'), input('collector-logs.jsonl')]);
    expect(mixed.sourceFormat).toBe('mixed');
    expect(mixed.spans.flatMap(span => span.logs ?? [])).toHaveLength(2);
    expect(() => parseTraceInputs([input('collector.traces.otlp'), input('collector-traces.jsonl')])).toThrow('Duplicate span identity');
  });
});

describe('explicit protobuf framing and atomic input failures', () => {
  it.each(controls.cases)('agrees with the independent Google runtime on $name', control => {
    const buffer = readFileSync(new URL(control.file, controlsDirectory));
    if (!control.googleAccepted) {
      expect(() => decodeTraceFile(buffer, control.file)).toThrow('could not be decoded');
      return;
    }
    const decoded = decodeTraceFile(buffer, control.file);
    const reference = decodeTraceFile(readFileSync(new URL(control.jsonControl!, controlsDirectory)), 'reference.json');
    const actual = parseTraceInputs([decoded]);
    const expected = parseTraceInputs([reference]);
    expected.warnings.unshift(...(decoded.warnings ?? []));
    expect(evidence(actual)).toEqual(evidence(expected));
    if (control.name === 'unknown-field') expect(actual.warnings.some(w => w.message.includes('1 unrecognized wire field'))).toBe(true);
    if (control.name === 'oneof-last-wins') expect(actual.spans[0]!.attributes['fixture.repeated_oneof']).toBe(7);
    if (control.name === 'unknown-status') expect(actual.spans[0]!.status).toEqual({ code: 'UNKNOWN', raw: { code: 99 } });
  });

  it('requires an explicit signal and framing, without using directory names as declarations', () => {
    expect(protobufFormat('/tmp/run.traces.pb')).toEqual({ signal: 'traces', framing: 'raw' });
    expect(protobufFormat('C:\\captures\\traces.otlp')).toEqual({ signal: 'traces', framing: 'collector' });
    expect(protobufFormat('capture.logs.PB')).toEqual({ signal: 'logs', framing: 'raw' });
    expect(protobufFormat('traces.pb/capture.bin')).toBeUndefined();
    expect(() => decodeTraceFile(bytes('http-01.traces.pb'), 'capture.pb')).toThrow('Declare the protobuf signal and framing');
    expect(decodeTraceFile(bytes('http-01.traces.pb'), 'capture.bin', { signal: 'traces', framing: 'raw' }).sourceFormat).toBe('otlp-protobuf');
  });

  it('rejects incomplete prefixes and bodies instead of importing earlier batches', () => {
    const payload = bytes('collector.traces.otlp');
    for (const tail of [1, 2, 3]) {
      const truncated = new Uint8Array(payload.length + tail);
      truncated.set(payload);
      expect(() => decodeTraceFile(truncated, 'traces.otlp')).toThrow('incomplete four-byte length prefix');
    }
    expect(() => decodeTraceFile(payload.subarray(0, payload.length - 1), 'traces.otlp')).toThrow('No batches were imported');
    expect(() => decodeTraceFile(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 'traces.otlp')).toThrow('declares 4294967295 bytes');
  });

  it('accepts a complete empty batch between native batches without making it a span', () => {
    const payload = bytes('collector.traces.otlp');
    const withEmpty = new Uint8Array(payload.length + 4);
    withEmpty.set(payload, 4);
    const trace = parseTraceInputs([decodeTraceFile(withEmpty, 'traces.otlp')]);
    expect(trace.traces.reduce((count, entry) => count + entry.spanCount, 0)).toBe(6);
  });

  it('does not retry malformed JSON or protobuf with another parser', () => {
    const text = new TextEncoder().encode('{broken JSON}');
    expect(decodeTraceFile(text, 'trace.json')).toEqual({ name: 'trace.json', text: '{broken JSON}' });
    expect(() => parseTraceInputs([decodeTraceFile(text, 'trace.json')])).toThrow('Not valid JSON');
    expect(() => decodeTraceFile(text, 'traces.pb')).toThrow('could not be decoded');
    expect(() => decodeTraceFile(bytes('http-01.traces.pb'), 'traces.otlp')).toThrow('declares');
  });

  it('bounds binary file size before decoding', () => {
    expect(() => decodeTraceFile(new Uint8Array(MAX_PROTOBUF_BYTES + 1), 'traces.pb')).toThrow('25 MB');
  });
});
