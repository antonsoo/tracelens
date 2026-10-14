import type { ParsedSpan, StatusCode } from './types.js';

type Warn = (message: string) => void;
const codes: Readonly<Record<number, StatusCode>> = { 0: 'UNSET', 1: 'OK', 2: 'ERROR' };
const names = new Map<string, StatusCode>([
  ['STATUS_CODE_UNSET', 'UNSET'], ['STATUS_CODE_OK', 'OK'], ['STATUS_CODE_ERROR', 'ERROR'],
  // Retain the viewer's existing short-name compatibility, without accepting
  // a prefix/suffix embedded elsewhere in an otherwise invalid name.
  ['UNSET', 'UNSET'], ['OK', 'OK'], ['ERROR', 'ERROR'],
]);

export function isKnownStatusCode(code: unknown): boolean {
  return code === 'UNSET' || code === 'OK' || code === 'ERROR';
}

/** Keep omitted/null ProtoJSON fields distinct from unrecognized observations. */
export function decodeStatus(raw: unknown, warn: Warn, sourceRaw?: unknown): ParsedSpan['status'] {
  if (raw === undefined || raw === null) return { code: 'UNSET' };
  const unknown = (): ParsedSpan['status'] => {
    warn('Unrecognized or malformed span status; retained the raw status. Its error outcome is unknown.');
    return { code: 'UNKNOWN', raw: sourceRaw ?? raw };
  };
  if (typeof raw !== 'object' || Array.isArray(raw)) return unknown();
  const status = raw as Record<string, unknown>;
  const value = status.code;
  let code: StatusCode | undefined;
  if (value === undefined || value === null) code = 'UNSET';
  else if (typeof value === 'number' && Number.isInteger(value)) code = codes[value];
  else if (typeof value === 'string') {
    code = names.get(value);
    // Protobuf's reference decoder accepts quoted integer enum values.
    // Fractions and booleans are never coerced to a different observation.
    const decimal = value.trim();
    if (!code && /^[+-]?\d+$/.test(decimal)) code = codes[Number(decimal)];
  }
  if (code === undefined) return unknown();
  if (status.message !== undefined && status.message !== null && typeof status.message !== 'string') {
    warn('Invalid status message; retained the raw status without inventing message text. The status code remains known.');
    return { code, raw: sourceRaw ?? raw };
  }
  return { code, ...(typeof status.message === 'string' ? { message: status.message } : {}),
    ...(sourceRaw !== undefined ? { raw: sourceRaw } : {}) };
}
