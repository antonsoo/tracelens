# Decode a message field once

The importer decoded `gen_ai.input.messages` twice, output messages up to three
times, and system instructions up to four times. Those fields can hold a complete
agent history. The first normalized copy was only used as a presence check, then
discarded before constructing the identical second copy.

The parser now shares one decoded value with normalization and finish-reason
extraction. System parts and older message-shaped system instructions retain
their interpretation. Event and correlated-log details use the same path.
There is no input-retaining global cache. A decoded string is not interpreted
again as another JSON document; malformed fields remain in their raw attributes.

## Measurements

[`workloads.mjs`](workloads.mjs) generates two **synthetic valid OTLP workloads**.
These are controlled import experiments, not actual model requests or measured
agent latency. Span times and message text are supplied by the generator.

| Workload | JSON bytes | Shape |
|---|---:|---|
| History | 18,727,308 | 160 calls, each carrying 800 short messages, plus one root |
| System parts | 5,239,758 | 50 calls, each carrying 500 instruction parts and 10 input messages, plus one root |

On this shared 14-vCPU WSL2 Linux host, the median `parseTraceText` import times
were:

| Runtime | Workload | Before | After | Reduction |
|---|---|---:|---:|---:|
| Node 20.0.0 | History | 272.9 ms | 151.0 ms | 44.7% |
| Node 20.0.0 | System parts | 56.6 ms | 26.0 ms | 54.0% |
| Node 26.7.0 | History | 261.6 ms | 188.3 ms | 28.0% |
| Node 26.7.0 | System parts | 70.0 ms | 28.6 ms | 59.2% |

[Node 20 observations](results/node20.json) and
[Node 26 observations](results/node26.json) retain every sample, exact input and
output hashes, compiled normalization hashes and environment details. Each
workload/phase uses five fresh processes, with one warmup and six timed imports
per process. Phase order alternates; explicit GC precedes each import. Timings
include text parsing and normalization, and exclude file I/O, output hashing,
browser transfer and rendering. Before is the normalization implementation in
`7e6888f`; the result files identify its exact compiled bytes.

History peak RSS is essentially unchanged. System-parts RSS falls slightly;
the claim here is lower elapsed core import time, not a general memory reduction
or a measurement of process CPU usage. These two workloads do not predict
speedups for arbitrary traces, and shared-host load changes absolute times.
No test assertion or deadline was relaxed.

## Evidence stays equivalent

The driver compares 54 retained fixture files across the two compiled cores:
46 parsed traces and eight rejected non-trace/control records. All parsed
fields, warnings and child/root identity lists agree; rejection names and
messages also agree. The files include native SDK/instrumentation captures,
trace/log exports, alias/identity variants, status damage and omission counts.
Their paths and hashes are retained in both result files. The large workload
output hashes also agree in every fresh process.

The browser regression in
[`tests/browser/message-import.spec.mjs`](../../tests/browser/message-import.spec.mjs)
disconnects before its first file import, in Chromium and Firefox at 1440 px
and 375 px. It imports the generated workloads through real workers, selects a
call, reaches the last message/part page, and downloads the complete span.
The 800 input messages or 500 system parts remain in the download while only
20 entries occupy the selected page. Raw message attributes and normalized
messages agree, including output text and finish reason. The workflow also
checks page errors, late/external requests, accessibility and document overflow.
Browser durations describe the entire automation workflow and are not the
core timings in the table above.

## Reproduce

Build baseline `7e6888f` in a separate checkout, then build the current checkout:

```bash
npm ci && npm run build
node studies/message-decoding/measure.mjs --before /path/to/baseline/dist-cli/core/index.js --out timings.json
npm exec -- playwright test tests/browser/message-import.spec.mjs --workers=1
```

`--after` selects another compiled core, `--node` selects the measurement
runtime, and `--inputs` retains the generated JSON files. Build checkouts with
their package metadata intact so the oldest supported Node reads their ESM
modules the same way an installed package does.
