"""Which attribute names does each emitter put on its model-call spans?

    python3 -I dialects.py <work-dir> <out.json>

For every captured span an emitter declares to be a model call (see score.declared_model_call),
count the attribute keys it carries, with list indexes folded to N (`gen_ai.prompt.0.role` ->
`gen_ai.prompt.N.role`). Also lists the span events by name and the attribute keys tracelens
reads, so keys that carry a fact but are not read can be seen.
"""
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score  # noqa: E402


FACTS = {
    "kind of call": ["gen_ai.operation.name", "openinference.span.kind", "llm.request.type", "ai.operationId"],
    "provider": ["gen_ai.provider.name", "gen_ai.system", "llm.provider", "llm.system", "ai.model.provider"],
    "request model": ["gen_ai.request.model", "llm.model_name", "embedding.model_name", "ai.model.id"],
    "response model": ["gen_ai.response.model", "llm.response.model_name", "ai.response.model"],
    "input tokens": ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "llm.token_count.prompt", "ai.usage.inputTokens", "ai.usage.promptTokens"],
    "output tokens": ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "llm.token_count.completion", "ai.usage.outputTokens", "ai.usage.completionTokens"],
    "cache read": [
        "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_input_tokens", "gen_ai.usage.details.cache_read_input_tokens",
        "llm.token_count.prompt_details.cache_read", "ai.usage.cachedInputTokens", "ai.usage.inputTokenDetails.cacheReadTokens",
    ],
    "cache write": [
        "gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.cache_creation_input_tokens", "gen_ai.usage.cache_write_input_tokens",
        "llm.token_count.prompt_details.cache_write", "ai.usage.inputTokenDetails.cacheWriteTokens",
    ],
    "reasoning tokens": [
        "gen_ai.usage.reasoning.output_tokens", "gen_ai.usage.reasoning_tokens", "gen_ai.usage.details.reasoning_tokens",
        "gen_ai.usage.details.thoughts_tokens", "llm.token_count.completion_details.reasoning", "ai.usage.reasoningTokens",
    ],
    "finish reason": ["gen_ai.response.finish_reasons", "llm.finish_reason", "ai.response.finishReason", "gen_ai.completion.N.finish_reason"],
    "messages": [
        "gen_ai.input.messages", "gen_ai.output.messages", "llm.input_messages.N.message.role", "llm.output_messages.N.message.role",
        "gen_ai.prompt.N.role", "gen_ai.completion.N.role", "ai.prompt.messages", "ai.response.text", "input.value", "output.value",
    ],
    "tool calls in the reply": [
        "llm.output_messages.N.message.tool_calls.N.tool_call.function.name", "llm.output_messages.N.message.contents.N.tool_call.function.name",
        "gen_ai.completion.N.tool_calls.N.name", "ai.response.toolCalls",
    ],
    "cost the emitter computed": ["operation.cost", "llm.cost.total"],
}


def fact_table(result):
    """For each emitter and fact, the candidate keys found on its model-call spans and how many carry each."""
    table = {}
    for label, r in result.items():
        n = r["model_call_spans"]
        row = {}
        for fact, keys in FACTS.items():
            found = {k: r["keys"][k] for k in keys if k in r["keys"]}
            row[fact] = found
        table[label] = {"spans": n, "facts": row}
    return table


def main():
    work, out_path = sys.argv[1], sys.argv[2]
    result = {}
    for label in score.EMITTERS:
        path = os.path.join(work, "out", label + ".jsonl")
        if not os.path.exists(path):
            continue
        keys, events, scopes, n = collections.Counter(), collections.Counter(), collections.Counter(), 0
        for line in open(path):
            row = json.loads(line)
            for raw in score.raw_spans([row]):
                if not score.declared_model_call(raw["attrs"]):
                    continue
                n += 1
                for k in raw["attrs"]:
                    keys[re.sub(r"\.\d+(?=\.|$)", ".N", k)] += 1
                for ev in raw["span"].get("events", []):
                    events[ev["name"]] += 1
        for line in open(path):
            row = json.loads(line)
            for rs in row["doc"]["resourceSpans"]:
                for ss in rs["scopeSpans"]:
                    scopes[(ss["scope"].get("name"), ss["scope"].get("version"))] += 1
        result[label] = {
            "model_call_spans": n, "keys": dict(keys.most_common()), "events": dict(events),
            "scopes": [{"name": k[0], "version": k[1], "spans": v} for k, v in scopes.most_common(6)],
        }
    for label, entry in fact_table(result).items():
        result[label]["fact_keys"] = entry["facts"]
    json.dump(result, open(out_path, "w"), indent=1)
    for label, r in result.items():
        print(label, r["model_call_spans"], "spans,", len(r["keys"]), "keys, events:", r["events"])


if __name__ == "__main__":
    main()
