/// <reference lib="dom" />
import { ZSTD_WASM_BASE64 } from './vendor/zstd-wasm.js';

interface Kernel extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  ZSTD_versionNumber(): number;
  ZSTD_decompress(dst: number, capacity: number, src: number, size: number): number;
  ZSTD_isError(value: number): number;
  ZSTD_getErrorCode(value: number): number;
  malloc(size: number): number;
  free(pointer: number): void;
}
let cached: Kernel | undefined;

/** The pinned reference decoder has no host imports and a 128 MiB memory maximum.
 * Embedded bytes keep the first compressed import usable after disconnection.
 * Instantiate only for compressed input, inside the existing disposable worker.
 */
function kernel(): Kernel {
  if (cached) return cached;
  const text = atob(ZSTD_WASM_BASE64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  const module = new WebAssembly.Module(bytes.buffer);
  if (WebAssembly.Module.imports(module).length) throw new Error('The bundled decoder has unexpected host imports.');
  const exports = new WebAssembly.Instance(module, {}).exports as Kernel;
  exports._initialize();
  if (exports.ZSTD_versionNumber() !== 10507) throw new Error('The bundled decoder version is unexpected.');
  cached = exports;
  return exports;
}

/** Call libzstd with an explicit output capacity, including unknown-size frames.
 * Reacquire the memory view after allocations: malloc may grow linear memory.
 */
export function decompressZstdFrame(bytes: Uint8Array, capacity: number): Uint8Array {
  const codec = kernel();
  let source = 0, destination = 0;
  try {
    source = codec.malloc(Math.max(1, bytes.length));
    destination = codec.malloc(Math.max(1, capacity));
    if (!source || !destination) throw new Error('the bounded decoder workspace could not be allocated');
    new Uint8Array(codec.memory.buffer).set(bytes, source);
    const size = codec.ZSTD_decompress(destination, capacity, source, bytes.length);
    if (codec.ZSTD_isError(size)) {
      const code = codec.ZSTD_getErrorCode(size);
      throw new Error(code === 22 ? 'content checksum mismatch'
        : code === 70 ? 'frame exceeds its declared size or expanded-input limit'
          : 'invalid compressed frame');
    }
    return new Uint8Array(codec.memory.buffer, destination, size).slice();
  } finally {
    if (destination) codec.free(destination);
    if (source) codec.free(source);
  }
}
