import { estimateSpanCost, isTokenCount } from './cost.js';
import type { PriceEntry } from './pricing.js';
import { selfTimeNs } from './summary.js';
import type { AgentSpanKind, ParsedSpan, ParsedTrace } from './types.js';

/** A subtotal plus the number of calls that did not report this measurement. */
export interface Measurement {
  value: number;
  missing: number;
}

export interface Change {
  baseline: Measurement;
  candidate: Measurement;
  delta: number | null;
  /** null for an unknown measurement or a zero baseline. */
  percent: number | null;
}

export interface CallEvidence {
  spanId: string;
  name: string;
  model: string | null;
  durationMs: number;
  selfTimeMs: number;
  error: boolean;
}

export interface RunMetrics {
  calls: Measurement;
  selfTimeMs: Measurement;
  inputTokens: Measurement;
  outputTokens: Measurement;
  costUsd: Measurement;
  errors: Measurement;
}

export type MetricChanges = { [K in keyof RunMetrics]: Change };

export interface OperationComparison {
  key: string;
  path: string[];
  kind: AgentSpanKind;
  status: 'matched' | 'added' | 'removed';
  metrics: MetricChanges;
  baselineCalls: CallEvidence[];
  candidateCalls: CallEvidence[];
}

export interface TraceComparison {
  schemaVersion: 1;
  baselineTraceId: string;
  candidateTraceId: string;
  priceTable: PriceEntry[];
  wallTimeMs: Change;
  metrics: MetricChanges;
  operations: OperationComparison[];
  warnings: string[];
}

const known = (value = 0): Measurement => ({ value, missing: 0 });
const emptyMetrics = (): RunMetrics => ({
  calls: known(),
  selfTimeMs: known(),
  inputTokens: known(),
  outputTokens: known(),
  costUsd: known(),
  errors: known(),
});

export function measurementChange(baseline: Measurement, candidate: Measurement): Change {
  const delta = baseline.missing || candidate.missing ? null : candidate.value - baseline.value;
  return {
    baseline,
    candidate,
    delta,
    percent: delta === null || baseline.value === 0 ? null : (delta / baseline.value) * 100,
  };
}

function changes(baseline: RunMetrics, candidate: RunMetrics): MetricChanges {
  return {
    calls: measurementChange(baseline.calls, candidate.calls),
    selfTimeMs: measurementChange(baseline.selfTimeMs, candidate.selfTimeMs),
    inputTokens: measurementChange(baseline.inputTokens, candidate.inputTokens),
    outputTokens: measurementChange(baseline.outputTokens, candidate.outputTokens),
    costUsd: measurementChange(baseline.costUsd, candidate.costUsd),
    errors: measurementChange(baseline.errors, candidate.errors),
  };
}

function addMeasurement(target: Measurement, value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value) || value < 0) target.missing++;
  else target.value += value;
}

type Segment = [namespace: string, service: string, kind: AgentSpanKind, operation: string];
function segment(span: ParsedSpan): Segment {
  const namespace = span.resourceAttributes['service.namespace'];
  const service = span.resourceAttributes['service.name'];
  // Model names often live in the span name (e.g. "chat model-v2"). Keep
  // models out of identity so a model replacement remains comparable.
  const operation =
    span.agentKind === 'llm'
      ? (span.genai?.operationName ?? span.name)
      : (span.genai?.toolName ?? span.genai?.agentName ?? span.name);
  return [
    typeof namespace === 'string' ? namespace : '',
    typeof service === 'string' ? service : '',
    span.agentKind,
    operation,
  ];
}

interface Group {
  path: string[];
  kind: AgentSpanKind;
  metrics: RunMetrics;
  calls: CallEvidence[];
}

