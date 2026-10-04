/** Payload objects are bounded independently of the flat span-parent graph. */
export const MAX_PAYLOAD_DEPTH = 128;

export class TraceParseError extends Error {}

export function assertPayloadDepth(value: unknown, depth = 0): void {
  if (typeof value !== 'object' || value === null) return;
  if (depth >= MAX_PAYLOAD_DEPTH) {
    throw new TraceParseError(`Trace payload exceeds ${MAX_PAYLOAD_DEPTH} nested object/array levels. Export shallower attributes or tool/message payloads and try again. Span ancestry is not subject to this limit.`);
  }
  for (const child of Object.values(value)) assertPayloadDepth(child, depth + 1);
}

/** JSON embedded in attributes needs the same bound as the outer document. */
export function parsePayloadJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  assertPayloadDepth(value);
  return value;
}
