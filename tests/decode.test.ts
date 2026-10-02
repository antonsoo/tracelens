import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeText } from '../src/core/decode.js';
import { parseTraceText } from '../src/core/index.js';

const example = readFileSync(new URL('../examples/genai-semconv-trace.json', import.meta.url));
const text = example.toString('utf8');

function utf16(source: string, bigEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(2 + source.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, !bigEndian);
  for (let i = 0; i < source.length; i++) view.setUint16(2 + i * 2, source.charCodeAt(i), !bigEndian);
  return bytes;
}

describe('decodeText', () => {
  const expected = parseTraceText(text);

  it('reads plain UTF-8', () => {
    expect(decodeText(example)).toBe(text);
  });

  it.each([
    ['UTF-8 with a byte-order mark', new Uint8Array([0xef, 0xbb, 0xbf, ...example])],
    ['UTF-16 little-endian (a PowerShell redirect)', utf16(text.replace(/\n/g, '\r\n'), false)],
    ['UTF-16 big-endian', utf16(text, true)],
  ])('a trace saved as %s parses to the same trace', (_label, bytes) => {
    const decoded = decodeText(bytes);
    expect(decoded.charCodeAt(0)).not.toBe(0xfeff);
    expect(parseTraceText(decoded)).toEqual(expected);
  });

  it('keeps characters outside ASCII', () => {
    const sample = '{"name":"café → \u{1F525}"}';
    expect(decodeText(utf16(sample, false))).toBe(sample);
    expect(decodeText(new TextEncoder().encode(sample))).toBe(sample);
  });
});
