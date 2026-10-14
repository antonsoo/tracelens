// Parses OTLP/JSON trace exports — the shape produced by the OpenTelemetry
// Collector's file/JSON exporter, or by protobuf's `MessageToJson` on an
// `ExportTraceServiceRequest`: resourceSpans -> scopeSpans -> spans, with
// every attribute value as a typed `AnyValue` object. Spec:
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/common/v1/common.proto
// (verified against the `main` branch, 2026-09-24).
import type { ParseWarning, ParsedSpan, ParsedTrace, SpanEvent, SpanKind, SpanLink, TraceInput, TraceListing } from './types.js';
import { normalizeSpan } from './normalize.js';
import { isJaegerJson, jaegerToOtlp } from './jaeger.js';
import { normalizeId } from './identity.js';
import { assertPayloadDepth, TraceParseError } from './payload-depth.js';
import { traceField } from './field-alias.js';
import { decodeAttributes } from './attributes.js';
import { collectLogs, correlateLogs, hasLogSignal, type LogBatch } from './logs.js';
import { decodeStatus } from './status.js';
export { TraceParseError } from './payload-depth.js';
export { decodeAnyValue } from './attributes.js';

const SPAN_KIND_BY_NUMBER: Record<number, SpanKind> = {
  0: 'UNSPECIFIED',
  1: 'INTERNAL',
  2: 'SERVER',
  3: 'CLIENT',
  4: 'PRODUCER',
  5: 'CONSUMER',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** ProtoJSON permits omitted/null repeated fields, but not a non-array value. */
function spanCollection(raw: unknown, path: string, warnings: ParseWarning[]): unknown[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw;
  warnings.push({ comparisonIssue: 'span-inventory', message: `${path}: expected an array; contained span evidence could not be imported. The number and trace identities of missing spans are unknown.` });
  return [];
}

function toBigNanos(raw: unknown): bigint | undefined {
  // fixed64 timestamps: decimal strings preserve precision at epoch scale.
  if (typeof raw === 'number' && (!Number.isSafeInteger(raw) || raw < 0)) return undefined;
  if (typeof raw === 'string' && (!/^\d{1,20}$/.test(raw))) return undefined;
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const value = BigInt(raw);
  return value <= 18_446_744_073_709_551_615n ? value : undefined;
}

const VALID_SPAN_KIND_NAMES = new Set<string>(Object.values(SPAN_KIND_BY_NUMBER));

function decodeSpanKind(raw: unknown): SpanKind {
  if (typeof raw === 'number') return SPAN_KIND_BY_NUMBER[raw] ?? 'UNSPECIFIED';
  if (typeof raw === 'string') {
    const cleaned = raw.replace('SPAN_KIND_', '');
    if (VALID_SPAN_KIND_NAMES.has(cleaned)) return cleaned as SpanKind;
  }
  return 'UNSPECIFIED';
}

function decodeEvents(raw: unknown, warnings: ParseWarning[], spanId: string, traceId: string): SpanEvent[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push({ message: 'Invalid events collection; its events could not be imported.', spanId, traceId });
    return [];
  }
  return raw.flatMap((e, index) => {
    if (!isRecord(e)) {
      warnings.push({ message: 'Skipped a non-object entry in "events".', spanId, traceId });
      return [];
    }
    const rec = e;
    const name = typeof rec.name === 'string' ? rec.name : '';
    const droppedAttributesCount = droppedCount(traceField(rec, 'droppedAttributesCount', 'dropped_attributes_count', `events[${index}]`),
      'droppedAttributesCount', `Event ${index + 1} ("${name}")`, 'attributes', warnings, spanId, traceId);
    const time = toBigNanos(traceField(rec, 'timeUnixNano', 'time_unix_nano', `events[${index}]`) ?? 0);
    if (time === undefined) {
      warnings.push({ message: 'Skipped an event with an invalid timestamp.', spanId, traceId });
      return [];
    }
    return [{
      name,
      timeUnixNano: time,
      attributes: decodeAttributes(rec.attributes, message => warnings.push({ message, spanId, traceId }), `events[${index}].attributes`),
      ...(droppedAttributesCount !== undefined ? { droppedAttributesCount } : {}),
    }];
  });
}

