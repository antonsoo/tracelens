"""Join the scoring and the dialect tables into results.json and print the README tables.

    python3 -I summarize.py <score.json> <dialects.json> <results.json> [--markdown]

A call is counted for a field only where the recorded response reported that fact (an embedding
call has no output tokens, a reply with no tool call has no tool calls to show). "Right" is the
verdict ok, or alias for the model; "emitter left it out" is missing:not-in-span; "tracelens left
it out" is missing:in-span (the span held the fact and tracelens did not show it); "wrong" is a
value that differs from the response; other_figure is a value that is a different figure the
response also reported for the same thing (Anthropic's un-summed input count, Gemini's output
count without thinking tokens, Cohere's billed units).
"""
import collections
import json
import sys

BEFORE, AFTER = "v0.3.3", "checkout"
SKIP_IN_TOTALS = {"pai-v2", "pai-v3", "pai-v4", "pai-v6"}  # identical to pai-v5 on every field scored here
FIELDS = ["recognised", "model", "input", "output", "cache_read", "reasoning", "tools", "cost"]
LABEL = {
    "recognised": "model call recognised",
    "model": "model",
    "input": "input tokens",
    "output": "output tokens",
    "cache_read": "cache-read tokens",
    "reasoning": "reasoning tokens",
    "tools": "tool calls",
    "cost": "cost",
}


def classify(verdicts):
    """Collapse verdict counts to right / wrong / emitter / tracelens / not-applicable."""
    out = collections.Counter()
    for verdict, n in verdicts.items():
        if verdict in ("ok", "alias"):
            out["right"] += n
        elif verdict in ("n/a", "unpriced-by-yardstick"):
            out["na"] += n
        elif verdict == "missing:not-in-span":
            out["emitter_omits"] += n
        elif verdict in ("missing:in-span", "missing") or verdict.startswith("kind:"):
            out["tracelens_misses"] += n
        elif verdict == "raw":
            out["other_figure"] += n
        else:  # wrong
            out["wrong"] += n
    return out


def field_counts(summary, version, field):
    c = classify(summary["versions"][version]["fields"].get(field, {}))
    return {k: c.get(k, 0) for k in ("right", "wrong", "other_figure", "emitter_omits", "tracelens_misses", "na")}


def main():
    score_path, dialects_path, out_path = sys.argv[1:4]
    score = json.load(open(score_path))
    dialects = json.load(open(dialects_path))
    emitters = score["emitters"]

    headline = {}
    for version in (BEFORE, AFTER):
        per_field = {}
        for field in FIELDS:
            total = collections.Counter()
            for label, s in emitters.items():
                if label in SKIP_IN_TOTALS:
                    continue
                total.update(field_counts(s, version, field))
            per_field[field] = dict(total)
        headline[version] = per_field

    recognition = {}
    for version in (BEFORE, AFTER):
        spans = ok = 0
        for label, s in emitters.items():
            if label in SKIP_IN_TOTALS:
                continue
            d = s["all_declared"][version]
            spans += d["spans"]
            ok += d["recognised"].get("ok", 0)
        recognition[version] = {"declared_model_call_spans": spans, "recognised": ok}

    totals = {
        "emitter_runs": sum(1 for l in emitters if l not in SKIP_IN_TOTALS),
        "groups_read": {v: sum(s["all_declared"][v]["groups"] for l, s in emitters.items()) for v in (BEFORE, AFTER)},
        "groups_crashed": {v: sum(s["all_declared"][v]["groups_crashed"] for s in emitters.values()) for v in (BEFORE, AFTER)},
        "paired_calls": sum(s["paired_calls"] for l, s in emitters.items() if l not in SKIP_IN_TOTALS),
        "nesting": {
            v: dict(sum((collections.Counter(s["versions"][v]["nesting"]) for s in emitters.values()), collections.Counter()))
            for v in (BEFORE, AFTER)
        },
    }

    # The names a fact is written under, over all emitters: the number of dialects for one fact
    names = {}
    for label, d in dialects.items():
        if label in SKIP_IN_TOTALS:
            continue
        for fact, keys in d["fact_keys"].items():
            for key, n in keys.items():
                names.setdefault(fact, {}).setdefault(key, []).append(label)
    totals["fact_names"] = {fact: sorted(keys) for fact, keys in names.items()}
    totals["nesting_primary"] = {
        v: dict(sum((collections.Counter(s["versions"][v]["nesting"]) for l, s in emitters.items() if l not in SKIP_IN_TOTALS), collections.Counter()))
        for v in (BEFORE, AFTER)
    }
    totals["calls_in_cassettes_of_paired_tests"] = sum(s["calls"] for l, s in emitters.items() if l not in SKIP_IN_TOTALS)

    rows = {}
    for label, s in emitters.items():
        rows[label] = {
            "name": s["name"], "version": s["version"], "paired_calls": s["paired_calls"], "calls_in_cassettes": s["calls"],
            "tests_with_spans": s["tests_with_spans"], "tests_paired": s["tests_paired"],
            "declared_spans": s["declared_spans"],
            "fields": {v: {f: field_counts(s, v, f) for f in FIELDS} for v in (BEFORE, AFTER)},
            "verdicts": {v: s["versions"][v]["fields"] for v in (BEFORE, AFTER)},
            "all_declared": s["all_declared"],
            "nesting": {v: s["versions"][v]["nesting"] for v in (BEFORE, AFTER)},
            "value_differences": {v: s["versions"][v]["value_differences"] for v in (BEFORE, AFTER)},
            "value_differences_in_streamed_calls": {v: s["versions"][v]["value_differences_in_streamed_calls"] for v in (BEFORE, AFTER)},
            "examples": {k: v for k, v in s["versions"][AFTER]["examples"].items()},
            "unpaired_tests": s["unpaired_tests"][:20],
            "dialect": {"model_call_spans": dialects[label]["model_call_spans"], "fact_keys": dialects[label]["fact_keys"], "events": dialects[label]["events"], "scopes": dialects[label]["scopes"]},
        }

    results = {
        "tracelens": {"before": "v0.3.3 (tag, as published)", "after": "this checkout, with the parser changes of this study"},
        "headline": headline,
        "recognition": recognition,
        "totals": totals,
        "emitters": rows,
    }
    json.dump(results, open(out_path, "w"), indent=1)

    if "--markdown" in sys.argv:
        print("| emitter | calls |" + "".join(f" {LABEL[f]} |" for f in FIELDS[1:]))
        print("|---|---:|" + "---|" * (len(FIELDS) - 1))
        for label, r in rows.items():
            if label in SKIP_IN_TOTALS:
                continue
            cells = []
            for f in FIELDS[1:]:
                b, a = r["fields"][BEFORE][f], r["fields"][AFTER][f]
                nb, na = (sum(v for k, v in c.items() if k != "na") for c in (b, a))
                cells.append("none" if na == 0 else (f"{a['right']}/{na}" if b["right"] == a["right"] else f"{b['right']} -> {a['right']}/{na}"))
            print(f"| {r['name']} | {r['paired_calls']} | " + " | ".join(cells) + " |")
        print()
        for version in (BEFORE, AFTER):
            print(version, json.dumps(headline[version]))
        print(json.dumps(recognition), json.dumps(totals))


if __name__ == "__main__":
    main()
