# What real instrumentation libraries write, and what tracelens made of it

tracelens reads OpenTelemetry traces of LLM calls and shows the model, the
tokens, the tool calls and the cost. Its example traces were made with the
OpenTelemetry SDK and attributes set by hand to follow the GenAI semantic
conventions. The libraries people actually install do not all follow them, and
tracelens had never been given their output.

This study gives it that output and checks every figure it shows against what
the provider's API returned. No model is called and no API key is used. Each
library is run over the recorded HTTP responses its own test suite replays, and
the spans it exports are captured; the recorded response is the yardstick.

**What came out**

- **Twenty-one emitters, 14,936 spans, no crash and no wrong nesting.** The
  released 0.3.3 recognised 2,911 of the 2,925 spans the libraries themselves
  mark as model calls; this checkout recognises 2,924.
- **The basics were already right.** Of 1,442 model calls that could be paired
  with a recorded response, 0.3.3 showed the provider's model for 1,379 and its
  input and output token counts for 1,236 and 1,133. Those numbers did not
  move. Most of the remainder is not tracelens: in 28 calls the span names no
  model, and 57 token figures are a different figure the provider also
  reports (Anthropic's input count without cached tokens, Gemini's output
  without thinking tokens, Cohere's billed units).
- **What it missed was everything newer than the basics.** Cache-read tokens:
  49 of 86 calls shown, now 85. Reasoning tokens: 21 of 280, now 193 (86 are
  not in the span at all). Tool calls: 171 of 291, now 250. Cost: 516 of 554
  right, now 544.
- **One dialect was nearly invisible.** The Vercel AI SDK writes `ai.*`
  attributes, in version 6 and in version 7's legacy mode. From those spans
  0.3.3 showed no cache-read tokens, no reasoning tokens and no tool calls, in
  any of 142 calls. It now shows them in 18 of 18, 45 of 45 and 37 of 39.
- **Sixty figures differ from the provider's and still do.** In 10 calls the
  input count shown, and in 50 the output count, is not the one in the
  recorded response. 39 of the 50 are OpenLLMetry's Anthropic instrumentation,
  off by 1 to 5 tokens in 36. Whether the library wrote another number or
  tracelens read the wrong attribute was not separated call by call.

## The emitters

`capture/run-all.sh` fetches six repositories at pinned commits, installs each
library in its own virtual environment, and runs its test suite with a plugin
that copies every exported span (`capture/dump_plugin.py`). The tests replay
HTTP cassettes recorded from real providers. For the Vercel AI SDK, which has
no such suite, `capture/replay-aisdk.mjs` points the SDK at a local server that
answers with the recorded responses in the SDK's own test fixtures. Everything
third-party runs with an empty environment.

| Repository | Commit | Licence |
|---|---|---|
| open-telemetry/opentelemetry-python-contrib | `fba0b77` | Apache-2.0 |
| traceloop/openllmetry | `df4921a` | Apache-2.0 |
| Arize-ai/openinference | `b625e5c` | Apache-2.0 |
| pydantic/pydantic-ai | `f55bb8a` | MIT |
| vercel/ai | `5028fa4` | Apache-2.0 |

(The sixth is opentelemetry-python itself, a dependency.) A test counts when
the number of model calls in its cassette equals the number of spans the
library marks as model calls; calls and spans are then paired in order. Tests
where the counts differ are left out, which is why some libraries contribute
far fewer calls than their cassettes hold.

## What is measured

For each paired call, `yardstick.py` reads the facts the API returned: model,
input and output tokens, cache-read and reasoning tokens, tool calls. It never
looks at a span. `read-with-tracelens.mjs` reads the same spans with a build of
tracelens and records what it would show. `score.py` compares, per field:

- **right**: tracelens shows the provider's value;
- **another figure**: it shows a value the provider also reports for the same
  thing, counted differently;
- **differs**: it shows some other value;
- **not in the span**: the library did not record it;
- **missed**: the span holds it and tracelens does not show it.

Cost is right when tracelens prices the call with the tokens and model the
provider reported.

## Results

All 1,442 paired calls. The denominator is the calls where the provider
reported the fact.

| | Reported in | 0.3.3 right | Checkout right | Still not right |
|---|---:|---:|---:|---|
| Recognised as a model call | 1,442 | 1,436 | 1,442 | |
| Model | 1,413 | 1,379 | 1,382 | 28 not in the span, 3 differ |
| Input tokens | 1,282 | 1,236 | 1,236 | 23 not in the span, 13 another figure, 10 differ |
| Output tokens | 1,244 | 1,133 | 1,133 | 17 not in the span, 44 another figure, 50 differ |
| Cache-read tokens | 86 | 49 | 85 | 1 not in the span |
| Reasoning tokens | 280 | 21 | 193 | 86 not in the span, 1 missed |
| Tool calls | 291 | 171 | 250 | 37 not in the span, 2 differ, 2 missed |
| Cost | 554 | 516 | 544 | 9 where the span lacks what pricing needs, 1 differs |

By emitter. A cell is right over reported; `a -> b` is 0.3.3 then this
checkout; "none" means no recorded response reported that fact.

| Emitter | Calls | Model | Input tokens | Output tokens | Cache-read | Reasoning | Tool calls | Cost |
|---|---:|---|---|---|---|---|---|---|
| OpenTelemetry openai-v2 (contrib `fba0b77`) | 124 | 115/115 | 107/111 | 83/87 | none | 0/1 | 5/17 | 79/83 |
| OpenTelemetry vertexai | 50 | 38/38 | 38/38 | 0/38 | none | 0/38 | 2/8 | none |
| OpenLLMetry OpenAI 0.62.4 | 154 | 154/154 | 125/125 | 119/119 | 6/6 | 0 -> 5/5 | 8/18 | 52/52 |
| OpenLLMetry Anthropic 0.62.4 | 84 | 56/84 | 78/84 | 42/84 | 12/12 | none | 3/9 | none |
| OpenLLMetry Bedrock | 70 | 67/70 | 19/21 | 21/21 | 1/1 | none | none | none |
| OpenLLMetry Cohere | 17 | 17/17 | 0/11 | 3/11 | none | none | 0 -> 2/2 | none |
| OpenLLMetry Google Generative AI | 2 | 2/2 | 2/2 | 0/2 | none | 0/2 | none | none |
| OpenLLMetry Groq | 9 | 9/9 | 6/6 | 6/6 | none | none | none | none |
| OpenLLMetry Mistral | 19 | 19/19 | 13/19 | 13/13 | 1/1 | none | none | none |
| OpenLLMetry OpenAI Agents | 33 | 33/33 | 33/33 | 33/33 | none | none | 18/18 | 33/33 |
| OpenInference OpenAI (`b625e5c`) | 15 | 14/14 | 14/14 | 14/14 | 5/5 | 6/6 | 1/1 | 14/14 |
| OpenInference Anthropic | 24 | 24/24 | 24/24 | 24/24 | 1/1 | none | 2/2 | 20/20 |
| OpenInference LiteLLM | 12 | 9 -> 12/12 | 11/12 | 8/9 | 1/1 | 1/1 | none | 7/7 |
| OpenInference google-genai | 21 | 21/21 | 19/19 | 21/21 | none | 9/9 | 7/7 | none |
| OpenInference Pydantic AI | 5 | 5/5 | 5/5 | 5/5 | none | none | 3/3 | 5/5 |
| OpenInference Google ADK | 20 | 20/20 | 20/20 | 20/20 | none | 5/5 | 10/10 | none |
| OpenInference Strands | 6 | 6/6 | 6/6 | 6/6 | 0/1 | none | 0 -> 2/2 | 5/6 |
| Pydantic AI, its own instrumentation, version 5 | 351 | 344/344 | 325/327 | 324/326 | 4/4 | 0 -> 78/78 | 77/77 | 133/133 |
| Vercel AI SDK 7, OpenTelemetry mode | 142 | 142/142 | 127/135 | 127/135 | 18/18 | 0/45 | 35/39 | 66/67 |
| Vercel AI SDK 7, legacy `ai.*` mode | 142 | 142/142 | 132/135 | 132/135 | 0 -> 18/18 | 0 -> 45/45 | 0 -> 37/39 | 52 -> 66/67 |
| Vercel AI SDK 6, `experimental_telemetry` | 142 | 142/142 | 132/135 | 132/135 | 0 -> 18/18 | 0 -> 44/45 | 0 -> 38/39 | 50 -> 64/67 |

Pydantic AI's instrumentation versions 2, 3, 4 and 6 were also run and are in
`results.json`; they pair the same 351 calls.

Some of what is left is the libraries'. OpenTelemetry's Vertex AI
instrumentation records an output count that is right in none of 38 calls: 34
are Gemini's count without thinking tokens and 4 differ. OpenLLMetry's
Anthropic instrumentation names no model on 28 of 84 spans. The Vercel AI SDK
in OpenTelemetry mode records no reasoning tokens where its legacy mode does.
OpenTelemetry's OpenAI instrumentation records 5 of 17 tool calls.

## What changed in tracelens

All in `src/core/normalize.ts`, source checkout, unreleased. Each is a way of
writing a fact that some library uses and tracelens did not read
([`docs/formats.md`](../../docs/formats.md) has the attribute names):

- the Vercel AI SDK's `ai.*` attributes: operation, model, usage with cached
  and reasoning tokens, messages and tool calls;
- OpenLLMetry's `llm.request.type` as the kind of call, and its indexed
  `gen_ai.prompt.N` and `gen_ai.completion.N` attributes as messages and tool
  calls;
- OpenInference's `embedding.model_name`;
- messages and system instructions carried on a span event, where Strands puts
  them, and its lists of `text`, `toolUse` and `toolResult` blocks;
- reasoning tokens where OpenLLMetry writes them (`reasoning_tokens`) and
  where Pydantic AI nests the provider's own figure
  (`gen_ai.usage.details.reasoning_tokens`, `.thoughts_tokens`).

Eight spans from these captures are test fixtures (`tests/fixtures/census/`,
with where each came from), and `tests/census.test.ts` holds the parser to
them.

## What this does not show

- **Out-of-sample coverage.** The parser was changed to read these same
  spans. The right-hand column is what it reads of what it was shown.
- **Production traces.** Test suites exercise edge cases and old API versions;
  the mix of calls is the test authors', not a deployment's.
- **Libraries that have no recorded-response tests**, and the ones not tried:
  Langfuse, Logfire's own exporter, LangSmith, Semantic Kernel, Spring AI.
- **Calls that could not be paired.** OpenLLMetry's OpenAI suite has 437
  recorded calls and 154 are paired; Groq's has 39 and 9 are.
- **Who is wrong about a token count.** Where the figure shown differs from the
  response, the span was not inspected call by call.
- **Rendering.** What tracelens "shows" is what its normalised model holds, as
  the CLI reads it; the browser view was not exercised.

## Reproduce

```sh
git clone https://github.com/antonsoo/tracelens && cd tracelens && npm ci
studies/instrumentation-census/capture/run-all.sh /tmp/census   # about 3 GB of environments
studies/instrumentation-census/analyze.sh /tmp/census          # results.json, tables on stdout
```

`analyze.sh` builds 0.3.3 from its tag in a worktree under the work directory
and this checkout beside it. Library dependencies that the libraries do not pin
resolve to the newest release on the day, so a later run can differ;
[`results.json`](results.json) records each library's version.

## Sources and licences

The spans are the output of the libraries above run on their own recorded
responses; the libraries and their fixtures are Apache-2.0, and Pydantic AI is
MIT. Captured spans are not committed, apart from the eight fixtures, each
trimmed to one trace and credited in `tests/fixtures/census/README.md`.