function optionalUint32(raw: unknown, field: string, warnings: ParseWarning[], spanId: string, traceId: string): number | undefined {
  if (raw === undefined || raw === null) return undefined; // ProtoJSON null leaves a field unset.
  // ProtoJSON accepts both numeric and quoted numeric values, including exponents.
  if (typeof raw === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) raw = Number(raw);
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 0xffff_ffff) return raw;
  warnings.push({ message: `Invalid ${field}; its value is unknown.`, spanId, traceId });
  return undefined;
}

/** Positive omission counts describe evidence absent before import, not parser loss. */
function droppedCount(raw: unknown, field: string, subject: string, kind: 'attributes' | 'events', warnings: ParseWarning[], spanId: string, traceId: string): number | undefined {
  const count = optionalUint32(raw, `${subject} ${field}`, warnings, spanId, traceId);
  if (count !== undefined && count > 0) {
    warnings.push({ message: `${subject} reports ${count} dropped ${kind}; this export does not contain them.`, spanId, traceId });
  }
  return count;
}

function decodeLinks(raw: unknown, warnings: ParseWarning[], spanId: string, traceId: string): { links: SpanLink[]; invalidLinkCount?: number } {
  if (raw === undefined) return { links: [] };
  if (!Array.isArray(raw)) {
    warnings.push({ message: 'Invalid links collection; link evidence could not be read.', spanId, traceId });
    return { links: [] };
  }
  let invalid = 0;
  const links: SpanLink[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) { invalid++; continue; }
    const targetTrace = normalizeId(traceField(entry, 'traceId', 'trace_id', `links[${index}]`), 16);
    const targetSpan = normalizeId(traceField(entry, 'spanId', 'span_id', `links[${index}]`), 8);
    if (!targetTrace || !targetSpan) { invalid++; continue; }
    const traceState = traceField(entry, 'traceState', 'trace_state', `links[${index}]`);
    const flags = optionalUint32(entry.flags, 'link flags', warnings, spanId, traceId);
    const dropped = optionalUint32(traceField(entry, 'droppedAttributesCount', 'dropped_attributes_count', `links[${index}]`), 'link droppedAttributesCount', warnings, spanId, traceId);
    links.push({ traceId: targetTrace, spanId: targetSpan, attributes: decodeAttributes(entry.attributes, message => warnings.push({ message, spanId, traceId }), `links[${index}].attributes`),
      ...(typeof traceState === 'string' ? { traceState } : {}),
      ...(flags !== undefined ? { flags } : {}),
      ...(dropped !== undefined ? { droppedAttributesCount: dropped } : {}),
    });
  }
  if (invalid) warnings.push({ message: `Skipped ${invalid} malformed link record(s) with missing traceId/spanId.`, spanId, traceId });
  return { links, ...(invalid ? { invalidLinkCount: invalid } : {}) };
}

export interface ParseOptions {
  /**
   * Which trace to read from a file that holds several: a trace ID, or the
   * start of one if no other trace in the file starts the same way. Without
   * it, the trace with the most spans is read (the earliest, on a tie).
   */
  traceId?: string;
}

function describeListing(t: TraceListing): string {
  return `${t.traceId} (${t.rootName}, ${t.spanCount} ${t.spanCount === 1 ? 'span' : 'spans'})`;
}

function listTraces(listings: TraceListing[]): string {
  const shown = listings.slice(0, 10).map(describeListing).join('; ');
  return listings.length > 10 ? `${shown}; and ${listings.length - 10} more` : shown;
}

/** The trace the options ask for, or the default: the one with the most spans, the earliest on a tie. */
function chooseTrace(listings: TraceListing[], wanted: string | undefined, scope = 'this file'): TraceListing {
  if (wanted === undefined) {
    return listings.reduce((best, t) => (t.spanCount > best.spanCount ? t : best));
  }
  const supplied = wanted.trim();
  const prefix = /^[\da-f]+$/i.test(supplied) ? supplied.toLowerCase() : supplied;
  const exact = listings.find((t) => t.traceId === prefix)
    ?? listings.find((t) => t.traceId === normalizeId(supplied, 16));
  if (exact) return exact;
  const matches = prefix.length > 0 ? listings.filter((t) => t.traceId.startsWith(prefix)) : [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new TraceParseError(`"${wanted}" is the start of ${matches.length} trace IDs in ${scope}: ${listTraces(matches)}.`);
  }
  throw new TraceParseError(`No trace in ${scope} has the ID "${wanted}". Available: ${listTraces(listings)}.`);
}

