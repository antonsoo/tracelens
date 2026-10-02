/**
 * A trace file's text, as Windows tools save it too. An exporter writes UTF-8, but
 * `... > trace.json` in Windows PowerShell saves UTF-16 with a byte-order mark, and its
 * `-Encoding utf8` (like Notepad's "UTF-8 with BOM") puts a mark in front of UTF-8. Read
 * as plain UTF-8, either stopped at the first character: "Not valid JSON: Unexpected token".
 * The mark decides the encoding and is dropped.
 */
export function decodeText(bytes: Uint8Array): string {
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  return new TextDecoder(utf16 ?? 'utf-8').decode(bytes);
}
