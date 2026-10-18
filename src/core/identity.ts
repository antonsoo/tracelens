// OTLP JSON encodes IDs as case-insensitive hex. Protobuf's ordinary JSON
// serializer encodes these bytes as case-sensitive base64. Normalize the bytes
// before grouping traces, joining parents or resolving links; lowercasing base64
// can turn different IDs into the same one.
const HEX = /^[\da-f]+$/i;
const BASE64_SPAN = /^[A-Za-z\d+/_-]{11}=?$/;
const BASE64_TRACE = /^[A-Za-z\d+/_-]{22}(?:==)?$/;

export function normalizeId(raw: unknown, bytes: 8 | 16): string {
  if (typeof raw !== 'string') return '';
  // A complete OTLP identity must contain a nonzero byte. Jaeger's full
  // 64-bit trace form has the same requirement before zero-extension.
  // Short opaque legacy labels keep their existing compatibility policy.
  if ((raw.length === bytes * 2 || (bytes === 16 && raw.length === 16)) && /^0+$/.test(raw)) return '';
  // Jaeger's UI/query JSON omits the zero high word of a 128-bit trace ID.
  // Its complete 16-digit form and OTLP's zero-padded 32-digit form identify
  // the same trace. Normalize before grouping, duplicate checks and links.
  // Span IDs already occupy eight bytes; other short/opaque IDs stay as-is.
  if (bytes === 16 && raw.length === 16 && HEX.test(raw)) return raw.toLowerCase().padStart(32, '0');
  const pattern = bytes === 8 ? BASE64_SPAN : BASE64_TRACE;
  if (pattern.test(raw)) {
    const standard = raw.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const decoded = atob(standard);
    // Require canonical padding bits. Unknown identifier forms stay opaque,
    // rather than silently changing their spelling or picking a decoded value.
    if (decoded.length === bytes && btoa(decoded).replace(/=+$/, '') === standard) {
      if ([...decoded].every(c => c.charCodeAt(0) === 0)) return '';
      return Array.from(decoded, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    }
  }
  return HEX.test(raw) ? raw.toLowerCase() : raw;
}