/**
 * Parses a raw OTLP/JSON `ExportTraceServiceRequest` document (or a bare
 * `resourceSpans` array) into a flat span list plus a computed tree. Throws
 * `TraceParseError` on structurally invalid input; individual malformed
 * spans are skipped with a warning rather than aborting the whole parse.
 * A file with several traces yields one of them (see `ParseOptions`) and
 * lists them all in `traces`.
 */
function collectSpans(json: unknown, allowEmpty = false): {
  all: ParsedSpan[]; warnings: ParseWarning[]; sourceFormat: 'otlp-json' | 'jaeger-json';
} {
  assertPayloadDepth(json);
  // Collect warnings for the whole file, then narrow to the chosen trace below.
  // Conversion warnings use the same trace/span scoping as OTLP warnings.
  const warnings: ParseWarning[] = [];
  // Jaeger's native JSON is converted up front, so it gets the same validation.
  const sourceFormat = isJaegerJson(json) ? 'jaeger-json' : 'otlp-json';
  if (sourceFormat === 'jaeger-json') json = jaegerToOtlp(json, warnings);
  const root = isRecord(json) ? json : { resourceSpans: json };
  const resourceSpans = traceField(root, 'resourceSpans', 'resource_spans', 'Trace export') ?? (hasLogSignal(root) ? [] : undefined);
  if (!Array.isArray(resourceSpans)) {
    throw new TraceParseError(
      'Not a recognizable trace export: expected OTLP/JSON (a top-level "resourceSpans" array) or Jaeger JSON (a "data" array of traces with "spans").',
    );
  }
  if (resourceSpans.length === 0 && !allowEmpty) {
    throw new TraceParseError('This trace file has no resourceSpans — nothing to show. Select a trace export alongside any log files.');
  }

  const all: ParsedSpan[] = [];

  for (const [resourceIndex, rs] of resourceSpans.entries()) {
    const resourcePath = `resourceSpans[${resourceIndex}]`;
    if (!isRecord(rs)) {
      warnings.push({ comparisonIssue: 'span-inventory', message: `${resourcePath}: skipped a non-object resource entry; contained span evidence is unknown.` });
      continue;
    }
    const resourceWarnings: string[] = [];
    const resourceAttributes = decodeAttributes(isRecord(rs.resource) ? rs.resource.attributes : undefined, message => resourceWarnings.push(message), 'resource.attributes');
    const resourceTraces = new Set<string>();
    const scopeSpans = spanCollection(traceField(rs, 'scopeSpans', 'scope_spans', resourcePath), `${resourcePath}.scopeSpans`, warnings);

    for (const [scopeIndex, ss] of scopeSpans.entries()) {
      const scopePath = `${resourcePath}.scopeSpans[${scopeIndex}]`;
      if (!isRecord(ss)) {
        warnings.push({ comparisonIssue: 'span-inventory', message: `${scopePath}: skipped a non-object scope entry; contained span evidence is unknown.` });
        continue;
      }
      const scope = ss.scope;
      const scopeName = isRecord(scope) && typeof scope.name === 'string' ? scope.name : undefined;
      const scopeVersion = isRecord(scope) && typeof scope.version === 'string' ? scope.version : undefined;
      const spans = spanCollection(ss.spans, `${scopePath}.spans`, warnings);

      for (const [spanIndex, raw] of spans.entries()) {
        const spanPath = `${scopePath}.spans[${spanIndex}]`;
        if (!isRecord(raw)) {
          warnings.push({ comparisonIssue: 'span-inventory', message: `${spanPath}: skipped a non-object span entry; its trace identity is unknown.` });
          continue;
        }
        const spanId = normalizeId(traceField(raw, 'spanId', 'span_id', spanPath), 8);
        const spanTraceId = normalizeId(traceField(raw, 'traceId', 'trace_id', spanPath), 16);
        if (!spanId || !spanTraceId) {
          warnings.push({ comparisonIssue: 'span-inventory', message: `${spanPath}: skipped a span with a missing traceId/spanId (name: ${String(raw.name)}).`,
            ...(spanTraceId ? { traceId: spanTraceId } : {}), ...(spanId ? { spanId } : {}) });
          continue;
        }
        resourceTraces.add(spanTraceId);
        const start = toBigNanos(traceField(raw, 'startTimeUnixNano', 'start_time_unix_nano', spanPath));
        let end = toBigNanos(traceField(raw, 'endTimeUnixNano', 'end_time_unix_nano', spanPath));
        if (start === undefined || end === undefined) {
          const advice = sourceFormat === 'jaeger-json'
            ? 'Jaeger startTime and duration must be unsigned microsecond integers, representable as nanosecond timestamps.'
            : 'Use unsigned decimal nanosecond strings (or safe integer numbers).';
          warnings.push({ comparisonIssue: 'span-inventory', message: `Skipped span "${String(raw.name)}" with missing or invalid timestamps. ${advice}`, spanId, traceId: spanTraceId });
          continue;
        }
        if (end < start) {
          warnings.push({
            comparisonIssue: 'span-timing',
            message: `Span "${String(raw.name)}" has an end time before its start time (clock skew?) — clamped to start.`,
            spanId,
            traceId: spanTraceId,
          });
          end = start;
        }

        const parentRaw = traceField(raw, 'parentSpanId', 'parent_span_id', spanPath);
        const parentSpanId = typeof parentRaw === 'string' && parentRaw.length > 0 ? normalizeId(parentRaw, 8) : undefined;
        if (parentRaw != null && typeof parentRaw !== 'string') {
          warnings.push({ comparisonIssue: 'span-ancestry', message: `Span "${String(raw.name)}" has an invalid parentSpanId; its ancestry is unknown and it is shown as a root.`, spanId, traceId: spanTraceId });
        }

        const attributes = decodeAttributes(raw.attributes, message => warnings.push({ message, spanId, traceId: spanTraceId }));
        const name = typeof raw.name === 'string' ? raw.name : '(unnamed span)';
        const droppedAttributesCount = droppedCount(traceField(raw, 'droppedAttributesCount', 'dropped_attributes_count', spanPath),
          'droppedAttributesCount', `Span "${name}"`, 'attributes', warnings, spanId, spanTraceId);
        const droppedEventsCount = droppedCount(traceField(raw, 'droppedEventsCount', 'dropped_events_count', spanPath),
          'droppedEventsCount', `Span "${name}"`, 'events', warnings, spanId, spanTraceId);

        const base: ParsedSpan = {
          traceId: spanTraceId,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name,
          kind: decodeSpanKind(raw.kind),
          startTimeUnixNano: start,
          endTimeUnixNano: end,
          durationNs: end - start,
          status: decodeStatus(raw.status, message => warnings.push({ message, spanId, traceId: spanTraceId }),
            sourceFormat === 'jaeger-json' ? raw._tracelensStatusRaw : undefined),
          attributes,
          events: decodeEvents(raw.events, warnings, spanId, spanTraceId),
          ...(droppedAttributesCount !== undefined ? { droppedAttributesCount } : {}),
          ...(droppedEventsCount !== undefined ? { droppedEventsCount } : {}),
          ...decodeLinks(raw.links, warnings, spanId, spanTraceId),
          droppedLinksCount: optionalUint32(traceField(raw, 'droppedLinksCount', 'dropped_links_count', spanPath), 'droppedLinksCount', warnings, spanId, spanTraceId),
          resourceAttributes,
          ...(scopeName ? { scopeName } : {}),
          ...(scopeVersion ? { scopeVersion } : {}),
          agentKind: 'other',
          convention: 'none',
          depth: 0,
          children: [],
        };
        all.push(base);
      }
    }
    for (const message of resourceWarnings) {
      if (resourceTraces.size) for (const traceId of resourceTraces) warnings.push({ message, traceId });
      else warnings.push({ message });
    }
  }

  if (all.length === 0 && !allowEmpty) {
    throw new TraceParseError('No valid spans were found in this file.');
  }
  return { all, warnings, sourceFormat };
}

