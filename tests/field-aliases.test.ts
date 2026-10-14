import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOtlpJson, parseTraceText, TraceParseError } from '../src/core/otlp-parser.js';
import { collectLogs } from '../src/core/logs.js';
import { buildSummary } from '../src/core/summary.js';
import type { ParseWarning } from '../src/core/types.js';

type RawSpan = Record<string, unknown>;
interface Capture {
  resourceSpans: { scopeSpans: { spans: RawSpan[] }[]; [field: string]: unknown }[];
}
const native = JSON.parse(readFileSync(new URL('./fixtures/census/strands-legacy-events-tool-call.json', import.meta.url), 'utf8')) as Capture;
const clone = () => structuredClone(native);
const span = (json: Capture) => json.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;

describe('alternate protocol field declarations', () => {
  it('does not silently erase five unchanged native child spans and two model calls', () => {
    const complete = parseOtlpJson(clone());
    const summary = buildSummary(complete, []);
    expect(summary.spanCount).toBe(6);
    expect(summary.modelUsage).toMatchObject([{ calls: 2, inputTokens: 175, outputTokens: 26 }]);
    const mixed = { resourceSpans: [native.resourceSpans.at(-1)], resource_spans: native.resourceSpans.slice(0, -1) };
    expect(() => parseTraceText(JSON.stringify(mixed))).toThrow(/both resourceSpans and resource_spans/);
  });

  it('checks each JSON Lines batch before combining its resources', () => {
    const mixed = { resourceSpans: [native.resourceSpans.at(-1)], resource_spans: native.resourceSpans.slice(0, -1) };
    expect(() => parseTraceText(`${JSON.stringify(mixed)}\n${JSON.stringify({ resourceSpans: [] })}`))
      .toThrow(/Line 1 contains both resourceSpans and resource_spans/);
  });

  it('refuses competing scope collections even when one is empty', () => {
    const json = clone();
    json.resourceSpans[0]!.scope_spans = json.resourceSpans[0]!.scopeSpans;
    json.resourceSpans[0]!.scopeSpans = [];
    expect(() => parseOtlpJson(json)).toThrow(/both scopeSpans and scope_spans/);
  });

  it.each([
    ['traceId', 'trace_id'], ['spanId', 'span_id'], ['parentSpanId', 'parent_span_id'],
    ['startTimeUnixNano', 'start_time_unix_nano'], ['endTimeUnixNano', 'end_time_unix_nano'],
    ['droppedAttributesCount', 'dropped_attributes_count'], ['droppedEventsCount', 'dropped_events_count'],
    ['droppedLinksCount', 'dropped_links_count'],
  ])('refuses duplicate span field %s before using its measurement or identity', (camel, snake) => {
    const json = clone();
    const raw = span(json);
    raw[camel] ??= 0;
    raw[snake] = raw[camel];
    expect(() => parseOtlpJson(json)).toThrow(new RegExp(`both ${camel} and ${snake}`));
  });

  it.each([
    ['timeUnixNano', 'time_unix_nano'], ['droppedAttributesCount', 'dropped_attributes_count'],
  ])('does not select an event %s declaration', (camel, snake) => {
    const json = clone();
    span(json).events = [{ name: 'controlled', [camel]: 0, [snake]: 1 }];
    expect(() => parseOtlpJson(json)).toThrow(new RegExp(`both ${camel} and ${snake}`));
  });

  it.each([
    ['traceId', 'trace_id'], ['spanId', 'span_id'], ['traceState', 'trace_state'],
    ['droppedAttributesCount', 'dropped_attributes_count'],
  ])('does not select a link %s declaration', (camel, snake) => {
    const json = clone();
    const target = span(json);
    const link = { traceId: target.traceId, spanId: target.spanId, [camel]: target[camel] ?? 'x' };
    span(json).links = [{ ...link, [snake]: link[camel] }];
    expect(() => parseOtlpJson(json)).toThrow(new RegExp(`both ${camel} and ${snake}`));
  });

  it('accepts one snake-case declaration and null/unset companions without losing native calls', () => {
    const fields = [['traceId', 'trace_id'], ['spanId', 'span_id'], ['parentSpanId', 'parent_span_id'],
      ['startTimeUnixNano', 'start_time_unix_nano'], ['endTimeUnixNano', 'end_time_unix_nano']] as const;
    const resources = clone().resourceSpans.map(({ scopeSpans, ...resource }) => ({
      ...resource,
      scope_spans: scopeSpans.map(scope => ({ ...scope, spans: scope.spans.map(raw => {
        for (const [camel, snake] of fields) {
          if (camel in raw) { raw[snake] = raw[camel]; raw[camel] = null; }
        }
        return raw;
      }) })),
    }));
    const json = { resourceSpans: null, resource_spans: resources };
    const result = buildSummary(parseOtlpJson(json), []);
    expect(result.spanCount).toBe(6);
    expect(result.modelUsage).toMatchObject([{ calls: 2, inputTokens: 175, outputTokens: 26 }]);
  });

  it('keeps ambiguous log scalar evidence without inventing a time, name or omission count', () => {
    const warnings: ParseWarning[] = [];
    const raw = { eventName: 'one', event_name: 'two', timeUnixNano: '1', time_unix_nano: '2',
      observedTimeUnixNano: '3', observed_time_unix_nano: '4', droppedAttributesCount: 0, dropped_attributes_count: 99 };
    const records = collectLogs([{ json: { resourceLogs: [{ scopeLogs: [{ logRecords: [raw] }] }] } }], warnings);
    expect(records).toHaveLength(1);
    expect(records[0]!.raw).toEqual(raw);
    expect(records[0]!.eventName).toBeUndefined();
    expect(records[0]!.timeUnixNano).toBeUndefined();
    expect(records[0]!.observedTimeUnixNano).toBeUndefined();
    expect(records[0]!.droppedAttributesCount).toBeUndefined();
    expect(warnings).toHaveLength(4);
    expect(warnings.every(w => /kept the raw fields without selecting a value/.test(w.message))).toBe(true);
  });

  it('uses the structured import error type for ambiguous trace fields', () => {
    expect(() => parseOtlpJson({ resourceSpans: [], resource_spans: [] })).toThrow(TraceParseError);
  });
});
