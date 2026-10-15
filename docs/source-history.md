# Source history and evidence

The [README](../README.md) introduces the inspection workflows. This index keeps
their repair history and retained reproductions available without making a new
reader work through the maintenance log first.

Source, npm and the hosted app are separate artifacts. A source receipt does not
establish a registry release or the deployed browser revision. The linked
verification documents describe the specific builds and endpoints checked.

The [consolidated inspection verification](verification-inspection-2026-10-14.md)
records the newer clean build, installed-runtime checks and publication boundary
for retry, token-coverage, large-message and phone-layout corrections.

| Area | Reproduced behavior and correction | Evidence |
|---|---|---|
| Model rates | A recorded nano stream matched `gpt-5` and its token charge was overstated 25x. Match whole model names and providers, retaining component rates and source fields. | [Cost-accounting walkthrough and independent decimal check](cost-accounting.md). |
| Queued work | Jaeger references could attach to an unrelated local span with a reused span ID. Resolve links by complete trace/span identity, retaining missing targets and omissions. | [SDK queue workflow](span-links.md). |
| Exporter omissions | A controlled SDK capture dropped all five events without a warning in the earlier viewer. Retain omission counts and distinguish malformed Jaeger timing from measured zero. | [Dropped-evidence capture](../studies/dropped-evidence/README.md), [source/install/public-build receipt](verification-trace-integrity-2026-10-11.md). |
| Separate log exports | Messages emitted by the OpenTelemetry Python GenAI helper disappeared from combined JSONL; selecting separate trace/log files failed. Join both complete identities and retain original log records and source locations. | [Native SDK capture and browser/CLI replay](../studies/log-events/README.md). |
| Damaged message events | A malformed nested tool payload prevented a readable six-span trace from opening. Keep the original message with a scoped warning; input attributes do not hide valid output events. | [Captured controls and before/after results](../studies/event-messages/README.md). |
| Status declarations | Quoted integer codes hid known errors, while unreadable values could look successful. Decode exact codes, retain unfamiliar/raw values, and withhold unsupported error deltas. | [SDK and reference-decoder replay](../studies/status-evidence/README.md). |
| Partial imports | Retained charges and tokens could appear to be complete totals after a model call was skipped. Keep known subtotals, withhold full estimates and totals, and preserve complete controls. | [Native cost and token-coverage replay](../studies/cost-coverage/README.md). |
| Possible retries | Unchanged timestamp peers produced 0 or 1 retry depending on export order. Clamped reversed intervals also implied completed failures. Preserve ambiguous outcome/completion evidence as unknown and keep the supplied reversed end downloadable. | [Native permutations, timing damage and offline browser evidence](../studies/retry-order/README.md). |
| Large message imports | The same JSON history was decoded repeatedly for message and finish-reason extraction. Share one decoded value, preserving normalized fields, warnings and rejected inputs. | [Controlled timing, fixture equivalence and offline downloads](../studies/message-decoding/README.md). |
| Phone inspection | A 6,000-span trace put selected details about 150,206 pixels below the timeline start. Bound the timeline pane, leave room beside labels for timing, and retain all rows and downloads. | [Before/after geometry and keyboard/download controls](../studies/mobile-waterfall/README.md). |

The instrumentation census is a separate historical study of supported dialects,
not an accuracy estimate for every subsequent revision. It replayed recorded
provider responses without calling a model. Its original cost column used the
old matching rule; the later cost study independently checked the corrected
rates and arithmetic.

Earlier publication snapshots remain available for [timing, cost and links](verification-publish-2026-10-09.md).
The npm 0.3.3 package predates those commands and the later `logs` command;
build the source to use the current CLI.