export function parseOtlpJson(json: unknown, options: ParseOptions = {}): ParsedTrace {
  const { all, warnings, sourceFormat } = collectSpans(json);
  const unmatchedLogs = correlateLogs(all, collectLogs([{ json }], warnings), warnings);
  return { ...assembleTrace(all, warnings, sourceFormat, options), ...(unmatchedLogs.length ? { unmatchedLogs } : {}) };
}

function assembleTrace(all: ParsedSpan[], warnings: ParseWarning[], sourceFormat: ParsedTrace['sourceFormat'], options: ParseOptions): ParsedTrace {
  const scope = all[0]!.sourceFile ? 'the selected files' : 'this file';
  // A collector's export holds every trace that passed through it, and their span IDs are only
  // unique within a trace. So the spans are grouped by trace first, and one trace is read.
  const byTrace = new Map<string, ParsedSpan[]>();
  for (const span of all) {
    const group = byTrace.get(span.traceId);
    if (group) group.push(span);
    else byTrace.set(span.traceId, [span]);
  }
  const traces: TraceListing[] = [];
  for (const [id, spans] of byTrace) {
    const ids = new Set(spans.map((s) => s.spanId));
    let first = spans[0]!;
    let firstRoot: ParsedSpan | undefined;
    let end = first.endTimeUnixNano;
    for (const s of spans) {
      if (s.startTimeUnixNano < first.startTimeUnixNano) first = s;
      if (s.endTimeUnixNano > end) end = s.endTimeUnixNano;
      const isRoot = s.parentSpanId === undefined || !ids.has(s.parentSpanId);
      if (isRoot && (!firstRoot || s.startTimeUnixNano < firstRoot.startTimeUnixNano)) firstRoot = s;
    }
    traces.push({
      traceId: id,
      spanCount: spans.length,
      rootName: (firstRoot ?? first).name,
      startNs: first.startTimeUnixNano,
      durationNs: end - first.startTimeUnixNano,
    });
  }
  traces.sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0));
  const traceId = chooseTrace(traces, options.traceId, scope).traceId;
  const flat = byTrace.get(traceId)!.map((span) => normalizeSpan(span, (warning) => warnings.push(fromFile(warning, span.sourceFile))));
  const chosenWarnings = warnings.filter((w) => w.traceId === undefined || w.traceId === traceId);

  // Resolve by the complete identity across all parsed traces. Span IDs alone
  // are not unique across traces; duplicate targets must never pick a winner.
  if (flat.some((s) => s.links?.length)) {
    const targets = new Map<string, Map<string, ParsedSpan | null>>();
    for (const [id, spans] of byTrace) {
      const index = new Map<string, ParsedSpan | null>();
      for (const span of spans) index.set(span.spanId, index.has(span.spanId) ? null : span);
      targets.set(id, index);
    }
    for (const span of flat) for (const link of span.links ?? []) {
      const traceTargets = targets.get(link.traceId);
      const target = traceTargets?.get(link.spanId);
      link.target = !traceTargets ? { status: 'missing-trace' }
        : target === null ? { status: 'ambiguous' }
          : target === undefined ? { status: 'missing-span' }
            : { status: 'available', name: target.name };
    }
  }

  const byId = new Map(flat.map((s) => [s.spanId, s] as const));
  if (byId.size !== flat.length) {
    throw new TraceParseError('Duplicate span IDs within a trace. Export each span once.');
  }
  const roots: ParsedSpan[] = [];
  for (const span of flat) {
    const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
    if (parent) {
      parent.children.push(span);
    } else {
      if (span.parentSpanId) {
        chosenWarnings.push(fromFile({
          comparisonIssue: 'span-ancestry',
          message: `Span "${span.name}" references a parent (${span.parentSpanId}) not present in ${scope} — shown as a root.`,
          spanId: span.spanId,
          traceId,
        }, span.sourceFile));
      }
      roots.push(span);
    }
  }

  // Iterative traversal handles deeply nested exports without exhausting
  // the JS call stack. With unique IDs and one parent, unvisited nodes
  // necessarily belong to a parent cycle (possibly a disconnected one).
  let visited = 0;
  const pending = roots.map((span) => ({ span, depth: 0 }));
  while (pending.length) {
    const { span, depth } = pending.pop()!;
    visited++;
    span.depth = depth;
    span.children.sort((a, b) => a.startTimeUnixNano < b.startTimeUnixNano ? -1 : a.startTimeUnixNano > b.startTimeUnixNano ? 1 : 0);
    for (const child of span.children) pending.push({ span: child, depth: depth + 1 });
  }
  if (visited !== flat.length) throw new TraceParseError('Cyclic span parents: every span must lead to a root.');
  roots.sort((a, b) => (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : a.startTimeUnixNano > b.startTimeUnixNano ? 1 : 0));

  let minStart = flat[0]!.startTimeUnixNano;
  let maxEnd = flat[0]!.endTimeUnixNano;
  for (const s of flat) {
    if (s.startTimeUnixNano < minStart) minStart = s.startTimeUnixNano;
    if (s.endTimeUnixNano > maxEnd) maxEnd = s.endTimeUnixNano;
  }

  return {
    traceId,
    spans: flat,
    roots,
    minStartNs: minStart,
    maxEndNs: maxEnd,
    warnings: chosenWarnings,
    sourceFormat,
    traces,
  };
}

