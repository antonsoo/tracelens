import { comparisonCases } from '../comparison-coverage/cases.mjs';

// Completeness is specified from the constructed damage, not inferred from product output.
const partial = new Set([
  'missing-startTimeUnixNano', 'missing-endTimeUnixNano', 'missing-spanId', 'missing-traceId',
  'invalid-end-true', 'invalid-end-12.5', 'invalid-end--1', 'missing-parent',
  'nonobject-resource', 'nonobject-scope', 'nonobject-span', 'nonarray-spans', 'nonarray-scopes',
  'truncated-jsonl-tail', 'selected-incomplete-trace', 'jaeger-nonobject-span', 'jaeger-missing-duration',
]);
export const costCases = root => comparisonCases(root).map(item => ({ ...item, incomplete: partial.has(item.id) }));

// Explicitly illustrative user rates, not vendor quotes or invoices. All ordinary
// token components use the same input rate to isolate import coverage from pricing.
export const illustrativePrices = trace => [...new Map(trace.spans.filter(span =>
  ['llm', 'embedding'].includes(span.agentKind) && span.genai).map(span => {
  const model = span.genai.responseModel ?? span.genai.requestModel;
  const provider = span.genai.provider ?? '';
  return [JSON.stringify([model, provider]), { id: `illustrative-${model}-${provider}`, matchModel: model,
    matchMode: 'exact', provider, inputPerMTok: 1, outputPerMTok: span.agentKind === 'embedding' ? 0 : 2,
    cacheReadPerMTok: 1, cacheWritePerMTok: 1, sourceUrl: '', sourceDate: '' }];
})).values()];
