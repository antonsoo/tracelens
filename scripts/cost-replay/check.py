"""Check the captured token charge against a pinned response and quoted rates.

python3 check.py response.chunks.txt cost.json docs/cost-evidence/before.json
Uses Decimal and raw provider fields; does not import TraceLens or its matcher.
"""
import hashlib
import json
import sys
from decimal import Decimal
from pathlib import Path

fixture, report_path, before_path = map(Path, sys.argv[1:])
raw = fixture.read_bytes()
assert hashlib.sha256(raw).hexdigest() == "2907e69401c95a1c32bf495032c0bb4916a41b80d4a8cd49cbf97b2570633d84"
response = [json.loads(line)["response"] for line in raw.splitlines()
            if line.strip() and json.loads(line)["type"] == "response.completed"][-1]
assert response["model"] == "gpt-5-nano-2025-08-07"
usage = response["usage"]
cached = usage["input_tokens_details"]["cached_tokens"]
fresh = usage["input_tokens"] - cached
output = usage["output_tokens"]  # reasoning is already included

# Quoted from the model page on 2026-10-09 UTC, not inferred from its name.
rates = {"input": Decimal("0.05"), "cache_read": Decimal("0.005"), "output": Decimal("0.40")}
parts = {
    "fresh_input": fresh * rates["input"] / 1_000_000,
    "cache_read": cached * rates["cache_read"] / 1_000_000,
    "output": output * rates["output"] / 1_000_000,
}
expected = sum(parts.values())
report = json.loads(report_path.read_text(), parse_float=Decimal)
assert (report["pricedCalls"], report["unpricedCalls"], report["excludedSpans"]) == (1, 0, 1)
call = next(row for row in report["rows"] if row["result"]["status"] == "priced")
assert call["responseModel"] == response["model"]
assert call["usage"]["reasoningOutputTokens"] == usage["output_tokens_details"]["reasoning_tokens"]
assert [part["tokens"] for part in call["result"]["components"]] == [fresh, cached, 0, output]
for actual in [call["result"]["costUsd"], report["knownCostUsd"], report["estimatedCostUsd"]]:
    assert abs(actual - expected) < Decimal("1e-18"), (actual, expected)

before = json.loads(before_path.read_text(), parse_float=Decimal)
legacy = next(row for row in before["records"] if row["file"] == "vercel-ai-sdk-6-openai-responses-stream.json")
assert legacy["spans"][0]["usage"]["inputTokens"] == usage["input_tokens"]
assert legacy["spans"][0]["usage"]["outputTokens"] == output
assert legacy["spans"][0]["usage"]["cacheReadTokens"] == cached
factor = (legacy["summary"]["costUsd"] / expected).quantize(Decimal("0.00000001")).normalize()
print(json.dumps({
    "arithmetic": "Python decimal.Decimal; source response counts, not normalized span counts",
    "rates_source": "https://developers.openai.com/api/docs/models/gpt-5-nano",
    "rates_checked_utc": "2026-10-09",
    "usd_per_million": {key: str(value) for key, value in rates.items()},
    "components_usd": {key: str(value) for key, value in parts.items()},
    "expected_token_cost_usd": str(expected),
    "cli_token_cost_usd": str(report["estimatedCostUsd"]),
    "before_token_cost_usd": str(legacy["summary"]["costUsd"]),
    "before_overestimate_factor_rounded": str(factor),
    "result": "matched",
    "scope": "Token charges only; code-interpreter fees are excluded.",
}, indent=2))
