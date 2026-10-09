# Default-price review, 2026-10-09

Reviewing the local cost-receipt feature against the providers' live pages found
one incorrect cache-read rate and three omitted cache-write rates. GPT-6.1 Sol
also needed its own entry: GPT-6 Sol's cached rate does not apply to it.

The following USD rates are per million tokens, for standard service and short
context. Anthropic cache writes use the 5-minute TTL.

| Model | Input | Output | Cache read | Cache write | Source |
| --- | ---: | ---: | ---: | ---: | --- |
| Claude Sonnet 5.5 | 2 | 10 | 0.10 | 2.50 | [Claude pricing](https://claude.com/pricing) |
| GPT-6 Astra | 10 | 50 | 1 | 12.50 | [OpenAI pricing](https://developers.openai.com/api/docs/pricing) |
| GPT-6 Sol | 2 | 10 | 0.20 | 2.50 | [Model page](https://developers.openai.com/api/docs/models/gpt-6-sol) |
| GPT-6 Luna | 0.10 | 0.50 | 0.01 | 0.125 | [OpenAI pricing](https://developers.openai.com/api/docs/pricing) |
| GPT-6.1 Sol | 2 | 10 | 0.10 | 2.50 | [Model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) |

Sonnet 5.5 previously used $0.20 for cache reads, doubling that component.
Astra, Sol and Luna cache writes fell back to the input rate, understating
that component by 20% relative to the published write price. Their receipts
exposed the fallback, but now they use the explicit rates. GPT-6.1 Sol was
unpriced; it remains a separate whole-model identity.

All 11 existing Anthropic rows were checked on the linked page. Their other
rates matched. The remaining older OpenAI defaults retain their previous
source dates; this review does not imply they were all freshly checked.
The nano receipt's $0.05 input, $0.005 cached input and $0.40 output rates were
rechecked on its [model page](https://developers.openai.com/api/docs/models/gpt-5-nano).

`replay.mjs` feeds each of four token components separately through five models,
using constructed 1,000-token counters. These are arithmetic controls, not
provider calls or observed invoices. Expected values are separate transcriptions
of the cited facts, rather than values read out of the app's table.

```bash
npm ci
npm run build:cli
node studies/default-prices/replay.mjs dist-cli/core/index.js /tmp/tracelens-prices.json
```

[Before](before.json), from `9d1d5bd`: 8 of 20 controls disagree (4 wrong
components and 4 unpriced GPT-6.1 Sol components).
[After](after.json): all 20 agree. The replay exits unsuccessfully for any
disagreement; `--record-only` retains an intentionally failing before report.
It also accepts the compiled core from an installed package.

These remain estimates under selected rates. Context premiums, service tiers,
regional premiums, extended cache TTL and non-token fees are not inferred.
A saved browser table preserves the user's rates across application updates;
**Prices -> Reset to defaults -> Save** explicitly adopts the current defaults.
Export the old table first if you need to reproduce an older estimate.
