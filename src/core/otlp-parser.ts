// Parses OTLP/JSON trace exports — the shape produced by the OpenTelemetry
// Collector's file/JSON exporter, or by protobuf's `MessageToJson` on an
// `ExportTraceServiceRequest`: resourceSpans -> scopeSpans -> spans, with
// every attribute value as a typed `AnyValue` object. Spec:
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/common/v1/common.proto
// (verified against the `main` branch, 2026-09-24).
import type { AttrMap, ParseWarning, ParsedSpan, ParsedTrace, SpanEvent, SpanKind, StatusCode, TraceListing } from './types.js';
import { normalizeSpan } from './normalize.js';
import { isJaegerJson, jaegerToOtlp } from './jaeger.js';

const SPAN_KIND_BY_NUMBER: Record<number, SpanKind> = {
  0: 'UNSPECIFIED',
  1: 'INTERNAL',
  2: 'SERVER',
  3: 'CLIENT',
  4: 'PRODUCER',
  5: 'CONSUMER',
};

const STATUS_CODE_BY_NUMBER: Record<number, StatusCode> = {
  0: 'UNSET',
  1: 'OK',
  2: 'ERROR',
};

export class TraceParseError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Decodes a single OTLP `AnyValue` (typed union) into a plain JS value. */
export function decodeAnyValue(v: unknown): unknown {
  if (!isRecord(v)) return v ?? null;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('intValue' in v) {
    const raw = v.intValue;
    const n = typeof raw === 'string' ? Number(raw) : (raw as number);
    return Number.isSafeInteger(n) ? n : raw; // keep huge ints as their raw string
  }
  if ('doubleValue' in v) return v.doubleValue;
  if ('bytesValue' in v) return v.bytesValue; // base64 string, left as-is
  if ('arrayValue' in v) {
    const arr = v.arrayValue;
    const values = isRecord(arr) && Array.isArray(arr.values) ? arr.values : [];
    return values.map(decodeAnyValue);
  }
  if ('kvlistValue' in v) {
    const kv = v.kvlistValue;
    const values = isRecord(kv) && Array.isArray(kv.values) ? kv.values : [];
    const out: AttrMap = Object.create(null) as AttrMap;
    for (const entry of values) {
      if (isRecord(entry) && typeof entry.key === 'string') {
        out[entry.key] = decodeAnyValue(entry.value);
      }
    }
    return out;
  }
  return null;
}

function decodeAttributes(list: unknown): AttrMap {
  const out: AttrMap = Object.create(null) as AttrMap;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (isRecord(entry) && typeof entry.key === 'string') {
      out[entry.key] = decodeAnyValue(entry.value);
    }
  }
  return out;
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

function decodeStatus(raw: unknown): { code: StatusCode; message?: string } {
  if (!isRecord(raw)) return { code: 'UNSET' };
  const codeRaw = raw.code;
  let code: StatusCode = 'UNSET';
  if (typeof codeRaw === 'number') code = STATUS_CODE_BY_NUMBER[codeRaw] ?? 'UNSET';
  else if (typeof codeRaw === 'string') {
    const cleaned = codeRaw.replace('STATUS_CODE_', '');
    if (cleaned === 'OK' || cleaned === 'ERROR' || cleaned === 'UNSET') code = cleaned;
  }
  const message = typeof raw.message === 'string' ? raw.message : undefined;
  return message !== undefined ? { code, message } : { code };
}

function decodeEvents(raw: unknown, warnings: ParseWarning[], spanId: string, traceId: string): SpanEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    const rec = isRecord(e) ? e : {};
    const time = toBigNanos(rec.timeUnixNano ?? rec.time_unix_nano ?? 0);
    if (time === undefined) {
      warnings.push({ message: 'Skipped an event with an invalid timestamp.', spanId, traceId });
      return [];
    }
    return [{
      name: typeof rec.name === 'string' ? rec.name : '',
      timeUnixNano: time,
      attributes: decodeAttributes(rec.attributes),
    }];
  });
}

