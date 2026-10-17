// Controlled attributes, native SDK spans and native OTLP serialization. No provider is called.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { AlwaysOnSampler, BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';

const output = resolve(process.argv[2] ?? new URL('../fixtures/', import.meta.url).pathname);
mkdirSync(output, { recursive: true });
const cases = [];
const base = {
  'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'example', 'gen_ai.response.model': 'controlled-model',
  'gen_ai.usage.input_tokens': 0, 'gen_ai.usage.output_tokens': 0,
};
function add(name, attributes, expected) {
  cases.push({ name, attributes: { ...base, ...attributes }, expected });
}
add('real-zero', {}, { costUsd: 0, unknownFields: [] });
add('legacy-only', { 'gen_ai.usage.input_tokens': undefined, 'gen_ai.usage.prompt_tokens': 1_000_000 }, { costUsd: 1, unknownFields: [] });
add('input-aliases-agree', { 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.prompt_tokens': 1000 }, { costUsd: 0.001, unknownFields: [] });

// These are spelling groups already supported by TraceLens, not an assertion that
// arbitrary telemetry names have interchangeable meanings. The study README cites
// the conventions; differing numbers are retained without inferring a conversion.
const groups = [
  ['inputTokens', ['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens']],
  ['outputTokens', ['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens']],
  ['cacheReadTokens', ['gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_read_input_tokens']],
  ['cacheWriteTokens', ['gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.cache_creation_input_tokens', 'gen_ai.usage.cache_write_input_tokens']],
  ['reasoningOutputTokens', ['gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.reasoning_tokens', 'gen_ai.usage.details.reasoning_tokens', 'gen_ai.usage.details.thoughts_tokens']],
  ['inputTokens', ['ai.usage.inputTokens', 'ai.usage.promptTokens']],
  ['outputTokens', ['ai.usage.outputTokens', 'ai.usage.completionTokens']],
  ['cacheReadTokens', ['ai.usage.cachedInputTokens', 'ai.usage.inputTokenDetails.cacheReadTokens']],
  ['reasoningOutputTokens', ['ai.usage.reasoningTokens', 'ai.usage.outputTokenDetails.reasoningTokens']],
];
for (const [group, [field, aliases]] of groups.entries()) {
  for (let a = 0; a < aliases.length; a++) for (let b = a + 1; b < aliases.length; b++) {
    const ai = aliases[a].startsWith('ai.');
    const setup = { ...(ai ? { 'ai.operationId': 'ai.generateText.doGenerate' } : {}),
      ...(field.startsWith('cache') ? { 'gen_ai.usage.input_tokens': 1_000_000 } : {}),
      ...(field === 'reasoningOutputTokens' ? { 'gen_ai.usage.output_tokens': 1_000_000 } : {}) };
    const costUsd = field === 'reasoningOutputTokens' ? 1 : null;
    add(`alias-${group}-${a}-${b}-conflict`, { ...setup, [aliases[a]]: 0, [aliases[b]]: 1_000_000 }, { costUsd, unknownFields: [field] });
    add(`alias-${group}-${a}-${b}-equal`, { ...setup, [aliases[a]]: 0, [aliases[b]]: 0 },
      { costUsd: field === 'reasoningOutputTokens' || field.startsWith('cache') ? 1 : 0, unknownFields: [] });
  }
}
const cross = [
  ['inputTokens', 'ai.usage.inputTokens', 'llm.token_count.prompt'],
  ['inputTokens', 'ai.usage.inputTokens', 'gen_ai.usage.input_tokens'],
  ['inputTokens', 'llm.token_count.prompt', 'gen_ai.usage.input_tokens'],
  ['outputTokens', 'llm.token_count.completion', 'gen_ai.usage.output_tokens'],
  ['outputTokens', 'ai.usage.outputTokens', 'gen_ai.usage.output_tokens'],
  ['cacheReadTokens', 'llm.token_count.prompt_details.cache_read', 'gen_ai.usage.cache_read.input_tokens'],
  ['cacheWriteTokens', 'ai.usage.inputTokenDetails.cacheWriteTokens', 'llm.token_count.prompt_details.cache_write'],
  ['reasoningOutputTokens', 'llm.token_count.completion_details.reasoning', 'gen_ai.usage.reasoning.output_tokens'],
];
for (const [index, [field, a, b]] of cross.entries()) {
  const setup = { 'openinference.span.kind': 'LLM', 'ai.operationId': 'ai.generateText.doGenerate',
    ...(field.startsWith('cache') ? { 'gen_ai.usage.input_tokens': 1_000_000 } : {}),
    ...(field === 'reasoningOutputTokens' ? { 'gen_ai.usage.output_tokens': 1_000_000 } : {}) };
  add(`cross-${index}-conflict`, { ...setup, [a]: 0, [b]: 1_000_000 }, { costUsd: field === 'reasoningOutputTokens' ? 1 : null, unknownFields: [field] });
  add(`cross-${index}-equal`, { ...setup, [a]: 0, [b]: 0 }, { costUsd: field.startsWith('cache') || field === 'reasoningOutputTokens' ? 1 : 0, unknownFields: [] });
}
add('three-conventions-conflict', { 'openinference.span.kind': 'LLM', 'ai.operationId': 'ai.generateText.doGenerate', 'ai.usage.inputTokens': 0, 'llm.token_count.prompt': 1_000_000 }, { costUsd: null, unknownFields: ['inputTokens'] });
add('bad-fallback-must-not-disappear', { 'gen_ai.usage.prompt_tokens': 'not-a-count' }, { costUsd: null, unknownFields: ['inputTokens'], invalid: true });
add('bad-primary-remains-unknown', { 'gen_ai.usage.input_tokens': 'not-a-count', 'gen_ai.usage.prompt_tokens': 0 }, { costUsd: null, unknownFields: ['inputTokens'], invalid: true });
add('bad-earlier-convention-must-not-disappear', { 'openinference.span.kind': 'LLM', 'llm.token_count.prompt': -1 }, { costUsd: null, unknownFields: ['inputTokens'], invalid: true });
add('reasoning-breakdown-invalid-charge-still-supported', { 'gen_ai.usage.output_tokens': 1_000_000, 'gen_ai.usage.reasoning.output_tokens': -1 }, { costUsd: 1, unknownFields: ['reasoningOutputTokens'], invalid: true });

let spanId = 0;
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ sampler: new AlwaysOnSampler(),
  idGenerator: { generateTraceId: () => '11'.repeat(16), generateSpanId: () => (++spanId).toString(16).padStart(16, '0') },
  spanLimits: { attributeCountLimit: 128, attributeValueLengthLimit: 4096 },
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer('controlled-usage-evidence', '1.0.0');
const epoch = Date.parse('2026-10-17T00:00:00Z') / 1000;
const root = tracer.startSpan('Controlled telemetry cases; no model called', { startTime: [epoch, 0] });
const parent = trace.setSpan(ROOT_CONTEXT, root);
for (const [index, item] of cases.entries()) {
  const attrs = Object.fromEntries(Object.entries(item.attributes).filter(([, value]) => value !== undefined));
  const span = tracer.startSpan(item.name, { attributes: attrs, startTime: [epoch, (index + 1) * 1_000_000] }, parent);
  span.end([epoch, (index + 1) * 1_000_000 + 500_000]);
}
root.end([epoch + 1, 0]);
await provider.forceFlush();
const spans = exporter.getFinishedSpans();
assert.equal(spans.length, cases.length + 1);
assert.ok(spans.every(span => span.droppedAttributesCount === 0 && span.droppedEventsCount === 0 && span.droppedLinksCount === 0));
const bytes = Buffer.from(JsonTraceSerializer.serializeRequest(spans));
const doc = JSON.parse(bytes.toString('utf8'));
const formatted = JSON.stringify(doc, null, 2) + '\n';
writeFileSync(resolve(output, 'native.json'), formatted);
for (const [file, name] of [['focused.json', 'alias-0-0-1-conflict'], ['equal-zero.json', 'real-zero'],
  ['reasoning.json', 'alias-4-0-1-conflict'], ['invalid.json', 'bad-fallback-must-not-disappear']]) {
  const selected = spans.filter(span => span.name === name || span.name === root.name);
  assert.equal(selected.length, 2);
  writeFileSync(resolve(output, file), JSON.stringify(JSON.parse(Buffer.from(JsonTraceSerializer.serializeRequest(selected)).toString('utf8')), null, 2) + '\n');
}
const prices = [{ id: 'Controlled user-supplied rates', matchModel: 'controlled-model', provider: 'example', inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 2, sourceUrl: '', sourceDate: '' }];
writeFileSync(resolve(output, 'prices.json'), JSON.stringify(prices, null, 2) + '\n');
const dependencies = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).dependencies;
const versions = Object.fromEntries(Object.keys(dependencies).map(name => [name, JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version]));
const ledger = { scope: 'Controlled valid and contradictory attributes serialized by the native SDK. Counts, model/provider names, prices and timestamps are constructed; no provider response, production frequency, invoice or latency is claimed.',
  node: process.version, versions, spans: spans.length, cases: cases.map(({ name, expected }) => ({ name, expected })),
  nativeSha256: createHash('sha256').update(formatted).digest('hex'),
  attributesPerCase: cases.map(item => ({ name: item.name, attributes: Object.fromEntries(Object.entries(item.attributes).filter(([, value]) => value !== undefined)) })),
};
writeFileSync(resolve(output, 'capture.json'), JSON.stringify(ledger, null, 2) + '\n');
await provider.shutdown();
console.log(JSON.stringify({ cases: cases.length, spans: spans.length, versions, output }));
