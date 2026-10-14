import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCostReport, buildSummary, parseTraceInputs, parseTraceText } from '../src/core/index.js';
import type { PriceEntry } from '../src/core/index.js';

const native = readFileSync(new URL('./fixtures/census/strands-operation-details-events-tool-call.json', import.meta.url), 'utf8');
const prices: PriceEntry[] = [{ id: 'illustrative', matchModel: 'gpt-4o-mini', provider: 'strands-agents',
  inputPerMTok: 1, outputPerMTok: 2, sourceDate: '', sourceUrl: '' }];
interface NativeDoc {
  resourceSpans: { scopeSpans: { spans: (Record<string, unknown> & { traceId: string; attributes: { key: string; value: { intValue?: string } }[] })[] }[] }[];
}
const doc = () => JSON.parse(native) as NativeDoc;
const spans = (value: NativeDoc) => value.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans));
const report = (value: ReturnType<typeof doc>) => buildCostReport(parseTraceText(JSON.stringify(value)), prices);

describe('cost availability after partial imports', () => {
  it('preserves the captured remaining charge without inventing missing calls', () => {
    const damaged = doc(); delete spans(damaged)[0]!.endTimeUnixNano;
    const trace = parseTraceText(JSON.stringify(damaged));
    const result = buildCostReport(trace, prices);
    expect(result).toMatchObject({ pricedCalls: 1, unpricedCalls: 0, incompleteInput: true, estimatedCostUsd: null });
    expect(result.knownCostUsd).toBeCloseTo((104 + 12 * 2) / 1e6, 12);
    expect(buildSummary(trace, prices).totalCostUsd).toBe(result.knownCostUsd);
    expect(result.notes.join(' ')).toContain('missing call count are unknown');
  });
  it('does not call a missing parent complete, including direct core API inputs', () => {
    const trace = parseTraceText(native);
    trace.spans[0]!.parentSpanId = 'not-imported';
    expect(buildCostReport(trace, prices)).toMatchObject({ incompleteInput: true, estimatedCostUsd: null });
  });
  it('keeps inventory omissions with unknown trace identity conservative', () => {
    const damaged = { resourceSpans: [...doc().resourceSpans, false] };
    const result = buildCostReport(parseTraceText(JSON.stringify(damaged)), prices);
    expect(result).toMatchObject({ incompleteInput: true, pricedCalls: 2, estimatedCostUsd: null });
    expect(result.knownCostUsd).toBeCloseTo((175 + 26 * 2) / 1e6, 12);
  });
  it('scopes omissions to the selected trace and resolves parents across files', () => {
    const full = doc(), other = doc();
    for (const span of spans(other)) span.traceId = 'bb'.repeat(16);
    delete spans(other)[0]!.endTimeUnixNano;
    const joined = { resourceSpans: [...full.resourceSpans, ...other.resourceSpans] };
    const trace = parseTraceText(JSON.stringify(joined), { traceId: spans(full)[0]!.traceId });
    expect(buildCostReport(trace, prices)).toEqual(buildCostReport(parseTraceText(native), prices));
    const parts = full.resourceSpans.map((resource: unknown, i: number) => ({ name: `part-${i}.json`, text: JSON.stringify({ resourceSpans: [resource] }) }));
    expect(buildCostReport(parseTraceInputs(parts), prices)).toEqual(buildCostReport(parseTraceText(native), prices));
  });
  it('does not withhold charges for timing, invalid ancestry or optional event warnings alone', () => {
    for (const mutate of [
      (span: Record<string, unknown>) => { span.endTimeUnixNano = String(BigInt(String(span.startTimeUnixNano)) - 1n); },
      (span: Record<string, unknown>) => { span.parentSpanId = false; },
      (span: Record<string, unknown>) => { span.events = [null]; },
      (span: Record<string, unknown>) => { span.droppedEventsCount = 5; },
    ]) {
      const changed = doc(); mutate(spans(changed)[0]!);
      expect(report(changed).incompleteInput).toBeUndefined();
      expect(report(changed).estimatedCostUsd).toBeCloseTo(0.000227, 12);
    }
  });
  it('preserves a fully known zero charge, while an incomplete zero stays a subtotal', () => {
    const zero = doc();
    for (const span of spans(zero)) for (const attribute of span.attributes) {
      if (attribute.key.startsWith('gen_ai.usage.')) attribute.value = { intValue: '0' };
    }
    expect(report(zero).estimatedCostUsd).toBe(0);
    const damaged = { resourceSpans: [...zero.resourceSpans, false] };
    expect(buildCostReport(parseTraceText(JSON.stringify(damaged)), prices)).toMatchObject({ incompleteInput: true, knownCostUsd: 0, estimatedCostUsd: null });
  });
});