function hexId(raw: unknown): string {
  if (typeof raw === 'string') return raw.toLowerCase();
  return '';
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
function chooseTrace(listings: TraceListing[], wanted: string | undefined): TraceListing {
  if (wanted === undefined) {
    return listings.reduce((best, t) => (t.spanCount > best.spanCount ? t : best));
  }
  const prefix = wanted.trim().toLowerCase();
  const exact = listings.find((t) => t.traceId === prefix);
  if (exact) return exact;
  const matches = prefix.length > 0 ? listings.filter((t) => t.traceId.startsWith(prefix)) : [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new TraceParseError(`"${wanted}" is the start of ${matches.length} trace IDs in this file: ${listTraces(matches)}.`);
  }
  throw new TraceParseError(`No trace in this file has the ID "${wanted}". It holds: ${listTraces(listings)}.`);
}

/**
 * Parses a raw OTLP/JSON `ExportTraceServiceRequest` document (or a bare
 * `resourceSpans` array) into a flat span list plus a computed tree. Throws
 * `TraceParseError` on structurally invalid input; individual malformed
 * spans are skipped with a warning rather than aborting the whole parse.
 * A file with several traces yields one of them (see `ParseOptions`) and
 * lists them all in `traces`.
 */
export function parseOtlpJson(json: unknown, options: ParseOptions = {}): ParsedTrace {
  // Jaeger's native JSON is converted up front, so it gets the same validation.
  const sourceFormat = isJaegerJson(json) ? 'jaeger-json' : 'otlp-json';
  if (sourceFormat === 'jaeger-json') json = jaegerToOtlp(json);
  const root = isRecord(json) ? json : { resourceSpans: json };
  const resourceSpans = root.resourceSpans ?? root.resource_spans;
  if (!Array.isArray(resourceSpans)) {
    throw new TraceParseError(
      'Not a recognizable trace export: expected OTLP/JSON (a top-level "resourceSpans" array) or Jaeger JSON (a "data" array of traces with "spans").',
    );
  }
  if (resourceSpans.length === 0) {
    throw new TraceParseError('This trace file has no resourceSpans — nothing to show.');
  }

  const all: ParsedSpan[] = [];
  // Warnings are collected for every trace in the file and narrowed to the chosen one below.
  const warnings: ParseWarning[] = [];

  for (const rs of resourceSpans) {
    if (!isRecord(rs)) continue;
    const resourceAttributes = decodeAttributes(isRecord(rs.resource) ? rs.resource.attributes : undefined);
    const scopeSpans = rs.scopeSpans ?? rs.scope_spans;
    if (!Array.isArray(scopeSpans)) continue;

    for (const ss of scopeSpans) {
      if (!isRecord(ss)) continue;
      const scope = ss.scope;
      const scopeName = isRecord(scope) && typeof scope.name === 'string' ? scope.name : undefined;
      const scopeVersion = isRecord(scope) && typeof scope.version === 'string' ? scope.version : undefined;
      const spans = ss.spans;
      if (!Array.isArray(spans)) continue;

      for (const raw of spans) {
        if (!isRecord(raw)) {
          warnings.push({ message: 'Skipped a non-object entry in "spans".' });
          continue;
        }
        const spanId = hexId(raw.spanId ?? raw.span_id);
        const spanTraceId = hexId(raw.traceId ?? raw.trace_id);
        if (!spanId || !spanTraceId) {
          warnings.push({ message: `Skipped a span with a missing traceId/spanId (name: ${String(raw.name)}).` });
          continue;
        }
        const start = toBigNanos(raw.startTimeUnixNano ?? raw.start_time_unix_nano);
        let end = toBigNanos(raw.endTimeUnixNano ?? raw.end_time_unix_nano);
        if (start === undefined || end === undefined) {
          warnings.push({ message: `Skipped span "${String(raw.name)}" with missing or invalid timestamps. Use unsigned decimal nanosecond strings (or safe integer numbers).`, spanId, traceId: spanTraceId });
          continue;
        }
        if (end < start) {
          warnings.push({
            message: `Span "${String(raw.name)}" has an end time before its start time (clock skew?) — clamped to start.`,
            spanId,
            traceId: spanTraceId,
          });
          end = start;
        }

        const parentRaw = raw.parentSpanId ?? raw.parent_span_id;
        const parentSpanId = typeof parentRaw === 'string' && parentRaw.length > 0 ? hexId(parentRaw) : undefined;

        const attributes = decodeAttributes(raw.attributes);

        const base: ParsedSpan = {
          traceId: spanTraceId,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name: typeof raw.name === 'string' ? raw.name : '(unnamed span)',
          kind: decodeSpanKind(raw.kind),
          startTimeUnixNano: start,
          endTimeUnixNano: end,
          durationNs: end - start,
          status: decodeStatus(raw.status),
          attributes,
          events: decodeEvents(raw.events, warnings, spanId, spanTraceId),
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
  }

  if (all.length === 0) {
    throw new TraceParseError('No valid spans were found in this file.');
  }

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
  traces.sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : a.traceId < b.traceId ? -1 : 1));
  const traceId = chooseTrace(traces, options.traceId).traceId;
  const flat = byTrace.get(traceId)!.map((span) => normalizeSpan(span));
  const chosenWarnings = warnings.filter((w) => w.traceId === undefined || w.traceId === traceId);

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
        chosenWarnings.push({
          message: `Span "${span.name}" references a parent (${span.parentSpanId}) not present in this file — shown as a root.`,
          spanId: span.spanId,
          traceId,
        });
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
  roots.sort((a, b) => (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : 1));

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
const OTHER_SIGNALS = ['resourceMetrics', 'resource_metrics', 'resourceLogs', 'resource_logs', 'resourceProfiles', 'resource_profiles'];

function parseJsonLines(text: string, whole: SyntaxError): { json: unknown; warnings: ParseWarning[] } {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new TraceParseError(`Not valid JSON: ${whole.message}`);

  const resourceSpans: unknown[] = [];
  const warnings: ParseWarning[] = [];
  let otherSignals = 0;
  for (let i = 0; i < lines.length; i++) {
    let value: unknown;
    try {
      value = JSON.parse(lines[i]!);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (i === 0) throw new TraceParseError(`Not valid JSON: ${whole.message}`);
      // A file the collector is still writing, or a copy cut short, ends mid-line.
      if (i === lines.length - 1) {
        warnings.push({ message: `The last line (${i + 1}) is not complete JSON and was skipped: the export may still have been in progress.` });
        break;
      }
      throw new TraceParseError(`Not valid JSON, and not JSON Lines either: line ${i + 1}: ${reason}`);
    }
    const batch = isRecord(value) ? (value.resourceSpans ?? value.resource_spans) : value;
    if (Array.isArray(batch)) {
      for (const entry of batch) resourceSpans.push(entry);
    } else if (isRecord(value) && OTHER_SIGNALS.some((key) => key in value)) {
      otherSignals++;
    } else {
      throw new TraceParseError(`Line ${i + 1} is not an OTLP/JSON trace export: expected an object with a "resourceSpans" array on every line.`);
    }
  }
  if (otherSignals > 0) {
    warnings.push({ message: `Skipped ${otherSignals} ${otherSignals === 1 ? 'line' : 'lines'} of metrics, logs or profiles: only traces are read.` });
  }
  return { json: { resourceSpans }, warnings };
}

/**
 * Parses the text of a trace file: one JSON document (OTLP/JSON or Jaeger
 * JSON), or JSON Lines with an OTLP/JSON export on each line, which is what
 * the OpenTelemetry Collector's file exporter writes (a line per batch).
 * The lines are read as one export.
 */
export function parseTraceText(text: string, options: ParseOptions = {}): ParsedTrace {
  let json: unknown;
  let lineWarnings: ParseWarning[] = [];
  try {
    json = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    ({ json, warnings: lineWarnings } = parseJsonLines(text, err));
  }
  const trace = parseOtlpJson(json, options);
  return lineWarnings.length > 0 ? { ...trace, warnings: [...lineWarnings, ...trace.warnings] } : trace;
}
