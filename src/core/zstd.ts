import { decompressZstdFrame } from './zstd-kernel.js';
import { TraceParseError } from './payload-depth.js';

export const MAX_ZSTD_BYTES = 25 * 1024 * 1024;
const MAX_FRAMES = 100_000;
const MAX_BLOCKS = 1_000_000;
const MAGIC = 0xfd2fb528;
interface Budget { decoded: number; frames: number; blocks: number }

function fail(message: string): never {
  throw new TraceParseError(`Zstandard: ${message}. No compressed batches were imported.`);
}
function addOutput(budget: Budget, bytes: number): void {
  budget.decoded += bytes;
  if (budget.decoded > MAX_ZSTD_BYTES) fail('expanded input exceeds 25 MiB; export a smaller run');
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  return result;
}
function isFrame(magic: number): boolean {
  return magic === MAGIC || (magic & 0xfffffff0) === 0x184d2a50;
}

/** Inspect frame extents and allocation requests before entering the codec.
 * The reference codec also validates bitstreams and optional content checksums.
 * https://github.com/facebook/zstd/blob/v1.5.7/doc/zstd_compression_format.md
 */
function decompressFrames(data: Uint8Array, budget: Budget): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const output: Uint8Array[] = [];
  const need = (at: number, size: number): void => {
    if (size > data.length - at) fail('incomplete frame or block');
  };
  for (let at = 0; at < data.length;) {
    if (++budget.frames > MAX_FRAMES) fail(`more than ${MAX_FRAMES} frames`);
    need(at, 4);
    const magic = view.getUint32(at, true);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      need(at, 8);
      const length = view.getUint32(at + 4, true);
      need(at + 8, length);
      at += 8 + length;
      continue;
    }
    if (magic !== MAGIC) fail('invalid frame magic or trailing bytes');
    const start = at;
    need(at, 5);
    const descriptor = data[at + 4]!;
    if (descriptor & 8) fail('reserved frame-header bit is set');
    const singleSegment = (descriptor & 32) !== 0;
    at += 5;
    let window = 0;
    if (!singleSegment) {
      need(at, 1);
      const descriptor = data[at++]!;
      window = 2 ** (10 + (descriptor >> 3)) * (1 + (descriptor & 7) / 8);
    }
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]!;
    need(at, dictionaryBytes);
    for (let i = 0; i < dictionaryBytes; i++) if (data[at + i]) fail('external dictionaries are not supported');
    at += dictionaryBytes;
    const sizeFlag = descriptor >> 6;
    const sizeBytes = sizeFlag ? 1 << sizeFlag : singleSegment ? 1 : 0;
    need(at, sizeBytes);
    let contentSize: number | undefined;
    if (sizeBytes) {
      let value = 0n;
      for (let i = 0; i < sizeBytes; i++) value |= BigInt(data[at + i]!) << BigInt(8 * i);
      if (sizeBytes === 2) value += 256n;
      if (value > BigInt(MAX_ZSTD_BYTES - budget.decoded)) fail('declared expanded input exceeds 25 MiB; export a smaller run');
      contentSize = Number(value);
      if (singleSegment) window = contentSize;
    }
    at += sizeBytes;
    if (window > MAX_ZSTD_BYTES) fail('requested decoding window exceeds 25 MiB; export with a smaller window');
    const blockMax = Math.min(128 * 1024, window);
    let last = false;
    let outputBound = 0;
    while (!last) {
      if (++budget.blocks > MAX_BLOCKS) fail(`more than ${MAX_BLOCKS} blocks`);
      need(at, 3);
      const header = data[at]! | data[at + 1]! << 8 | data[at + 2]! << 16;
      last = (header & 1) !== 0;
      const kind = (header >> 1) & 3, size = header >>> 3;
      if (kind === 3 || size > blockMax || (kind === 2 && size < 2)) fail('invalid block type or size');
      outputBound = Math.min(MAX_ZSTD_BYTES + 1, outputBound + (kind === 2 ? blockMax : size));
      const encoded = kind === 1 ? 1 : size;
      at += 3;
      need(at, encoded);
      at += encoded;
    }
    const checksumAt = descriptor & 4 ? at : undefined;
    if (checksumAt !== undefined) { need(at, 4); at += 4; }
    let bytes: Uint8Array;
    try {
      const capacity = Math.min(MAX_ZSTD_BYTES - budget.decoded, contentSize ?? outputBound);
      bytes = decompressZstdFrame(data.subarray(start, at), capacity);
    } catch (error) {
      fail(`frame could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (contentSize !== undefined && bytes.length !== contentSize) fail('decoded content length differs from its frame declaration');
    addOutput(budget, bytes.length);
    output.push(bytes);
  }
  return concat(output);
}

/** Collector defaults compress each length-prefixed message. Its native file
 * mode instead starts with an unambiguous Zstandard/skippable frame magic.
 * The latter magic cannot be a valid message size under the encoded limit.
 * Never retry a failed codec or framing interpretation as another carrier.
 */
export function decodeZstdCarrier(data: Uint8Array, framing: 'text' | 'collector' | 'raw'): {
  bytes: Uint8Array; carrier: 'native-file' | 'collector-messages'; frames: number;
} {
  if (!data.length || data.length > MAX_ZSTD_BYTES) fail('encoded input must contain between 1 byte and 25 MiB');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 4) fail('incomplete frame or Collector length prefix');
  const budget: Budget = { decoded: 0, frames: 0, blocks: 0 };
  if (isFrame(view.getUint32(0, true))) {
    return { bytes: decompressFrames(data, budget), carrier: 'native-file', frames: budget.frames };
  }
  if (framing === 'raw') fail('a raw .pb.zst request must use native file compression; use .otlp.zst for Collector messages');
  const output: Uint8Array[] = [];
  let batches = 0;
  for (let at = 0; at < data.length;) {
    if (++batches > MAX_FRAMES) fail(`Collector input exceeds ${MAX_FRAMES} batches`);
    if (data.length - at < 4) fail('incomplete Collector length prefix');
    const size = view.getUint32(at, false);
    at += 4;
    if (!size || size > data.length - at) fail('Collector compressed batch exceeds available bytes');
    const bytes = decompressFrames(data.subarray(at, at + size), budget);
    if (framing === 'collector') {
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setUint32(0, bytes.length, false);
      addOutput(budget, 4);
      output.push(prefix, bytes);
    } else {
      addOutput(budget, 1);
      output.push(bytes, new Uint8Array([10]));
    }
    at += size;
  }
  return { bytes: concat(output), carrier: 'collector-messages', frames: budget.frames };
}
