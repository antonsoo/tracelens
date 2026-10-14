import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareTraces, DEFAULT_PRICE_TABLE, parseOtlpJson, buildSummary } from '../src/core/index.js';
import { decodeStatus } from '../src/core/status.js';
import type { StatusCode } from '../src/core/types.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../studies/status-evidence/fixtures/${name}.json`, import.meta.url), 'utf8'));
const native = parseOtlpJson(fixture('native-integers'));
const sdkOracle = fixture('oracle') as { spans: { spanId: string; status: string; description: string | null }[] };
const errorObservation = sdkOracle.spans.find(span => span.status === 'ERROR')!;
const errorId = errorObservation.spanId;

describe('native SDK status evidence', () => {
  it('keeps the exact same error under reference-decoder-confirmed enum representations', () => {
    const oracle = fixture('oracle') as { variants: { name: string; protobuf: { accepted: boolean; errorSpanCode?: number } }[] };
    for (const name of ['native-integers', 'native-names', 'quoted-integer', 'quoted-leading-zero', 'quoted-signed-integer', 'quoted-surrounding-space']) {
      expect(oracle.variants.find(variant => variant.name === name)!.protobuf).toEqual({ accepted: true, errorSpanCode: 2 });
      const trace = parseOtlpJson(fixture(name));
      expect(trace.spans.find(span => span.spanId === errorId)!.status.code).toBe('ERROR');
      expect(buildSummary(trace, DEFAULT_PRICE_TABLE).errorCount).toBe(1);
      expect(compareTraces(native, trace, DEFAULT_PRICE_TABLE).metrics.errors.delta).toBe(0);
    }
  });

  it.each(['unknown-future-code', 'invalid-name', 'invalid-fraction', 'invalid-boolean', 'invalid-substring-name'])(
    'retains %s without claiming fewer errors or no possible retry', name => {
      const trace = parseOtlpJson(fixture(name));
      const status = trace.spans.find(span => span.spanId === errorId)!.status;
      expect(status.code).toBe('UNKNOWN');
      expect(status.raw).toBeDefined();
      expect(trace.warnings.some(warning => warning.spanId === errorId)).toBe(true);
      const summary = buildSummary(trace, DEFAULT_PRICE_TABLE);
      expect(summary.errorCount).toBe(0);
      expect(summary.unknownStatusCount).toBe(1);
      expect(summary.retryCount).toBe(0);
      expect(summary.unknownRetryCount).toBe(1);
      const report = compareTraces(native, trace, DEFAULT_PRICE_TABLE);
      expect(report.metrics.errors.candidate).toEqual({ value: 0, missing: 1 });
      expect(report.metrics.errors.delta).toBeNull();
      expect(report.metrics.errors.percent).toBeNull();
      expect(report.metrics.calls.delta).toBe(0);
      expect(report.metrics.selfTimeMs.delta).toBe(0);
      expect(report.wallTimeMs.delta).toBe(0);
      expect(report.operations.flatMap(op => op.candidateCalls).find(call => call.spanId === errorId)!.error).toBeNull();
    },
  );

  it('honors unknown outcomes constructed directly through the public ParsedTrace API', () => {
    const trace = parseOtlpJson(fixture('native-integers'));
    trace.spans.find(span => span.spanId === errorId)!.status.code = 'unreadable' as StatusCode;
    expect(compareTraces(native, trace, DEFAULT_PRICE_TABLE).metrics.errors.delta).toBeNull();
    expect(buildSummary(trace, DEFAULT_PRICE_TABLE).unknownStatusCount).toBe(1);
  });
});

describe('status defaults and raw field retention', () => {
  it.each([undefined, null, {}, { code: null }, { code: 0 }])('keeps legitimate default %j as UNSET', raw => {
    const warnings: string[] = [];
    expect(decodeStatus(raw, message => warnings.push(message))).toEqual({ code: 'UNSET' });
    expect(warnings).toEqual([]);
  });
  it.each([false, 2, 'ERROR', [], { code: false }, { code: '' }, { code: [] }, { code: {} }])('does not coerce malformed shape %j to an observation', raw => {
    const warnings: string[] = [];
    expect(decodeStatus(raw, message => warnings.push(message))).toEqual({ code: 'UNKNOWN', raw });
    expect(warnings).toHaveLength(1);
  });
  it('retains an invalid message without hiding the independently known error code', () => {
    const raw = { code: 2, message: { arbitrary: 'opaque text' } };
    const warnings: string[] = [];
    expect(decodeStatus(raw, message => warnings.push(message))).toEqual({ code: 'ERROR', raw });
    expect(warnings).toHaveLength(1);
  });
});

describe('Jaeger status declarations', () => {
  const tagsTrace = (tags: unknown[]) => {
    const doc = fixture('native-jaeger') as { data: { spans: { spanID: string; tags: { key: string }[] }[] }[] };
    const span = doc.data[0]!.spans.find(span => span.spanID === errorId)!;
    span.tags = [...span.tags.filter(tag => !['otel.status_code', 'error'].includes(tag.key)), ...tags] as { key: string }[];
    return parseOtlpJson(doc);
  };
  it.each([
    [{ key: 'otel.status_code', type: 'string', value: 'garbled' }],
    [{ key: 'error', type: 'string', value: 'maybe' }],
    [{ key: 'otel.status_code', type: 'string', value: 'ERROR' }, { key: 'otel.status_code', type: 'string', value: 'OK' }],
  ])('does not choose a zero-error winner from unreadable tags', (...tags) => {
    const trace = tagsTrace(tags);
    expect(trace.spans.find(span => span.spanId === errorId)!.status).toEqual({ code: 'UNKNOWN', raw: [
      { key: 'otel.status_description', type: 'string', value: errorObservation.description }, ...tags,
    ] });
    expect(buildSummary(trace, DEFAULT_PRICE_TABLE).unknownStatusCount).toBe(1);
  });
  it('preserves independently recorded failure and the other unreadable declaration', () => {
    const tags = [{ key: 'otel.status_code', type: 'string', value: 'garbled' }, { key: 'error', type: 'bool', value: true }];
    const trace = tagsTrace(tags);
    const status = trace.spans.find(span => span.spanId === errorId)!.status;
    expect(status.code).toBe('ERROR');
    expect(status.raw).toEqual(expect.arrayContaining(tags));
    expect(buildSummary(trace, DEFAULT_PRICE_TABLE).errorCount).toBe(1);
    expect(trace.warnings.some(warning => warning.message.includes('independent'))).toBe(true);
  });
});
