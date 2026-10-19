# Open the Collector's compressed files directly

Baseline `4039a33` rejects valid compressed Collector exports as non-text.
The source CLI and browser now open Zstandard-compressed JSON and explicitly
declared protobuf files directly. Both the default per-message compression
and the optional native file compression are supported.

These are different containers. The [pinned Collector documentation](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.163.0/exporter/fileexporter/README.md#file-format)
describes the distinction; [capture.py](capture.py) ran the actual **Collector
0.163.1** in both modes. It wrote compressed and uncompressed JSON/protobuf
in parallel from the same retained SDK request bodies. Python Zstandard and
Google Protobuf independently checked those outputs.

| File declaration | Default Collector compression | Native file compression |
| --- | --- | --- |
| `.json.zst`, `.jsonl.zst`, `.ndjson.zst` | Length-prefixed compressed JSON batches | JSON/JSONL inside standard Zstandard frames |
| `.traces.otlp.zst`, `.logs.otlp.zst` | Length-prefixed compressed protobuf batches | Length-prefixed protobuf inside standard Zstandard frames |
| `.traces.pb.zst`, `.logs.pb.zst` | Not a raw request; use `.otlp.zst` | One compressed raw OTLP request |

Protobuf still needs an explicit signal and framing declaration. A `.zst`
suffix declares compression; the unambiguous frame magic distinguishes the
two containers. A failed interpretation is never retried as another carrier.
Bare `.zst` asks for the payload declaration. Custom encoding extensions,
external dictionaries, gzip/ZIP and gRPC message framing are outside this addition.

## Try the captured exports

Build the source checkout:

```sh
npm ci
npm run build
node dist-cli/cli/index.js logs studies/zstd-collector/fixtures/native/traces.traces.otlp.zst studies/zstd-collector/fixtures/native/logs.logs.otlp.zst --json
```

The output has four spans in the selected workflow and two matched logs;
the file also contains a separate two-span consumer trace. The
[retained requests](../otlp-binary/fixtures/oracle.json) originated in Python
SDK 1.45.1 and the GenAI helper 1.2b0. Their conversation is **scripted**;
the digest tool actually computes a local SHA-256. No model, credentials or
external telemetry service was used. Source IDs and clocks were not rewritten.
This is a protocol capture, not a production agent incident.

In the browser, select both compressed files together. Alternatively, use the
`legacy/` JSON pair, or drop the [5,001-span JSON capture](load/traces.jsonl.zst)
or [protobuf capture](load/traces.traces.otlp.zst). The [direct demo](https://antonsoo.github.io/tracelens/?example=collector-zstd)
and home-page sample button fetch the exact retained compressed protobuf file.
[Four browser workflows](after/sample-browser.json) open those two entry points,
then disconnect before finding and downloading the last SDK tool span.
The larger trace records
5,000 actual local digest computations over generated inputs, under one
workflow span. It contains no LLM calls. [SDK observations](load/sdk-spans.json.gz)
and [native-file hashes](load/oracle.json) accompany it.

The decoded source retains compression kind, carrier, frame count and expanded
byte count as transport metadata. Comparisons retain that metadata per input
file. Choosing another trace from the same input preserves it. Routine
compression adds no warning badge. Span JSON and any JSON line references
concern decoded content; retain the original compressed files for their bytes.

## Native evidence and refusal paths

[before.json](before.json) records the four failed paired CLI imports.
The [before browser workflows](before/browser.json) each load the uncompressed
control, then fail to import its compressed counterpart while preserving the
loaded trace. [After](after/browser.json), sixteen workflows cover both modes,
both payloads, Chromium/Firefox and 1440/375-pixel layouts. Every page disconnects
before its first import. Checks include exact downloaded clocks and int64 values,
log messages, missing event times, cross-trace navigation, comparison export,
damaged replacement and recovery. The parser remains in a disposable worker.

| Independent or native check | Observed result |
| --- | --- |
| Collector compressed trace/log files | 8; all expanded bytes match Python |
| Complete normalized trace comparisons | 8; observations, timing and cost evidence match uncompressed controls |
| Regular offline browser workflows | 16; no page, CSP, post-disconnect request or overflow errors |
| Larger native workload | 5,001 spans; every original SDK ID, clock and attribute agrees |
| Larger offline browser imports | 4; distant tool record downloads with original SDK values |
| Constructed byte-codec variants | 399; all decoded byte hashes match Python |
| Single-bit mutations, with and without a checksum | 6,992; reference acceptance and accepted bytes agree within stated limits |

[Core replay](after/replay.json), [codec replay](after/codec.json),
[compressed codec oracle](after/codec-oracle.json.gz) and
[larger browser imports](after/load-browser.json) retain the counts and scope.
The codec corpus and mutations are **constructed controls**, separate from the
native telemetry. Eight mutated headers request unsupported dictionaries or
resource sizes and are explicitly classified outside the supported limits.

The wrapper inspects frame extents, declared output sizes and window requests
before calling the reference **libzstd 1.5.7** decoder. The codec validates the
bitstream and optional [XXH64 content checksum](https://github.com/facebook/zstd/blob/v1.5.7/doc/zstd_compression_format.md#content-checksum).
The constructed corpus includes eight checksum-free damaged bitstreams that
an earlier, unshipped lightweight-decoder candidate accepted while libzstd
refused them. All eight are now retained refusal controls. A checksum alone
cannot establish that a decoder handles malformed checksum-free input.

The bundled WebAssembly module is 72,826 bytes, has **no host imports**, and a
128 MiB linear-memory maximum. Its source archives, compiler flags, binary hash
and ABI are [pinned](../../scripts/zstd/decoder.json). Ordinary npm builds use
the committed bytes; the explicit Linux x86-64 maintenance command
`python scripts/build-zstd.py` (Python 3.12+) rebuilds them with hash-verified WASI SDK 27.0.
[BSD and linked runtime notices](../../THIRD_PARTY_NOTICES.md) ship in both the
package and static site. No external decompression service or decoder download
is used. Browser CSP permits `wasm-unsafe-eval` for this static module while
keeping JavaScript string evaluation disabled.

Corrupted first-frame checksums retain complete later batches as a control;
they still refuse the whole input. Incomplete frames and trailing bytes are
refused too. An input ending exactly between complete frames/batches cannot
reveal that later data was omitted. Existing decoded-JSONL partial-line warnings
remain separate from compressed-frame validation.

Encoded and expanded compressed files are each limited to **25 MiB**; decoding
windows to 25 MiB, frames/batches to 100,000 and blocks to one million. Existing
protobuf wire and decoded-text limits still apply. Browser groups additionally
limit total decoded text to 26,214,400 UTF-16 units before parsing. Two valid
606-byte constructed files that jointly expand beyond that text limit are
refused, retaining the complete previous comparison. The 128 MiB WebAssembly limit
bounds decoder linear memory; it does not bound JavaScript or whole-process
memory. The worker's existing 30-second deadline and
cancellation remain in force.

[Desktop decoded messages](after/native-proto.png), [phone messages](after/mobile.png),
[larger desktop capture](after/chromium-load.png) and
[larger phone capture](after/firefox-load.png) are real app screenshots.
Before/after screenshots and the larger-capture views were opened and inspected.
The application keeps its existing layout and typography.

## Measured cost of opening the larger capture

Twelve fresh Node 26.7.0 processes and twelve fresh installed-package Node
20.0.0 processes read the same 5,001-span native workload. File I/O, module import
and SDK-observation checks are excluded from core wall time. Every normalized
span and timing hash agrees across carriers and runtimes. The raw
[Node 26](after/load-core.json) and [Node 20](after/load-core-node20.json) records
retain ranges and definitions.

| Carrier | Encoded bytes | Node 26 median core ms | Node 20 median core ms |
| --- | ---: | ---: | ---: |
| JSON | 3,029,650 | 423 | 426 |
| JSON + Zstandard | 298,764 | 384 | 546 |
| Protobuf | 1,387,760 | 825 | 887 |
| Protobuf + Zstandard | 303,658 | 803 | 840 |

These observations used a 14-vCPU WSL2 Linux machine with 48 GB RAM. Browser
verification was active during the series; background activity was not
isolated. Compression saves input bytes; the measured time ranges overlap,
and no speedup is inferred. These are descriptive observations, not production
or browser latency guarantees.

Memory records distinguish raw `rusage` from the current program image's
kernel-reported Linux `VmHWM`, both read after SDK comparisons. Linux preserves
[resource usage across exec](https://man7.org/linux/man-pages/man2/getrusage.2.html).
A [controlled preceding allocation](rss-image-control.py) followed by Node
[retains about 268 MiB in rusage while the current image reports about 43 MiB](after/rss-image-control.json).
The study keeps both measurements rather than attributing the former image's
high water to the decoder. Neither reading is a whole-process memory ceiling.

## Reproduce the independent checks

```sh
uv run studies/zstd-collector/capture.py --collector PATH_TO_OTELCOL --out NEW_CAPTURE_DIR
uv run studies/zstd-collector/controls.py
node studies/zstd-collector/replay.mjs dist-cli OUTPUT_DIR
uv run studies/zstd-collector/codec-corpus.py
node studies/zstd-collector/replay-codec.mjs dist-cli OUTPUT_DIR
uv run studies/zstd-collector/unpack-load.py --out NEW_LOAD_DIR
node studies/zstd-collector/measure-series.mjs dist-cli NEW_LOAD_DIR OUTPUT_JSON
```

To make a fresh actual SDK workload instead of expanding the retained one:

```sh
uv run studies/zstd-collector/load.py --collector PATH_TO_OTELCOL --out NEW_LOAD_DIR
```

The drivers pin Python dependencies and verify the recorded Collector binary
hash. `browser.mjs URL OUTPUT_DIR after` and `load-browser.mjs URL OUTPUT_DIR`
run the independent offline UI workflows against any served build. Run the
former with `before` against a separately built archive of `4039a33` to reproduce
the rejected native inputs. This source addition is separate from npm 0.3.3.

[Clean checkout, installed package and minimum-runtime verification](../../docs/verification-zstd-collector-2026-10-19.md)
keep source, local artifact and registry claims separate.