function collect(trace: ParsedTrace, prices: PriceEntry[]): { groups: Map<string, Group>; metrics: RunMetrics } {
  if (new Set(trace.spans.map((span) => span.traceId)).size !== 1) {
    throw new Error('Cannot compare spans from more than one trace as a single run.');
  }
  if (new Set(trace.spans.map((span) => span.spanId)).size !== trace.spans.length) {
    throw new Error('Cannot compare duplicate span IDs. Export each span once.');
  }
  const groups = new Map<string, Group>();
  const metrics = emptyMetrics();
  const visited = new Set<ParsedSpan>();
  const stack = [...trace.roots].reverse().map((span) => ({ span, ancestry: [] as Segment[] }));
  while (stack.length) {
    const { span, ancestry } = stack.pop()!;
    if (ancestry.length >= 256)
      throw new Error('Comparison supports up to 256 nesting levels. Export a shallower trace.');
    if (visited.has(span)) throw new Error('Cannot compare a trace with a cyclic or repeated span tree.');
    visited.add(span);
    const path = [...ancestry, segment(span)];
    // Structured keys avoid collisions when names themselves contain / or >.
    const key = JSON.stringify(path);
    let group = groups.get(key);
    if (!group) {
      group = {
        path: path.map(
          ([namespace, service, kind, operation]) =>
            `${namespace ? `${namespace}/` : ''}${service ? `${service}: ` : ''}${kind} ${operation}`,
        ),
        kind: span.agentKind,
        metrics: emptyMetrics(),
        calls: [],
      };
      groups.set(key, group);
    }
    const self = Number(selfTimeNs(span)) / 1_000_000;
    group.calls.push({
      spanId: span.spanId,
      name: span.name,
      model: span.genai?.responseModel ?? span.genai?.requestModel ?? null,
      durationMs: Number(span.durationNs) / 1_000_000,
      selfTimeMs: self,
      error: span.status.code === 'ERROR',
    });
    for (const target of [group.metrics, metrics]) {
      target.calls.value++;
      target.selfTimeMs.value += self;
      target.errors.value += span.status.code === 'ERROR' ? 1 : 0;
      if (span.agentKind !== 'llm') continue;
      const usage = span.genai?.usage;
      addMeasurement(target.inputTokens, isTokenCount(usage?.inputTokens) ? usage.inputTokens : undefined);
      addMeasurement(target.outputTokens, isTokenCount(usage?.outputTokens) ? usage.outputTokens : undefined);
      const cost = span.genai ? estimateSpanCost(span.genai, prices)?.costUsd : undefined;
      addMeasurement(target.costUsd, cost);
    }
    for (const child of [...span.children].reverse()) stack.push({ span: child, ancestry: path });
  }
  if (visited.size !== trace.spans.length) {
    throw new Error('Cannot compare an incomplete span tree (possibly cyclic parents). Fix the export first.');
  }
  return { groups, metrics };
}

/** Compare observations, not statistical significance or causal latency.
 * Repeated paths are aggregated: there is no reliable cross-run call ID. */
export function compareTraces(baseline: ParsedTrace, candidate: ParsedTrace, prices: PriceEntry[]): TraceComparison {
  const before = collect(baseline, prices);
  const after = collect(candidate, prices);
  const operations = [...new Set([...before.groups.keys(), ...after.groups.keys()])]
    .map((key): OperationComparison => {
      const a = before.groups.get(key);
      const b = after.groups.get(key);
      const group = a ?? b!;
      return {
        key,
        path: group.path,
        kind: group.kind,
        status: a && b ? 'matched' : a ? 'removed' : 'added',
        metrics: changes(a?.metrics ?? emptyMetrics(), b?.metrics ?? emptyMetrics()),
        baselineCalls: a?.calls ?? [],
        candidateCalls: b?.calls ?? [],
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.metrics.selfTimeMs.delta!) - Math.abs(a.metrics.selfTimeMs.delta!) || a.key.localeCompare(b.key),
    );
  return {
    schemaVersion: 1,
    baselineTraceId: baseline.traceId,
    candidateTraceId: candidate.traceId,
    priceTable: prices.map((price) => ({ ...price })),
    wallTimeMs: measurementChange(
      known(Number(baseline.maxEndNs - baseline.minStartNs) / 1_000_000),
      known(Number(candidate.maxEndNs - candidate.minStartNs) / 1_000_000),
    ),
    metrics: changes(before.metrics, after.metrics),
    operations,
    warnings: [
      ...baseline.warnings.map((w) => `Baseline: ${w.message}`),
      ...candidate.warnings.map((w) => `Candidate: ${w.message}`),
    ],
  };
}
