// Controlled mutations of retained Strands captures; no new model calls.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export const spanOf = doc => doc.resourceSpans[0].scopeSpans[0].spans[0];
const controls = new Map(['legacy', 'operation-details'].map(mode => {
  const bytes = readFileSync(new URL(`../../tests/fixtures/census/strands-${mode}-events-tool-call.json`, import.meta.url));
  return [mode, { doc: JSON.parse(bytes), sha256: hash(bytes), file: `tests/fixtures/census/strands-${mode}-events-tool-call.json` }];
}));
const input = [{ role: 'user', parts: [{ type: 'text', content: 'What is the weather in Paris?' }] }];
const output = mode => [{ role: 'assistant', parts: [{ type: 'tool_call',
  id: mode === 'legacy' ? 'call_VnxVKBi2f85Mxa9gATPB6myQ' : 'call_3bE3z0GW3LsGNGXmDKqGuhdK',
  name: 'get_weather', arguments: { city: 'Paris' } }] }];
export const cases = [];
function add(id, mode, mutate, expected = {}) {
  const control = controls.get(mode);
  const doc = structuredClone(control.doc);
  mutate?.(spanOf(doc));
  cases.push({ id, mode, doc, source: { file: control.file, sha256: control.sha256 },
    expected: { input, output: output(mode), warnings: 0, ...expected } });
}
export function replaceContent(span, content, eventName = 'gen_ai.choice') {
  span.events.find(e => e.name === eventName).attributes.find(a => a.key === (eventName === 'gen_ai.choice' ? 'message' : 'content')).value.stringValue = content;
}
for (const mode of controls.keys()) {
  add(`${mode}-control`, mode);
  for (const direction of ['input', 'output', 'both']) {
    const expected = {};
    const attrs = [];
    for (const side of direction === 'both' ? ['input', 'output'] : [direction]) {
      const messages = [{ role: side === 'input' ? 'user' : 'assistant', parts: [{ type: 'text', content: `${side} attribute takes precedence` }] }];
      attrs.push({ key: `gen_ai.${side}.messages`, value: { stringValue: json(messages) } });
      expected[side] = messages;
    }
    add(`${mode}-${direction}-attribute`, mode, s => s.attributes.push(...attrs), expected);
  }
}
const badValues = { string: 'broken', number: 1, true: true, false: false, zero: 0, null: null, array: [], empty: {}, partial: { toolUseId: 'id' } };
function rawCase(id, blocks, eventName = 'gen_ai.choice') {
  const content = json(blocks);
  const side = eventName === 'gen_ai.choice' ? 'output' : 'input';
  add(id, 'legacy', s => replaceContent(s, content, eventName), {
    [side]: [{ role: side === 'output' ? 'assistant' : 'user', parts: [{ type: 'text', content }] }], warnings: 1,
  });
}
for (const key of ['toolUse', 'toolResult']) {
  for (const [label, value] of Object.entries(badValues)) rawCase(`${key}-${label}`, [{ [key]: value }]);
}
for (const [label, value] of Object.entries({ null: null, number: 42, object: {}, array: [] })) rawCase(`text-${label}`, [{ text: value }]);
rawCase('ambiguous-members', [{ text: 'keep this text', toolUse: { toolUseId: 'id', name: 'weather', input: {} } }]);
rawCase('mixed-neighbors', [{ text: 'before damaged block' }, { toolUse: 'broken' }, { text: 'after damaged block' }]);
rawCase('input-damage', [{ toolResult: true }], 'gen_ai.user.message');
for (const content of ['ordinary text', '[{"image":{"format":"png"}}]', '[not JSON']) {
  add(`raw-text-${cases.length}`, 'legacy', s => replaceContent(s, content), {
    output: [{ role: 'assistant', parts: [{ type: 'text', content }] }],
  });
}
add('json-whitespace', 'legacy', s => {
  const ev = s.events.find(e => e.name === 'gen_ai.choice');
  const attr = ev.attributes.find(a => a.key === 'message');
  attr.value.stringValue = ` \n${attr.value.stringValue}\t`;
});
add('null-tool-input', 'legacy', s => replaceContent(s, '[{"toolUse":{"toolUseId":"id","name":"weather","input":null}}]'), {
  output: [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'id', name: 'weather', arguments: null }] }],
});
add('valid-tool-result', 'legacy', s => replaceContent(s, '[{"toolResult":{"toolUseId":"id","content":[{"text":"72 F"}]}}]'), {
  output: [{ role: 'assistant', parts: [{ type: 'tool_call_response', id: 'id', response: [{ text: '72 F' }] }] }],
});
