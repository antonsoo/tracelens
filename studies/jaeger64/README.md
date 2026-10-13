# One request across Jaeger and OTLP exports

A gateway export from Jaeger and a worker export from OpenTelemetry can identify
the same request using different strings. Jaeger's
[TraceID.String implementation](https://github.com/jaegertracing/jaeger-idl/blob/v0.9.0/model/v1/ids.go#L37-L42)
prints sixteen hex digits when the high 64 bits are zero. Its
[query/UI converter](https://github.com/jaegertracing/jaeger/blob/v1.76.0/internal/uimodel/converter/v1/json/from_domain.go#L56-L90)
uses that representation for spans and references. OTLP carries the complete
16-byte identity. Both spellings below describe the same bytes:

| Export | Trace ID |
| --- | --- |
| Jaeger UI/query JSON | `1234567890abcdef` |
| OTLP JSON | `00000000000000001234567890abcdef` |

At `cd156221`, TraceLens grouped these as different traces. The source fix pads
complete 16-hex trace IDs before any grouping, parent resolution, link lookup,
selection or duplicate checks. It does not truncate a 128-bit identity.

![Gateway, worker and model call in one request](../../docs/assets/jaeger64/chromium-1440.png)

## Retained reproduction

The four small [fixtures](fixtures/) are synthetic, with explicit timestamps,
IDs and token counts. They are not a production capture or a run of Jaeger.
The upstream encoders above establish the representation; an independently
written all-OTLP gateway is the control for the mixed import.

```
dispatch request        gateway.jaeger.json
  process request       worker.otlp.json
    chat gpt-4o         worker.otlp.json

receipt                 audit.otlp.json (a separate trace)
  links to gateway and worker spans
```

| Observation | Before | After |
| --- | --- | --- |
| Traces in the three-file group | 3 | 2 |
| Request spans shown by default | 2 | 3 |
| Request elapsed time | 8 ms | 10 ms |
| Audit link to gateway | Missing span | Available |
| Gateway re-exported in OTLP | Accepted as a separate trace | Duplicate rejected |
| Replay checks matching expected behavior | 1/17 | 17/17 |

[`replay.mjs`](replay.mjs) checks both file orders, all four complete selector
spellings, same-document references and aliases, nonzero-high-word separation,
and real CLI summary/tree/timing/cost/links commands. Summary content is compared
after its filename header; tree, timing and cost stdout match the canonical
control byte-for-byte. Raw observations and fixture hashes are retained in
[`before.json`](before.json) and [`after.json`](after.json).

From this source revision:

```sh
npm ci
npm run build
node dist-cli/cli/index.js tree studies/jaeger64/fixtures/gateway.jaeger.json studies/jaeger64/fixtures/worker.otlp.json studies/jaeger64/fixtures/audit.otlp.json
```

Repeat the observations with:

```sh
node studies/jaeger64/replay.mjs --output /tmp/tracelens-jaeger64.json --expect-fixed
node studies/jaeger64/browser.mjs --build dist --output /tmp/tracelens-jaeger64-browser --after
```

[`browser-before.json`](browser-before.json) and
[`browser-after.json`](browser-after.json) retain Chromium and Firefox workflows
at 1440px dark and 375px light. Each checks the bytes of 24 served assets and
stops the server before importing. The repaired workflows download the selected
span and audit links, follow the gateway link by keyboard, compare with the
all-OTLP control, and reject a duplicate candidate while preserving the previous
comparison. All four completed with no page/CSP errors, external or late network
requests, page overflow, or settled-state axe violations. The screenshots were
visually inspected; the mobile waterfall scrolls within its pane.

## Identity boundaries

Only complete 16-character hexadecimal trace IDs get this compatibility
normalization. Span IDs already occupy eight bytes and are unchanged. Other
short or opaque labels keep their previous handling. Nonzero high words identify
different traces. A complete 64-bit selector wins over a coincidentally matching
128-bit prefix; the complete 128-bit selector remains available.

Identical exported spans are still rejected as duplicates, with both source
files identified. This repair neither deduplicates retransmissions nor merges
unrelated traces by names or timestamps. An accepted import does not prove that
the exporter recorded every span. Canonical trace IDs in reports from older
64-bit Jaeger exports now have 32 hex characters.

The package version remains 0.3.3. This source change does not update the npm
release or hosted demo.
