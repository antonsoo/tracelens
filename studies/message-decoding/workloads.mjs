// Valid synthetic OTLP documents for import measurements, not model executions.
export function messageWorkload(kind) {
  const traceId = 'ac'.repeat(16), rootId = 'ff'.repeat(8);
  const spans = [{ traceId, spanId: rootId, name: 'Controlled message-decoding workload',
    startTimeUnixNano: '0', endTimeUnixNano: '1000000' }];
  const count = kind === 'history' ? 160 : 50;
  for (let k = 0; k < count; k++) {
    const input = Array.from({ length: kind === 'history' ? 800 : 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', parts: [{ type: 'text', content:
        `Local observation ${i} for controlled step ${k}: lookup returned known value.` }],
    }));
    const values = { 'gen_ai.operation.name': 'chat', 'gen_ai.input.messages': JSON.stringify(input),
      'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', finish_reason: 'stop',
        parts: [{ type: 'text', content: 'A controlled local answer.' }] }]),
      ...(kind === 'system' ? { 'gen_ai.system_instructions': JSON.stringify(Array.from({ length: 500 }, (_, i) => ({
        type: 'text', content: `Controlled instruction ${k}/${i}. ` + 'Read the local observations before answering. '.repeat(3),
      }))) } : {}),
    };
    spans.push({ traceId, spanId: (k + 1).toString(16).padStart(16, '0'), parentSpanId: rootId,
      name: 'chat', startTimeUnixNano: String(k * 2000 + 1), endTimeUnixNano: String(k * 2000 + 1000),
      attributes: Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: value } })) });
  }
  return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
}
