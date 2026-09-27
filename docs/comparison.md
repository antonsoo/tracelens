# Comparing runs

The shared core in `src/core/compare.ts` powers the browser and CLI.
Neither trace is uploaded. The two files must each contain exactly one
trace ID; a collector batch needs to be split into individual runs first.

## What gets matched

For each span, construct a segment containing its service namespace,
service name, normalized kind and operation. An LLM operation uses
`gen_ai.operation.name` when present, otherwise its span name. Other kinds
use the tool name, agent name, or span name, in that order. The full path
from root to span is serialized as structured tuples, so punctuation in a
name cannot collide with a path separator.

IDs and absolute timestamps are not matching keys. Model attributes are
not matching keys either: changing the model on a `chat` operation keeps
it in the same group. If instrumentation embeds a model in the span name
without a separate operation attribute, changing that name changes the key.

All calls sharing a path contribute to one operation group. This avoids
claiming that the third `chat` in one run corresponds to the third in
another. It also means two same-named sibling agents with identical
operation ancestry are aggregated. The raw span IDs and model names remain
available inside each group. Renames and moved subtrees appear as removed
and added operations; there is no fuzzy matching.

## What the numbers mean

| Measurement | Definition |
|---|---|
| Elapsed time | Last span end minus first span start |
| Summed self time | Sum of span duration minus the union of direct-child intervals, clipped to the parent |
| Calls | Number of spans, including agent and chain wrappers |
| Input/output tokens | Usage reported on LLM spans; other kinds do not contribute |
| Estimated cost | Complete input/output usage priced with one shared table; missing usage or prices remain unknown |
| Errors | Spans with status `ERROR` |

Summed self time measures observed work. It can exceed elapsed time when
siblings overlap, or fall below it when there are gaps between separate
roots. Nested time is not counted twice, but concurrent sibling work is.
Sorting by this change identifies changes in work, **not** a causal
critical path. Parent-child links do not prove scheduling dependencies.

Change is always candidate minus baseline. A percentage has no defined
value when the baseline is zero, so the report uses `null` instead of
infinity. An absent operation is a known zero on that side. A present LLM
call without usage is unknown, not zero.

Each JSON measurement has a `value` (the known subtotal) and `missing`
(the count of calls missing that measurement). If either side has missing
data, both its delta and percent are `null`. Complete counts can still be
compared independently: missing output tokens do not hide known input
tokens. Cost needs both counts in the comparison and single-run views.
Invalid counts, cache counts exceeding total input, or missing prices
leave cost unknown. Single-run totals label priced subsets as subtotals.
Cached-token accounting follows the conventions in [formats](formats.md);
these figures are not invoices.

The exported `schemaVersion: 1` report includes a copy of the price table
used, so a later settings change does not erase the calculation inputs.
Prices can become stale. Source URLs and dates accompany each entry.

## Input limits and evidence

The browser accepts files up to 25 MB each. Comparison accepts up to 256
nesting levels. Duplicate IDs within a trace and cyclic parents are rejected
by the parser; missing parents remain visible as roots with a warning.
Missing or invalid span timestamps cause that span to be skipped, with a
warning. Decimal-string timestamps preserve nanosecond precision; numeric
timestamps are accepted only when they are safe, nonnegative integers.
Malformed/skipped spans and clock-skew corrections appear in the report's
warnings, and can make the two files less comparable.

The browser initially shows 100 operation groups and offers more on demand.
Each expanded group lists up to 100 calls per side. JSON includes every
group and call. The export deliberately omits prompt and tool payloads,
but names and span IDs are not anonymized.

## Verification

`npm test` checks matching independently of IDs, timestamps and input order;
repeated calls; changed models; ancestry/service separation; missing usage;
unpriced calls; zero baselines; and added/removed operations. Self-time
accounting is cross-checked against a separate discrete occupancy oracle
over generated interval sets. The synthetic example's totals are calculated
by hand in the test, rather than copied from the comparison output.

After `npm run build`, run `npm run test:cli` and `npm run test:browser`.
The latter needs Playwright's Chromium installed (`npx playwright install
chromium`). It starts a local preview server and exercises real uploads,
swapping, filtering, JSON download, per-side inspection, malformed-file
recovery, offline interaction, light/dark themes and a 375-pixel viewport.
It also checks blocked/corrupt storage, price validation, and preservation
of filters, sorting, expansion, focus and scroll across view changes.
These checks are included in CI; local results do not imply CI ran.
