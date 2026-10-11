# Keep unreadable trace containers visible

Source `6d55a07` silently skipped malformed OTLP resource/scope entries and
non-array span collections whenever another part of the file supplied a valid
span. The retained span appeared with no parser warning. Non-object entries in
a Jaeger trace's span list also disappeared without a warning.

The correction keeps readable spans and reports the source path of unreadable
containers. It does not infer how many spans were lost or which traces they
belonged to. Unassignable damage is therefore a file-wide warning. When a
record still supplies its trace ID, its warning stays with that trace. This
also corrects an existing OTLP missing-span-ID warning that appeared on
unrelated traces.

This is local source work, without a push, hosted deployment or package release.

## Reproduction

[`cases.mjs`](cases.mjs) reuses the [actual SDK control](../attribute-values/fixtures/sdk-control.json)
and explicitly mutates its enclosing containers. The two readable traces and
all corruptions are controlled fixtures. They do not show a malformed export
produced by the SDK itself. A separate minimal Jaeger control exercises its
converter. Empty and null Protobuf repeated-field controls are retained too.

The [baseline](before.json) meets **4/15** expected retained-span/diagnostic/CLI
outcomes; the [corrected source](after.json) meets **15/15**. The cases include
both selections from every two-trace input and a JSON Lines batch variant.
Every input retains one readable span per selected trace. The change is whether
the diagnostic survives and belongs to the correct trace, not invented recovery
of missing records.

| Input | Baseline warnings | Corrected warnings |
| --- | --- | --- |
| Non-object resource or scope entry | None | File-wide source path |
| `scopeSpans` or `spans` supplied as an object | None | File-wide source path; missing count unknown |
| Omitted/null/empty repeated field | None | None |
| OTLP span with known trace, missing span ID | On both selected traces | On the affected trace |
| Non-object span within a named Jaeger trace | None | On the affected trace |

The [Protobuf JSON null/repeated-field contract](https://protobuf.dev/programming-guides/json/#null-values)
permits an unset/null repeated field but excludes null elements *inside* its
array. The [OTLP data shape](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto)
defines the resource/scope/span lists. These rules were checked 2026-10-10.

[`partial.json`](partial.json) contains two readable SDK-derived traces and
four malformed containers. [Chromium](browser-chromium.json) and
[Firefox](browser-firefox.json) import it through the built worker, go offline,
switch between both traces and download all four warnings on each. The file's
unassignable damage remains visible after selection; each trace still has one
visible span and no page errors were observed.

The [existing-corpus replay](corpus.json) leaves **22/22** file outcomes unchanged:
27 selected traces and 127 spans, plus the metadata-only rejection control.
These checks compare complete parsed traces and warnings.

```sh
npm ci
npm run build
node studies/export-containers/replay.mjs dist-cli studies/export-containers/after.json
CAPTURE_CONTAINER_EVIDENCE=1 npx playwright test tests/browser/export-containers.spec.mjs
```

To replay baseline, pass the `dist-cli` directory from a separate fresh
archive/install of `6d55a07`. To regenerate the browser fixture:

```sh
node --input-type=module <<'JS'
import {partial} from './studies/export-containers/cases.mjs';
import {writeFileSync} from 'node:fs';
writeFileSync('studies/export-containers/partial.json', JSON.stringify(partial,null,2)+'\n');
JS
```

This is not a complete export validator. The parser still requires a recognizable
top-level format and at least one valid span. An unreadable root or a file with
no usable spans remains an error. Jaeger document recognition still requires
valid trace wrappers; this change diagnoses malformed span-list entries within
recognized traces. Source paths in JSON Lines refer to the joined resource
array, not the original line. Span counts, timing and costs describe the retained
spans only; warnings do not quantify unrecorded work.

The final combined clean-build and installed-package record is in
[`checks.json`](checks.json).
