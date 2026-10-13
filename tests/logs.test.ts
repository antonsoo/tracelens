import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOtlpJson, parseTraceInputs, parseTraceText } from '../src/core/otlp-parser.js';
import { buildLogsReport } from '../src/core/logs.js';
import { buildSummary } from '../src/core/summary.js';
import { DEFAULT_PRICE_TABLE } from '../src/core/pricing.js';
import { flattenTrace, restoreTrace } from '../src/web/trace-transfer.js';
import { attr, fakeSpan, otlpDoc, sv } from './fixtures.js';

const a = 'a'.repeat(32), b = 'b'.repeat(32), id = '1'.repeat(16);
const span = (traceId = a) => fakeSpan({ traceId, spanId: id, startNs: 1000, endNs: 9000,
  attributes: [attr('gen_ai.operation.name', sv('chat'))] });
const logDoc = (logs: unknown[]) => ({ resourceLogs: [{ resource: { attributes: [attr('service.name', sv('logger'))] },
  scopeLogs: [{ scope: { name: 'logger-scope', version: '1' }, logRecords: logs }] }] });
const log = (extra = {}) => ({ traceId: a, spanId: id, eventName: 'gen_ai.client.inference.operation.details',
  timeUnixNano: '5000', attributes: [attr('gen_ai.input.messages', sv('[{"role":"user","parts":[{"type":"text","content":"Recorded prompt"}]}]'))], ...extra });
const input = (name: string, json: unknown) => ({ name, text: JSON.stringify(json) });

describe.each(['event-only', 'span-and-event'])('real GenAI SDK capture: %s', mode => {
  const fixture = (name: string) => readFileSync(new URL(`../studies/log-events/capture-${mode}/${name}`, import.meta.url), 'utf8');
  const traces = fixture('traces.json'), logs = fixture('logs.json');
  const oracle = JSON.parse(fixture('oracle.json')) as { logs: { spanId: string; attributes: Record<string, unknown> }[] };
  it('joins separately exported messages and tool data without adding calls or charges', () => {
    const joined = parseTraceInputs([{ name: 'traces.json', text: traces }, { name: 'logs.json', text: logs }]);
    expect(joined.spans).toHaveLength(4);
    expect(joined.warnings).toEqual([]);
    expect(joined.unmatchedLogs).toBeUndefined();
    expect(buildLogsReport(joined).matchedRecords).toBe(2);
    for (const expected of oracle.logs) {
      const actual = joined.spans.find(s => s.spanId === expected.spanId)!;
      expect(actual.logs).toHaveLength(1);
      expect(actual.logs![0]!.source.file).toEqual({ index: 2, name: 'logs.json' });
      for (const [attribute, field] of [['gen_ai.input.messages', 'inputMessages'], ['gen_ai.output.messages', 'outputMessages']] as const) {
        const messages = expected.attributes[attribute] as { role: string; parts: unknown[] }[];
        expect(actual.genai?.[field]).toEqual(messages.map(({ role, parts }) => ({ role, parts })));
      }
      if (expected.attributes['gen_ai.system_instructions']) {
        expect(actual.genai?.systemInstructions).toEqual([{ role: 'system', parts: expected.attributes['gen_ai.system_instructions'] }]);
      }
    }
    const before = buildSummary(parseTraceText(traces), DEFAULT_PRICE_TABLE);
    const after = buildSummary(joined, DEFAULT_PRICE_TABLE);
    for (const key of ['spanCount', 'errorCount', 'retryCount', 'totalDurationMs', 'llmSelfTimeMs', 'toolSelfTimeMs', 'modelUsage', 'totalCostUsd'] as const) {
      expect(after[key]).toEqual(before[key]);
    }
    const transferred = restoreTrace(structuredClone(flattenTrace(joined)));
    expect(buildLogsReport(transferred)).toEqual(buildLogsReport(joined));
  });
  it('supports both signals in a document or JSONL, and logs preceding traces in a file group', () => {
    const documents = parseOtlpJson({ ...JSON.parse(traces), ...JSON.parse(logs) });
    const lines = parseTraceText('\n' + JSON.stringify(JSON.parse(logs)) + '\n\n' + JSON.stringify(JSON.parse(traces)));
    const reversed = parseTraceInputs([{ name: 'logs', text: logs }, { name: 'traces', text: traces }]);
    expect(documents.spans.map(s => s.genai)).toEqual(lines.spans.map(s => s.genai));
    expect(reversed.spans.map(s => s.genai)).toEqual(lines.spans.map(s => s.genai));
    expect(lines.spans.flatMap(s => s.logs ?? []).every(r => r.source.line === 2)).toBe(true);
  });
});

it('joins the complete identity even when another trace reuses the span ID', () => {
  const trace = parseTraceInputs([input('trace', otlpDoc([span(a), span(b)])),
    input('logs', logDoc([log({ traceId: b })]))], { traceId: a });
  expect(trace.spans[0]!.logs).toBeUndefined();
  expect(trace.unmatchedLogs).toBeUndefined();
  const selected = parseTraceInputs([input('trace', otlpDoc([span(a), span(b)])),
    input('logs', logDoc([log({ traceId: b })]))], { traceId: b });
  expect(selected.spans[0]!.genai?.inputMessages?.[0]?.parts[0]?.content).toBe('Recorded prompt');
});

