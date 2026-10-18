# Third-party notices

The generated modules under `src/core/proto/` derive from the OpenTelemetry
Authors' OTLP schemas, distributed in `opentelemetry-proto` 1.45.1 under the
Apache License 2.0. The source descriptor and generated-file hashes are in
[`scripts/otlp-schemas.json`](scripts/otlp-schemas.json); the license is in
[`LICENSE-OTEL`](LICENSE-OTEL). Regeneration uses the pinned official Python
package and `protoc-gen-es` 2.16.0; ordinary builds use the committed modules.

Protobuf decoding uses `@bufbuild/protobuf` 2.16.0, Copyright 2021-2026 Buf
Technologies, Inc., under Apache-2.0. Its varint implementation includes code
Copyright 2008 Google Inc. under BSD-3-Clause. The complete license and notices
are retained in [`LICENSE-PROTOBUF-ES`](LICENSE-PROTOBUF-ES). Static browser
builds also include these license texts in `licenses/`.

The application remains MIT licensed. Existing bundled fonts retain their
licenses under `src/web/fonts/LICENSE.txt`.
