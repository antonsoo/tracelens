"""Score what tracelens shows for each model call against what the provider's response said.

    python3 -I score.py <work-dir> <out-results.json>

<work-dir> holds src/ (the unpacked repositories), out/*.jsonl (captured spans, from capture/run.sh)
and res/tl-<version>.json (from read-with-tracelens.mjs, one per tracelens build).

Pairing. A test replays one cassette. The model calls in it are the recorded POSTs to a model
endpoint (yardstick.py). The spans that stand for model calls are chosen by the emitter's own
declaration, not by tracelens: gen_ai.operation.name is a model operation, or
openinference.span.kind is LLM or EMBEDDING, or llm.request.type is set. Calls and spans are paired
in start order, and only in tests where the two counts are equal; the rest are counted and left out
of the per-field figures.
"""
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yardstick  # noqa: E402

MODEL_OPS = {"chat", "text_completion", "generate_content", "embeddings", "embedding", "completion"}
OI_KINDS = {"LLM", "EMBEDDING"}

# label -> (package directory under src/, human name, version string)
EMITTERS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "emitters.json")))


def attr_value(v):
    for key in ("stringValue", "intValue", "doubleValue", "boolValue"):
        if key in v:
            return int(v[key]) if key == "intValue" else v[key]
    return v


def raw_spans(doc_rows):
    """Flat raw spans from captured batches: {span, attrs}."""
    out = []
    for row in doc_rows:
        for rs in row["doc"]["resourceSpans"]:
            for ss in rs["scopeSpans"]:
                for sp in ss["spans"]:
                    out.append({"span": sp, "attrs": {a["key"]: attr_value(a["value"]) for a in sp.get("attributes", [])}})
    return out


AI_SDK_MODEL_OPS = {"ai.generateText.doGenerate", "ai.streamText.doStream", "ai.generateObject.doGenerate", "ai.streamObject.doStream", "ai.embed.doEmbed", "ai.embedMany.doEmbed"}


def declared_model_call(attrs):
    return (
        attrs.get("ai.operationId") in AI_SDK_MODEL_OPS or
        attrs.get("gen_ai.operation.name") in MODEL_OPS
        or attrs.get("openinference.span.kind") in OI_KINDS
        or "llm.request.type" in attrs
    )


def expected_cost(call, table):
    """Price of the call from the provider's own numbers, with the same table tracelens ships."""
    model = (call["model"] or call.get("request_model") or "").lower()
    best = None
    for e in table:
        n = e["matchModel"].strip().lower()
        if n in model and (best is None or len(n) > len(best["matchModel"].strip())):
            best = e
    if best is None or call["raw_input"] is None or call["output"] is None:
        return None
    cr, cw = call["cache_read"] or 0, call["cache_write"] or 0
    if call["api"].startswith("anthropic"):  # input_tokens excludes the cache counts
        plain = call["raw_input"]
    else:  # OpenAI and Gemini count cached tokens inside the prompt tokens
        plain = call["input_total"] - cr - cw
    if plain < 0:
        return None
    return (
        plain / 1e6 * best["inputPerMTok"]
        + call["output"] / 1e6 * best["outputPerMTok"]
        + cr / 1e6 * (best.get("cacheReadPerMTok") or best["inputPerMTok"])
        + cw / 1e6 * (best.get("cacheWritePerMTok") or best["inputPerMTok"])
    )


def close(a, b):
    return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))


def family(version_name):
    return version_name


def carried(raw, kind, want, key_hint=None):
    """Does the raw span hold this fact at all, whatever the attribute is called?

    A number must be the value of an attribute whose name mentions tokens or usage. A string must
    be a whole attribute value (or an element of a JSON list, or the `name` of a JSON object) of an
    attribute, or of a span event attribute; when key_hint is given the attribute name must contain it.
    """
    span, attrs = raw["span"], raw["attrs"]
    if kind == "number":
        return any(isinstance(v, int) and not isinstance(v, bool) and v == want and any(w in k for w in ("token", "usage")) for k, v in attrs.items())
    pairs = list(attrs.items())
    for ev in span.get("events", []):
        pairs += [(a["key"], attr_value(a["value"])) for a in ev.get("attributes", [])]
    for k, v in pairs:
        if key_hint and key_hint not in k:
            continue
        if v == want:
            return True
        if isinstance(v, str) and (f'"name": "{want}"' in v or f'"name":"{want}"' in v or f'"{want}"' in v):
            return True
        if isinstance(v, dict) and want in json.dumps(v):  # an array attribute, as OTLP JSON writes it
            return want in [x.get("stringValue") for x in v.get("values", [])] if "values" in v else False
    return False


