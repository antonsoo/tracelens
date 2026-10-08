"""Cut the regression fixtures in tests/fixtures/census/ out of the captured spans.

    python3 -I make-fixtures.py <work-dir> <tests/fixtures/census>

Each fixture is the spans of one captured test as one OTLP/JSON export. The only change is that
attributes holding an embedding vector (`...embedding.vector`) are dropped to keep the file small. See
studies/instrumentation-census/README.md for where each came from and under which licence.
"""
import json
import os
import sys

CASES = {
    "vercel-ai-sdk-6-openai-responses-stream.json": ("aisdk-v6", "openai/src/responses::openai-code-interpreter-tool.1.chunks.txt"),
    "vercel-ai-sdk-6-deepseek-tool-call.json": ("aisdk-v6", "deepseek/src/chat::deepseek-tool-call.json"),
    "openllmetry-cohere-legacy-tool-calls.json": ("llm-cohere", "tests/test_chat.py::test_cohere_v2_chat_legacy_with_tool_calls_and_history"),
    "openllmetry-mistral-embeddings-legacy.json": ("llm-mistral", "tests/test_embeddings.py::test_mistral_embeddings_legacy"),
    "openllmetry-openai-reasoning.json": ("llm-openai", "tests/traces/test_chat.py::test_chat_reasoning"),
    "strands-legacy-events-tool-call.json": ("oi-strands", "tests/test_live_agent.py::test_agent_with_system_prompt_and_tool[legacy]"),
    "strands-operation-details-events-tool-call.json": ("oi-strands", "tests/test_live_agent.py::test_agent_with_system_prompt_and_tool[latest]"),
    "openinference-litellm-embedding.json": ("oi-litellm", "tests/test_embeddings.py::test_single_string_embedding"),
}


def main():
    work, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    for name, (label, test) in CASES.items():
        resource_spans = []
        for line in open(os.path.join(work, "out", label + ".jsonl")):
            row = json.loads(line)
            if row["test"] == test:
                resource_spans.extend(row["doc"]["resourceSpans"])
        if not resource_spans:
            raise SystemExit(f"no spans for {label} {test}")
        for rs in resource_spans:
            for ss in rs["scopeSpans"]:
                for span in ss["spans"]:
                    span["attributes"] = [a for a in span.get("attributes", []) if not a["key"].endswith("embedding.vector")]
        with open(os.path.join(out_dir, name), "w") as fh:
            json.dump({"resourceSpans": resource_spans}, fh, indent=1, sort_keys=False)
            fh.write("\n")
        print(name, sum(len(ss["spans"]) for rs in resource_spans for ss in rs["scopeSpans"]), "spans")


if __name__ == "__main__":
    main()
