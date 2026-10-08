# Census fixtures

Spans exported by instrumentation libraries while their own test suites, or the Vercel AI SDK
pointed at a local replay server, played back responses recorded from real providers. Nothing was
written by hand and no model was called. They are cut out by
`studies/instrumentation-census/make-fixtures.py` from the captures that
`studies/instrumentation-census/capture/run-all.sh` writes; the study README says how the captures
were made and what was measured with them. The one edit is that attributes holding an embedding
vector are dropped to keep the files small.

| File | Library, at the commit read | Test it came from | Recorded response it replays |
|---|---|---|---|
| `vercel-ai-sdk-6-openai-responses-stream.json` | `ai` 6.0.302, `experimental_telemetry` | `packages/openai/src/responses/__fixtures__/openai-code-interpreter-tool.1.chunks.txt` in vercel/ai at 5028fa4 | an OpenAI Responses stream |
| `vercel-ai-sdk-6-deepseek-tool-call.json` | `ai` 6.0.302 | `packages/deepseek/src/chat/__fixtures__/deepseek-tool-call.json` | a DeepSeek chat completion |
| `openllmetry-cohere-legacy-tool-calls.json` | OpenLLMetry `opentelemetry-instrumentation-cohere` 0.62.4, traceloop/openllmetry at df4921a | `tests/test_chat.py::test_cohere_v2_chat_legacy_with_tool_calls_and_history` | a Cohere v2 chat |
| `openllmetry-mistral-embeddings-legacy.json` | `opentelemetry-instrumentation-mistralai` 0.62.4 | `tests/test_embeddings.py::test_mistral_embeddings_legacy` | a Mistral embeddings call |
| `openllmetry-openai-reasoning.json` | `opentelemetry-instrumentation-openai` 0.62.4 | `tests/traces/test_chat.py::test_chat_reasoning` | an OpenAI chat completion (gpt-5-nano) |
| `strands-legacy-events-tool-call.json`, `strands-operation-details-events-tool-call.json` | Strands Agents 1.19.0 (its own tracing), Arize-ai/openinference at b625e5c | `openinference-instrumentation-strands-agents/tests/test_live_agent.py::test_agent_with_system_prompt_and_tool[legacy]` and `[latest]` | an OpenAI chat completion with a tool call |
| `openinference-litellm-embedding.json` | `openinference-instrumentation-litellm`, Arize-ai/openinference at b625e5c | `tests/test_embeddings.py::test_single_string_embedding` | an OpenAI embeddings call through LiteLLM |

Licences: the Vercel AI SDK, OpenLLMetry, OpenInference and Strands are Apache-2.0; the spans carry
the short prompts and answers of their tests and the model names the providers returned. The
Apache-2.0 text is the `LICENSE` file at the root of each of those repositories (`LICENSE.APACHE` in Strands).