VENDORS = r"^(?:(?:us|eu|apac|global|anthropic|ai21|amazon|meta|cohere|mistral|openai|google|deepseek|writer|azure)[./])+"


def canon(model):
    return re.sub(VENDORS, "", (model or "").lower().rsplit("/", 1)[-1])


def score_pair(call, raw, tl, table):
    """Per-field verdicts for one model call and the span tracelens made of it."""
    usage = (tl or {}).get("usage") or {}
    ok_call = call["status"] is not None and call["status"] < 400
    verdict = {}

    # (a) recognised as a model call
    want_kind = "embedding" if call["api"].endswith("embeddings") else "llm"
    verdict["recognised"] = "ok" if tl and tl["agentKind"] == want_kind else ("kind:" + (tl["agentKind"] if tl else "absent"))
    if not ok_call:
        return verdict  # an error response carries no model, usage or tools to compare

    # (b) model
    shown = (tl["responseModel"] or tl["requestModel"]) if tl else None
    api_model = call["model"] or call.get("request_model")
    if not shown:
        verdict["model"] = "missing"
    elif shown == api_model:
        verdict["model"] = "ok"
    elif api_model and (canon(api_model).startswith(canon(shown)) or canon(shown).startswith(canon(api_model))):
        verdict["model"] = "alias"  # the name the caller used, or a vendor prefix dropped or added, for the API's snapshot
    else:
        verdict["model"] = "wrong"

    # (c) tokens, each against what the API reported
    diffs = verdict.setdefault("_diffs", {})

    def field(name, shown_value, want, also_ok=()):
        if want is None or (name in ("cache_read", "cache_write", "reasoning") and not want):
            verdict[name] = "n/a" if shown_value in (None, 0) or want is None else "extra"
            return
        if shown_value is None:
            verdict[name] = "missing"
        elif shown_value == want:
            verdict[name] = "ok"
        elif shown_value in also_ok:
            verdict[name] = "raw"  # the API's own un-summed figure
        else:
            verdict[name] = "wrong"
            if isinstance(shown_value, (int, float)):
                diffs[name] = shown_value - want

    if call.get("unparsed") or call.get("unscored_usage") or (call["stream"] and call["input_total"] is None and call["output"] is None):
        for n in ("input", "output", "cache_read", "cache_write", "reasoning"):
            verdict[n] = "n/a"
    else:
        field("input", usage.get("inputTokens"), call["input_total"], also_ok=(call["raw_input"], call.get("alt_input")))
        field("output", usage.get("outputTokens"), call["output"], also_ok=(call["raw_output"], call.get("alt_output")))
        field("cache_read", usage.get("cacheReadTokens"), call["cache_read"])
        field("cache_write", usage.get("cacheWriteTokens"), call["cache_write"])
        field("reasoning", usage.get("reasoningOutputTokens"), call["reasoning"])

    # (d) tool calls: every tool the response called is shown, by name. Names shown beyond those
    # (a provider-run tool, an MCP server) are counted separately and are not an error.
    want_tools = sorted(t for t in call["tools"] if t)
    got_tools = sorted(tl["toolCalls"]) if tl else []
    left = list(got_tools)
    for name in want_tools:
        if name in left:
            left.remove(name)
    if not want_tools:
        verdict["tools"] = "n/a"
        verdict["tools_extra"] = "extra" if got_tools else "n/a"
    elif len(left) == len(got_tools) - len(want_tools):
        verdict["tools"] = "ok"
        verdict["tools_extra"] = "extra" if left else "n/a"
    elif not got_tools:
        verdict["tools"] = "missing"
    else:
        verdict["tools"] = "wrong"

    # (e) estimated cost
    want_cost = None if call.get("unscored_usage") or call.get("unparsed") else expected_cost(call, table)
    got_cost = tl["costUsd"] if tl else None
    if want_cost is None and got_cost is None:
        verdict["cost"] = "n/a"  # no price in the table, or nothing to price
    elif want_cost is None:
        verdict["cost"] = "unpriced-by-yardstick"
    elif got_cost is None:
        verdict["cost"] = "missing"
    elif close(got_cost, want_cost):
        verdict["cost"] = "ok"
    else:
        verdict["cost"] = "wrong"
    verdict["_cost_pair"] = [want_cost, got_cost]

    # finish reason: present or not (the vocabularies differ between emitters, see the dialect table)
    if call["finish"]:
        verdict["finish"] = "ok" if tl and tl["finishReasons"] else "missing"
    else:
        verdict["finish"] = "n/a"

    # A missing fact is the emitter's if its span does not hold it at all, and tracelens's if it does.
    wants = {
        "model": ("text", api_model), "input": ("number", call["input_total"]), "output": ("number", call["output"]),
        "cache_read": ("number", call["cache_read"]), "reasoning": ("number", call["reasoning"]),
        "tools": ("text", want_tools[0] if want_tools else None),
        "finish": ("text", call["finish"][0] if call["finish"] else None),
    }
    for name, (kind, want) in wants.items():
        if verdict.get(name) == "missing":
            if want is None or not carried(raw, kind, want, "finish" if name == "finish" else None):
                verdict[name] = "missing:not-in-span"
            else:
                verdict[name] = "missing:in-span"
    # No cost without token counts: if the span never held them, the cost is missing for the emitter's reason
    if verdict.get("cost") == "missing" and "missing:not-in-span" in (verdict.get("input"), verdict.get("output")):
        verdict["cost"] = "missing:not-in-span"
    return verdict


