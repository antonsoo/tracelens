# Span-link evidence

This study checks loss of recorded relationships and false cross-trace
parents, using a controlled SDK capture plus direct identity controls.
It does not establish production coverage, causality or latency accuracy.

## Capture

```sh
uv run --locked scripts/capture-links.py
```

The script writes `examples/queue-links.json` and its SDK-object oracle.
The checked-in capture SHA-256 is
`7e229d5106922cfd8f39c702f18f3893d01f636c52e740fb4019084900487573`.
Regeneration creates fresh IDs and measured timestamps. It uses a real Queue,
OpenTelemetry context propagation, SDK spans, and the SDK's protobuf encoder.
No model, external API, collector or credentials are involved.

The oracle is recorded before encoding, rather than reconstructed through
Tracelens. Identity, parent IDs, attribute values, link order, dropped counts
and target names agree with the current importer. The pinned Python 1.45.1
encoder's `_encode_links` omits `trace_state`: 7 nonempty SDK values do not
reach the file. The replay explicitly excludes that unavailable field from
SDK parity, retains it in the oracle, and separately checks a supplied OTLP
trace-state value. Flags are tested as supplied uint32 values in controls.

## Replay

```sh
npm run build:cli
node studies/span-links/replay.mjs dist-cli/core/index.js studies/span-links/current.json
```

Pass a different compiled core path to check the previous build or an installed
package. `before.json` used commit `eed0aa2`; `current.json` used this change.
The script verifies the capture hash before reading it.

| Check | Before | Current |
| --- | ---: | ---: |
| Recorded SDK links retained | 0 / 8 | 8 / 8 |
| SDK source spans disagreeing on retained links/dropped count | 6 / 9 | 0 / 9 |
| Target-resolution failures (400 OTLP/JSON Lines cases) | 400 | 0 |
| Metadata failures in those cases | 400 | 0 |
| Timing changes after adding OTLP links | 0 | 0 |
| False local parents (200 native Jaeger cases) | 200 | 0 |
| Lost Jaeger references in those cases | 200 | 0 |

The 600 controls rotate export order and reuse span IDs across traces. They
are generated examples, not 600 independent production captures. The controls
check explicit expected identities and parent rules; the SDK oracle is the
independent check for the captured workflow. Separate regression cases cover
duplicate targets, malformed evidence, cycles, self-links and snake-case keys.

`installed-node20.json` and `installed-node26.json` repeat the replay against
the packed CLI installed outside the checkout. `installed-cli.json` records
18 actual command invocations; `cli-links-v*.json` retains their link reports.

`measure.mjs` generates a 6.67 MB / 20,000-span input with 40,000 links. Pass
the same two arguments as the replay to time two warmups and five import
passes. `performance-before.json` and `performance-current.json` retain the
observations. Other checks were running on the host; these measurements do
not isolate the change's cost, and the before implementation discarded links.

## Browser evidence

Serve the built site on port 4320, then run:

```sh
node studies/span-links/browser-evidence.mjs
```

The driver writes actual downloaded span JSON, observed offline navigation,
and four screenshots to `docs/assets/links-*.png`. It exercises 1440px light
and dark views, 320px dark and 375px light. Screenshots are visually reviewed,
not pixel baselines. Playwright regression scenarios also cover Firefox,
comparison preservation, unavailable targets, keyboard use, 1,001 links with
complete downloads, accessibility and worker recovery.