/** What a line of a collector's file can hold besides traces. */
const OTHER_SIGNALS = ['resourceMetrics', 'resource_metrics', 'resourceProfiles', 'resource_profiles'];

function parseJsonLines(text: string, whole: SyntaxError): { json: unknown; warnings: ParseWarning[]; logBatches: LogBatch[] } {
  const lines = text.split(/\r\n|\n|\r/).map((text, index) => ({ text, number: index + 1 })).filter((line) => line.text.trim().length > 0);
  if (lines.length < 2) throw new TraceParseError(`Not valid JSON: ${whole.message}`);

  const resourceSpans: unknown[] = [];
  const warnings: ParseWarning[] = [];
  const logBatches: LogBatch[] = [];
  let otherSignals = 0;
  for (let i = 0; i < lines.length; i++) {
    let value: unknown;
    try {
      value = JSON.parse(lines[i]!.text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (i === 0) throw new TraceParseError(`Not valid JSON: ${whole.message}`);
      // A file the collector is still writing, or a copy cut short, ends mid-line.
      if (i === lines.length - 1) {
        warnings.push({ comparisonIssue: 'span-inventory', message: `The last line (${lines[i]!.number}) is not complete JSON and was skipped: the export may still have been in progress.` });
        break;
      }
      throw new TraceParseError(`Not valid JSON, and not JSON Lines either: line ${lines[i]!.number}: ${reason}`);
    }
    const batch = isRecord(value) ? traceField(value, 'resourceSpans', 'resource_spans', `Line ${lines[i]!.number}`) : value;
    if (hasLogSignal(value)) logBatches.push({ json: value, line: lines[i]!.number });
    if (Array.isArray(batch)) {
      for (const entry of batch) resourceSpans.push(entry);
    } else if (hasLogSignal(value) && batch === undefined) {
      // Standalone logs can precede or follow their trace batch.
    } else if (isRecord(value) && OTHER_SIGNALS.some((key) => key in value)) {
      otherSignals++;
    } else {
      throw new TraceParseError(`Line ${lines[i]!.number} is not an OTLP/JSON trace export: expected an object with a "resourceSpans" array on every line.`);
    }
  }
  if (otherSignals > 0) {
    warnings.push({ message: `Skipped ${otherSignals} ${otherSignals === 1 ? 'line' : 'lines'} of metrics or profiles: only traces and correlated logs are read.` });
  }
  return { json: { resourceSpans }, warnings, logBatches };
}

/**
 * Parses the text of a trace file: one JSON document (OTLP/JSON or Jaeger
 * JSON), or JSON Lines with an OTLP/JSON export on each line, which is what
 * the OpenTelemetry Collector's file exporter writes (a line per batch).
 * The lines are read as one export.
 */
function readTraceText(text: string): { json: unknown; warnings: ParseWarning[]; logBatches: LogBatch[] } {
  let json: unknown;
  let lineWarnings: ParseWarning[] = [];
  let logBatches: LogBatch[] = [];
  try {
    json = JSON.parse(text);
    if (hasLogSignal(json)) logBatches.push({ json });
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    ({ json, warnings: lineWarnings, logBatches } = parseJsonLines(text, err));
  }
  return { json, warnings: lineWarnings, logBatches };
}

export function parseTraceText(text: string, options: ParseOptions = {}): ParsedTrace {
  const { json, warnings: lineWarnings, logBatches } = readTraceText(text);
  const { all, warnings, sourceFormat } = collectSpans(json);
  warnings.unshift(...lineWarnings);
  const unmatchedLogs = correlateLogs(all, collectLogs(logBatches, warnings), warnings);
  return { ...assembleTrace(all, warnings, sourceFormat, options), ...(unmatchedLogs.length ? { unmatchedLogs } : {}) };
}

export const MAX_TRACE_INPUTS = 32;

function fromFile(warning: ParseWarning, sourceFile: ParsedSpan['sourceFile']): ParseWarning {
  return sourceFile ? { ...warning, sourceFile, message: `File ${sourceFile.index} (${sourceFile.name}): ${warning.message}` } : warning;
}

/** Join complete identities before resolving parents, links or selecting a trace.
 * Every file must parse; overlapping identities are rejected without choosing a
 * winner or counting a retransmission as another call. Single-file behavior is
 * unchanged, including diagnostics for malformed individual spans.
 */
export function parseTraceInputs(inputs: readonly TraceInput[], options: ParseOptions = {}): ParsedTrace {
  if (!inputs.length || inputs.length > MAX_TRACE_INPUTS) throw new TraceParseError(`Choose between 1 and ${MAX_TRACE_INPUTS} trace files.`);
  if (inputs.length === 1) return parseTraceText(inputs[0]!.text, options);
  const all: ParsedSpan[] = [];
  const warnings: ParseWarning[] = [];
  const inputFiles: NonNullable<ParsedTrace['inputFiles']> = [];
  const identities = new Map<string, Map<string, ParsedSpan>>();
  const logs: ReturnType<typeof collectLogs> = [];
  for (const [index, input] of inputs.entries()) {
    const sourceFile = { index: index + 1, name: input.name };
    let collected: ReturnType<typeof collectSpans>;
    let logCount = 0;
    try {
      const decoded = readTraceText(input.text);
      collected = collectSpans(decoded.json, decoded.logBatches.length > 0);
      for (const warning of decoded.warnings) warnings.push(fromFile(warning, sourceFile));
      const fileLogs = collectLogs(decoded.logBatches, warnings, sourceFile);
      logCount = fileLogs.length;
      for (const log of fileLogs) logs.push(log);
    } catch (error) {
      throw new TraceParseError(`File ${sourceFile.index} (${input.name}): ${error instanceof Error ? error.message : String(error)}`);
    }
    inputFiles.push({ name: input.name, spanCount: collected.all.length, ...(logCount ? { logCount } : {}), sourceFormat: collected.sourceFormat });
    for (const warning of collected.warnings) warnings.push(fromFile(warning, sourceFile));
    for (const span of collected.all) {
      span.sourceFile = sourceFile;
      let traceIds = identities.get(span.traceId);
      if (!traceIds) { traceIds = new Map(); identities.set(span.traceId, traceIds); }
      const previous = traceIds.get(span.spanId);
      if (previous) {
        throw new TraceParseError(`Duplicate span identity ${span.traceId}/${span.spanId} in file ${previous.sourceFile!.index} (${previous.sourceFile!.name}) and file ${sourceFile.index} (${sourceFile.name}). Choose non-overlapping exports; no files were imported.`);
      }
      traceIds.set(span.spanId, span);
      all.push(span);
    }
  }
  const formats = new Set(inputFiles.map(file => file.sourceFormat));
  const sourceFormat = formats.size === 1 ? inputFiles[0]!.sourceFormat : 'mixed-json';
  if (!all.length) throw new TraceParseError('No valid spans were found. Select the trace export alongside its log files.');
  const unmatchedLogs = correlateLogs(all, logs, warnings);
  return { ...assembleTrace(all, warnings, sourceFormat, options), inputFiles, ...(unmatchedLogs.length ? { unmatchedLogs } : {}) };
}