it('normalizes hex and protobuf base64 context without changing raw evidence', () => {
  const raw = log({ traceId: Buffer.from(a, 'hex').toString('base64'), spanId: Buffer.from(id, 'hex').toString('base64') });
  const trace = parseTraceInputs([input('trace', otlpDoc([span()])), input('logs', logDoc([raw]))]);
  expect(trace.spans[0]!.logs?.[0]?.raw).toEqual(raw);
  expect(trace.spans[0]!.logs?.[0]?.traceId).toBe(a);
});

it.each([
  { traceId: undefined }, { spanId: undefined }, { traceId: '0'.repeat(32) },
  { spanId: '0'.repeat(16) }, { traceId: b }, { spanId: '2'.repeat(16) },
])('retains unmatched records without guessing from names or clocks: %j', extra => {
  const raw = log(extra);
  const trace = parseTraceInputs([input('trace', otlpDoc([span()])), input('logs', logDoc([raw]))]);
  expect(trace.spans[0]!.logs).toBeUndefined();
  expect(trace.unmatchedLogs?.[0]?.raw).toEqual(JSON.parse(JSON.stringify(raw)));
  expect(trace.warnings.some(w => w.message.includes('could not be matched'))).toBe(true);
  expect(buildLogsReport(trace).unmatched).toHaveLength(1);
});

it('does not attach to either duplicate target in another trace', () => {
  const trace = parseOtlpJson({ ...otlpDoc([span(a), span(b), span(b)]),
    ...logDoc([log({ traceId: b })]) }, { traceId: a });
  expect(trace.unmatchedLogs).toHaveLength(1);
  expect(trace.spans[0]!.logs).toBeUndefined();
});

it('does not choose between conflicting trace context spellings', () => {
  const trace = parseOtlpJson({ ...otlpDoc([span()]), ...logDoc([log({ trace_id: b })]) });
  expect(trace.spans[0]!.logs).toBeUndefined();
  expect(trace.unmatchedLogs).toHaveLength(1);
  expect(trace.warnings.some(w => w.message.includes('conflicting traceId'))).toBe(true);
});

it('keeps malformed records and bodies, omission counts, unknown fields and source locations', () => {
  const raw = log({ timeUnixNano: 'invalid', observedTimeUnixNano: '6000', droppedAttributesCount: 3,
    body: { stringValue: 'whole body' }, severityNumber: 17, futureExtension: 'retained' });
  const trace = parseTraceInputs([input('trace', otlpDoc([span()])), input('logs', logDoc([null, raw]))]);
  const retained = trace.spans[0]!.logs![0]!;
  expect(retained.timeUnixNano).toBeUndefined();
  expect(retained.observedTimeUnixNano).toBe(6000n);
  expect(retained.body).toBe('whole body');
  expect(retained.raw).toEqual(raw);
  expect(retained.source.path).toBe('resourceLogs[0].scopeLogs[0].logRecords[1]');
  expect(retained.droppedAttributesCount).toBe(3);
  expect(trace.unmatchedLogs?.[0]?.raw).toBe(null);
  expect(trace.warnings.some(w => w.message.includes('3 log attributes were dropped'))).toBe(true);
  expect(buildSummary(trace, DEFAULT_PRICE_TABLE).errorCount).toBe(0);
});

it('keeps ordinary application logs without inventing message content or model metadata', () => {
  const raw = log({ eventName: 'cache.lookup', body: { stringValue: 'cache miss' },
    attributes: [attr('gen_ai.usage.input_tokens', sv('100000'))] });
  const trace = parseTraceInputs([input('trace', otlpDoc([span()])), input('logs', logDoc([raw]))]);
  expect(trace.spans[0]!.logs?.[0]?.body).toBe('cache miss');
  expect(trace.spans[0]!.genai?.inputMessages).toBeUndefined();
  expect(trace.spans[0]!.genai?.usage).toBeUndefined();
});

it('does not duplicate input when span attributes already contain it', () => {
  const one = span();
  one.attributes.push(...log().attributes);
  const trace = parseTraceInputs([input('trace', otlpDoc([one])), input('logs', logDoc([log()]))]);
  expect(trace.spans[0]!.genai?.inputMessages).toHaveLength(1);
  expect(trace.spans[0]!.logs).toHaveLength(1);
});

it('requires a trace export and rejects malformed middle lines', () => {
  expect(() => parseTraceInputs([input('logs1', logDoc([])), input('logs2', logDoc([log()]))])).toThrow('Select the trace export');
  expect(() => parseTraceText(JSON.stringify(otlpDoc([span()])) + '\n{bad\n' + JSON.stringify(logDoc([log()])))).toThrow('line 2');
});

it('reads protobuf snake_case fields and retains an absent timestamp as unknown', () => {
  const trace = parseOtlpJson({ ...otlpDoc([span()]), resource_logs: [{ scope_logs: [{ log_records: [{
    trace_id: a, span_id: id, event_name: 'local.event', time_unix_nano: '0', body: { string_value: 'exact body' },
  }] }] }] });
  expect(trace.spans[0]!.logs?.[0]?.body).toBe('exact body');
  expect(trace.spans[0]!.logs?.[0]?.eventName).toBe('local.event');
  expect(trace.spans[0]!.logs?.[0]?.timeUnixNano).toBeUndefined();
  expect(trace.warnings).toEqual([]);
});

it('refuses alternate collection aliases instead of silently hiding one set of records', () => {
  expect(() => parseOtlpJson({ ...otlpDoc([span()]), ...logDoc([log()]), resource_logs: [] })).toThrow('both resourceLogs and resource_logs');
});
