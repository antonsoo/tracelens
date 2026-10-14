import { TraceParseError } from './payload-depth.js';

/** Do not silently choose one spelling and erase the other field's evidence.
 * A null field is unset; a single camelCase or snake_case declaration is usable.
 * This viewer refuses two declarations even when their decoded values agree.
 */
export function traceField(record: Record<string, unknown>, camel: string, snake: string, path: string): unknown {
  if (record[camel] != null && record[snake] != null) {
    throw new TraceParseError(`${path} contains both ${camel} and ${snake}. Keep one field spelling so no trace evidence is hidden.`);
  }
  return record[camel] ?? record[snake];
}
