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

  it.each([
    ['isolated continuation', [0x80]],
    ['different isolated continuation', [0x81]],
    ['overlong encoding', [0xc0, 0xaf]],
    ['encoded surrogate', [0xed, 0xa0, 0x80]],
    ['code point beyond Unicode', [0xf4, 0x90, 0x80, 0x80]],
    ['truncated sequence', [0xe2, 0x82]],
  ])('rejects UTF-8 %s instead of changing source evidence', (_label, broken) => {
    const prefix = new TextEncoder().encode('{"name":"operation ');
    const suffix = new TextEncoder().encode('"}');
    expect(() => decodeText(new Uint8Array([...prefix, ...broken, ...suffix])))
      .toThrow(/^Invalid UTF-8 text\. Re-export/);
  });

  it.each([false, true])('rejects unpaired UTF-16 surrogates and odd byte counts (big endian: %s)', (bigEndian) => {
    for (const value of ['\ud800', '\udc00']) {
      expect(() => decodeText(utf16(`{"name":"${value}"}`, bigEndian)))
        .toThrow(/^Invalid UTF-16(?:LE|BE) text\. Re-export/);
    }
    const bytes = utf16('{"name":"valid"}', bigEndian);
    expect(() => decodeText(new Uint8Array([...bytes, 0x20])))
      .toThrow(/^Invalid UTF-16(?:LE|BE) text\. Re-export/);
  });

  it('preserves a literal replacement character, escaped surrogates and Unicode noncharacters', () => {
    const sample = '{"name":"literal \ufffd \ufdd0 \uffff", "escaped":"\\ud800"}';
    for (const bytes of [new TextEncoder().encode(sample), utf16(sample, false), utf16(sample, true)]) {
      expect(decodeText(bytes)).toBe(sample);
    }
  });

  it('refuses a file that is not text instead of quoting its bytes in a JSON error', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    expect(() => decodeText(png)).toThrow(/^not a text file/);
  });
});