def main():
    work, out_path = sys.argv[1], sys.argv[2]
    tl_versions = {}
    for name in sorted(os.listdir(os.path.join(work, "res"))):
        if name.startswith("tl-") and name.endswith(".json"):
            tl_versions[name[3:-5]] = json.load(open(os.path.join(work, "res", name)))
    table = next(iter(tl_versions.values()))["priceTable"]
    for data in tl_versions.values():  # index the groups once: (emitter, test) -> group
        data["by_key"] = {(g["emitter"], g["test"]): g for g in data["groups"]}

    results = {"emitters": {}, "price_table_entries": len(table)}
    for label, cfg in EMITTERS.items():
        path = os.path.join(work, "out", label + ".jsonl")
        if not os.path.exists(path):
            continue
        rows = [json.loads(line) for line in open(path)]
        by_test = collections.defaultdict(list)
        for r in rows:
            by_test[r["test"]].append(r)
        raws_by_test = {test: raw_spans(batch) for test, batch in by_test.items()}
        pkg = os.path.join(work, "src", cfg["package"])
        index = {} if cfg.get("fixtures") else yardstick.index_cassettes(pkg)

        summary = {
            "tests_with_spans": len(by_test), "tests_with_cassette": 0, "tests_paired": 0,
            "calls": 0, "calls_ok_status": 0, "paired_calls": 0, "unpaired_calls": 0,
            "declared_spans": 0, "unpaired_tests": [], "versions": {},
        }
        per_version = {v: collections.defaultdict(collections.Counter) for v in tl_versions}
        crashes = {v: 0 for v in tl_versions}
        nesting = {v: collections.Counter() for v in tl_versions}
        examples = {v: collections.defaultdict(list) for v in tl_versions}
        diffs = {v: collections.defaultdict(collections.Counter) for v in tl_versions}  # field -> shown minus reported -> calls
        diffs_streamed = {v: collections.Counter() for v in tl_versions}
        for test, batch in by_test.items():
            if cfg.get("fixtures"):
                calls = yardstick.read_fixture(pkg, test)
                summary["tests_with_cassette"] += 1
            else:
                cassette = yardstick.cassette_for_test(index, test)
                if cassette is None:
                    continue
                summary["tests_with_cassette"] += 1
                calls = yardstick.read_cassette(cassette)
            if not calls:
                continue
            raws = sorted(raws_by_test[test], key=lambda r: int(r["span"]["startTimeUnixNano"]))
            present = {(r["span"]["traceId"], r["span"]["spanId"]) for r in raws}
            declared = [r for r in raws if declared_model_call(r["attrs"])]
            summary["calls"] += len(calls)
            summary["calls_ok_status"] += sum(1 for c in calls if c["status"] is not None and c["status"] < 400)
            summary["declared_spans"] += len(declared)
            # A cassette can hold exchanges its test never replays. A span that names the response
            # it saw (gen_ai.response.id) is paired with the exchange carrying that id; otherwise
            # the test counts only when calls and spans are equal in number and are paired in order.
            by_id = {c["id"]: c for c in calls if c["id"]}
            ids = [r["attrs"].get("gen_ai.response.id") for r in declared]
            if declared and all(i in by_id for i in ids):
                pairs = [(by_id[i], r) for i, r in zip(ids, declared)]
                summary["paired_by_id"] = summary.get("paired_by_id", 0) + len(pairs)
            elif len(calls) == len(declared):
                pairs = list(zip(calls, declared))
            else:
                summary["unpaired_calls"] += len(calls)
                summary["unpaired_tests"].append({"test": test, "calls": len(calls), "spans": len(declared)})
                continue
            summary["tests_paired"] += 1
            summary["paired_calls"] += len(pairs)
            for v, data in tl_versions.items():
                g = data["by_key"].get((label, test))
                if g and g["crash"]:
                    crashes[v] += 1
                tl_by_id = {(s["traceId"], s["spanId"]): s for s in (g["spans"] if g else [])}
                for call, raw in pairs:
                    sp = raw["span"]
                    tl = tl_by_id.get((sp["traceId"], sp["spanId"]))
                    verdict = score_pair(call, raw, tl, table)
                    for name, delta in verdict.get("_diffs", {}).items():
                        diffs[v][name][delta] += 1
                        diffs_streamed[v][name] += 1 if call["stream"] else 0
                    for k, val in verdict.items():
                        if not k.startswith("_"):
                            per_version[v][k][val] += 1
                            if val not in ("ok", "n/a") and len(examples[v][k]) < 6:
                                examples[v][k].append({"test": test.split("::", 1)[-1], "verdict": val, "api": {x: call[x] for x in ("model", "input_total", "raw_input", "output", "cache_read", "reasoning", "tools", "finish")}, "tl": None if not tl else {x: tl[x] for x in ("agentKind", "requestModel", "responseModel", "usage", "toolCalls", "finishReasons", "costUsd")}})
                    # (f) nesting: the viewer puts the span under the parent the export names
                    want_parent = sp.get("parentSpanId") or None
                    if want_parent and (sp["traceId"], want_parent) not in present:
                        want_parent = None  # the parent was never exported, so the span is a root
                    if tl is None:
                        nesting[v]["absent"] += 1
                    elif want_parent is None:
                        nesting[v]["ok" if tl["isRoot"] else "wrong"] += 1
                    else:
                        nesting[v]["ok" if tl["parentShown"] == want_parent else "wrong"] += 1
        # Every model-call span the emitter declares, in every captured test (not only the paired ones)
        for v, data in tl_versions.items():
            seen, recognised, crashed, warned = 0, collections.Counter(), 0, 0
            for test, batch in by_test.items():
                g = data["by_key"].get((label, test))
                crashed += 1 if g and g["crash"] else 0
                warned += 1 if g and any(sp["warnings"] for sp in g["spans"]) else 0
                tl_by_id = {(sp["traceId"], sp["spanId"]): sp for sp in (g["spans"] if g else [])}
                for raw in raws_by_test[test]:
                    if not declared_model_call(raw["attrs"]):
                        continue
                    a = raw["attrs"]
                    want = "reranker" if a.get("llm.request.type") == "rerank" else "embedding" if (
                        str(a.get("gen_ai.operation.name", "")).startswith("embed") or a.get("openinference.span.kind") == "EMBEDDING"
                        or a.get("llm.request.type") == "embedding" or str(a.get("ai.operationId", "")).endswith("doEmbed")
                    ) else "llm"
                    tl = tl_by_id.get((raw["span"]["traceId"], raw["span"]["spanId"]))
                    seen += 1
                    recognised["ok" if tl and tl["agentKind"] == want else "kind:" + (tl["agentKind"] if tl else "absent")] += 1
            summary.setdefault("all_declared", {})[v] = {"spans": seen, "recognised": dict(recognised), "groups_crashed": crashed, "groups_with_warnings": warned, "groups": len(by_test)}
        for v in tl_versions:
            summary["versions"][v] = {
                "fields": {k: dict(c) for k, c in per_version[v].items()},
                "nesting": dict(nesting[v]),
                "crashes": crashes[v],
                "value_differences": {name: {str(d): n for d, n in sorted(c.items())} for name, c in diffs[v].items()},
                "value_differences_in_streamed_calls": dict(diffs_streamed[v]),
                "examples": {k: val for k, val in examples[v].items()},
            }
        summary["name"] = cfg["name"]
        summary["version"] = cfg["version"]
        results["emitters"][label] = summary
    json.dump(results, open(out_path, "w"), indent=1)
    for label, s in results["emitters"].items():
        print(label, {k: s[k] for k in ("tests_with_spans", "tests_with_cassette", "tests_paired", "calls", "paired_calls", "declared_spans")})
        for v, vv in s["versions"].items():
            print("  ", v, {k: dict(c) for k, c in vv["fields"].items() if k in ("recognised", "model", "input", "output", "cost", "tools")})


if __name__ == "__main__":
    main()
