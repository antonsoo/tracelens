import { TraceParseError } from './payload-depth.js';

/** Read the original document without silently selecting a repeated member.
 * This is an inspection policy, not a replacement for the ProtoJSON decoder.
 * Already-decoded object inputs cannot reveal fields their caller overwrote.
 */
export function readTraceJson(text: string): unknown {
  // Syntax must be complete before checking member identity. An unfinished
  // collector tail still follows the existing partial-JSONL import policy.
  const value: unknown = JSON.parse(text);
  const containers: (Set<string> | undefined)[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      // Jump over long prompts with the native string search. Only backslashes
      // immediately before a quote determine whether that quote ends a string.
      let end = text.indexOf('"', index + 1);
      while (end >= 0) {
        let back = end - 1;
        while (text[back] === '\\') back--;
        if ((end - 1 - back) % 2 === 0) break;
        end = text.indexOf('"', end + 1);
      }
      index = end;
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      const keys = containers[containers.length - 1];
      if (keys && text[next] === ':') {
        const spelling = text.slice(start + 1, index);
        const key = spelling.includes('\\') ? JSON.parse(text.slice(start, index + 1)) as string : spelling;
        if (keys.has(key)) {
          throw new TraceParseError(`Duplicate JSON object field at character ${start + 1}. Re-export with one explicit value per field; no trace measurements were selected from this file.`);
        }
        keys.add(key);
      }
    } else if (character === '{' || character === '[') {
      containers.push(character === '{' ? new Set() : undefined);
    } else if (character === '}' || character === ']') {
      containers.pop();
    }
  }
  return value;
}
