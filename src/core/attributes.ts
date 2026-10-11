import type { AttrMap } from './types.js';
import { MAX_PAYLOAD_DEPTH, TraceParseError } from './payload-depth.js';

type Warn = (message: string) => void;
const ignore: Warn = () => {};
const fields = ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'bytesValue', 'arrayValue', 'kvlistValue'] as const;
const fieldNames = new Map(fields.flatMap(field => [[field, field], [field.replace('Value', '_value'), field]] as const));
const decimal = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the decimal exactly before converting it to a JS measurement.
 * Number("1.00000000000000001") rounds to 1; Number("") invents zero.
 * Removing decimal zeroes first also bounds exponent work to at most 19 digits.
 */
function integer(value: unknown): number | string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = decimal.exec(value);
  if (!match) return undefined;
  const fraction = match[3] ?? '';
  const digits = (match[2]! + fraction).replace(/^0+/, '');
  if (!digits) return 0;
  const significant = digits.replace(/0+$/, '');
  const shift = Number(match[4] ?? 0) - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(shift) || shift < 0 || significant.length + shift > 19) return undefined;
  const exact = BigInt((match[1] === '-' ? '-' : '') + significant) * 10n ** BigInt(shift);
  if (exact < -9223372036854775808n || exact > 9223372036854775807n) return undefined;
  const number = Number(exact);
  // Large, valid int64 strings remain inspectable but cannot become token counts.
  return Number.isSafeInteger(number) ? number : value;
}

function double(value: unknown): number | string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  // Keep Protobuf's special spellings as strings so JSON exports do not turn
  // them into null. They are evidence, never finite numeric measurements.
  if (['NaN', 'Infinity', '-Infinity'].includes(value)) return value;
  if (!decimal.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** A rejected value remains an opaque object in evidence, never a usable scalar. */
function invalid(raw: unknown, path: string, reason: string, warn: Warn): unknown {
  warn(`${path}: ${reason}; retained as invalidAnyValue, not a measurement.`);
  return { invalidAnyValue: raw };
}

/** Decode OTLP/ProtoJSON values without coercing malformed fields into observations. */
export function decodeAnyValue(raw: unknown, warn: Warn = ignore, path = 'AnyValue'): unknown {
  return decodeValue(raw, warn, path, 0);
}

function decodeValue(raw: unknown, warn: Warn, path: string, depth: number): unknown {
  if (depth >= MAX_PAYLOAD_DEPTH) throw new TraceParseError(`Attribute exceeds ${MAX_PAYLOAD_DEPTH} nested values. Export a shallower payload and try again.`);
  if (raw === undefined || raw === null) return null; // Unset message field.
  if (!record(raw)) return invalid(raw, path, 'expected a typed AnyValue object', warn);
  let field: typeof fields[number] | undefined;
  let key = '';
  for (const candidate of Object.keys(raw)) {
    const known = fieldNames.get(candidate);
    if (!known || raw[candidate] === undefined || raw[candidate] === null) continue;
    if (field) return invalid(raw, path, 'multiple AnyValue fields or alternate spellings', warn);
    field = known;
    key = candidate;
  }
  if (!field) return null; // Empty AnyValue (or an unknown future field).
  const value = raw[key];
  switch (field) {
    case 'stringValue':
    case 'bytesValue':
      if (typeof value === 'string') return value; // Bytes stay encoded; no binary interpretation.
      return invalid(raw, path, `${key} must be a string`, warn);
    case 'boolValue':
      if (typeof value === 'boolean') return value;
      return invalid(raw, path, `${key} must be a boolean`, warn);
    case 'intValue': {
      const parsed = integer(value);
      return parsed === undefined ? invalid(raw, path, `${key} must be an exact int64 decimal (quote integers beyond JS safe precision)`, warn) : parsed;
    }
    case 'doubleValue': {
      const parsed = double(value);
      return parsed === undefined ? invalid(raw, path, `${key} must be a decimal number or Protobuf nonfinite spelling`, warn) : parsed;
    }
    case 'arrayValue':
    case 'kvlistValue': {
      if (!record(value) || (value.values != null && !Array.isArray(value.values))) {
        return invalid(raw, path, `${key}.values must be an array when supplied`, warn);
      }
      const values = (value.values ?? []) as unknown[];
      if (field === 'kvlistValue') return decodeAttributes(values, warn, `${path}.${key}.values`, depth + 1);
      return values.map((item, index) => item === null || item === undefined
        ? invalid(item, `${path}.${key}.values[${index}]`, 'null is not an element of a repeated field', warn)
        : decodeValue(item, warn, `${path}.${key}.values[${index}]`, depth + 1));
    }
  }
}

export function decodeAttributes(list: unknown, warn: Warn = ignore, path = 'attributes', depth = 0): AttrMap {
  const out: AttrMap = Object.create(null) as AttrMap;
  if (list === undefined || list === null) return out;
  if (!Array.isArray(list)) {
    warn(`${path}: invalid attribute collection; attributes could not be imported.`);
    return out;
  }
  const sources = new Map<string, unknown[]>();
  list.forEach((entry, index) => {
    if (!record(entry) || typeof entry.key !== 'string') {
      warn(`${path}[${index}]: skipped an attribute without a string key.`);
      return;
    }
    const location = `${path}[${index}] (${JSON.stringify(entry.key)})`;
    const value = decodeValue(entry.value, warn, location, depth);
    const prior = sources.get(entry.key);
    if (prior) {
      prior.push(entry.value ?? null);
      out[entry.key] = { duplicateAttributeValues: prior };
      if (prior.length === 2) warn(`${location}: duplicate attribute key; retained all values without selecting a measurement.`);
    } else {
      sources.set(entry.key, [entry.value ?? null]);
      out[entry.key] = value;
    }
  });
  return out;
}
