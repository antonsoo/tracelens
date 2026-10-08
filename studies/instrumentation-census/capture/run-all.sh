#!/bin/bash
# Captures the spans the census reads: runs each instrumentation library's own test suite, or the
# Vercel AI SDK, over its recorded provider responses, and copies every span it exports.
#
#   capture/run-all.sh <work-dir>
#
# Needs: bash, curl, tar, uv, Python 3.12, Node 20+ with npm. No API key is used and no model is
# called: the tests replay HTTP cassettes (vcrpy, pytest-recording, cassetter) and the Vercel AI SDK
# is pointed at a local server that answers with a recorded response. Everything third-party runs
# under `env -i` with HOME inside <work-dir>, so it cannot see the caller's environment. Dependencies
# not pinned by the libraries themselves resolve to whatever is newest on the day. The repositories
# are pinned to the commits below; results.json records each library's version beside its numbers.
#
# Output: <work-dir>/out/<emitter>.jsonl, one line per batch of spans: {emitter, test, doc}.
set -u
WORK=$(realpath -m "${1:?usage: run-all.sh <work-dir>}")
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$WORK"/{home,src,dl,out,venvs,logs,uvcache,npmcache}
PATH_CLEAN="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
UA="tracelens-census/0.1 (read-only research; https://github.com/antonsoo/tracelens)"

# repository -> pinned commit (tarballs from codeload.github.com)
declare -A REPO_SHA=(
  [opentelemetry-python-contrib]="open-telemetry/opentelemetry-python-contrib fba0b778be0196587a3f81799c6a94e28a1f30dd"
  [otel-python]="open-telemetry/opentelemetry-python e52db839eb56d842c07e75dd7ce33aecd5dcc0ce"
  [openllmetry]="traceloop/openllmetry df4921a40940cdce136c4409380a55e9d4c7a96d"
  [openinference]="Arize-ai/openinference b625e5c695510e4f1b9d9bca602d4709c85fec6d"
  [pydantic-ai]="pydantic/pydantic-ai f55bb8a6fd6cdb34405e5f523d67cf8f366df4aa"
  [ai]="vercel/ai 5028fa46b4b4e695bf0d80e968db43268e9ec5ef"
)
for name in "${!REPO_SHA[@]}"; do
  read -r repo sha <<<"${REPO_SHA[$name]}"
  if [ ! -d "$WORK/src/$name" ]; then
    [ -s "$WORK/dl/$name.tgz" ] || curl -sSL -A "$UA" -o "$WORK/dl/$name.tgz" "https://codeload.github.com/$repo/tar.gz/$sha"
    mkdir -p "$WORK/src/$name" && tar xzf "$WORK/dl/$name.tgz" -C "$WORK/src/$name" --strip-components=1
  fi
done

C=$WORK/src/opentelemetry-python-contrib
O=$WORK/src/otel-python
L=$WORK/src/openllmetry/packages
OI=$WORK/src/openinference/python
P=$WORK/src/pydantic-ai

# uv in a clean environment. UV_DYNAMIC_VERSIONING_BYPASS lets Pydantic AI build from a tarball.
uvenv() { env -i PATH="$PATH_CLEAN" HOME="$WORK/home" UV_CACHE_DIR="${TL_UV_CACHE:-$WORK/uvcache}" UV_DYNAMIC_VERSIONING_BYPASS=2.30.0 "$@"; }
mkvenv() { # name, uv pip install args...
  local v=$1; shift
  uvenv uv venv -q --allow-existing "$WORK/venvs/$v" --python 3.12
  uvenv uv pip install -q --no-sources --python "$WORK/venvs/$v/bin/python" opentelemetry-exporter-otlp-proto-common "$@" >"$WORK/logs/install-$v.log" 2>&1 \
    || echo "install of $v failed, see logs/install-$v.log"
}
# pytest in a clean environment, with the span-copying plugin. $1 venv, $2 label, $3 cwd, rest pytest args
# TL_HOOK=exporter copies what an InMemorySpanExporter receives; processor copies every ended span.
runpy() {
  local v=$1 label=$2 cwd=$3; shift 3
  rm -f "$WORK/out/$label.jsonl"
  (cd "$cwd" && env -i PATH="/usr/local/bin:/usr/bin:/bin" HOME="$WORK/home" TL_HOOK="${TL_HOOK:-exporter}" TL_PAI_VERSION="${TL_PAI_VERSION:-}" \
    PYTHONPATH="$HERE" TL_DUMP="$WORK/out/$label.jsonl" TL_LABEL="$label" OPENAI_API_KEY=test ANTHROPIC_API_KEY=test GEMINI_API_KEY=test \
    GROQ_API_KEY=test MISTRAL_API_KEY=test CO_API_KEY=test \
    "$WORK/venvs/$v/bin/python" -m pytest -p dump_plugin ${PLUGINS:-} -q -p no:cacheprovider "$@" >"$WORK/logs/run-$label.log" 2>&1)
  echo "$label: $(wc -l <"$WORK/out/$label.jsonl" 2>/dev/null || echo 0) batches; $(tail -n 1 "$WORK/logs/run-$label.log" | cut -c1-90)"
}

# STEPS=pai,aisdk (any of: contrib, openllmetry, openinference, pai, aisdk) runs only those; default is all.
want() { [ -z "${STEPS:-}" ] || [[ ",$STEPS," == *",$1,"* ]]; }

OTELCORE=(-e "$O/opentelemetry-api" -e "$O/opentelemetry-sdk" -e "$O/opentelemetry-semantic-conventions" -e "$O/opentelemetry-proto" -e "$O/exporter/opentelemetry-exporter-otlp-proto-common")
SEMCONV_AI=(-e "$L/opentelemetry-semantic-conventions-ai")
OLTEST=('opentelemetry-sdk>=1.38,<2' 'pytest-recording>=0.13.1,<0.14' 'pytest>=8.2.2,<9' 'vcrpy>=8,<9' 'pytest-asyncio>=0.23,<0.24')

if want contrib; then
# --- OpenTelemetry's own GenAI instrumentations (opentelemetry-python-contrib, built on its core at HEAD)
mkvenv contrib "${OTELCORE[@]}" -e "$C/opentelemetry-instrumentation" -e "$C/util/opentelemetry-util-genai" \
  -e "$C/instrumentation-genai/opentelemetry-instrumentation-openai-v2" openai==2.26.0 httpx==0.27.2 'pytest<8' pytest-vcr pytest-asyncio==0.21.0 pyyaml vcrpy pydantic
runpy contrib otel-openai-v2 "$C/instrumentation-genai/opentelemetry-instrumentation-openai-v2" tests

grep -v '^#' "$C/instrumentation-genai/opentelemetry-instrumentation-vertexai/tests/requirements.latest.txt" | grep -v '^-e' | grep -v '^$' | grep -v 'shapely==2.0' | grep -v grpcio >"$WORK/vertex-req.txt"
mkvenv vertex -r "$WORK/vertex-req.txt" "${OTELCORE[@]}" -e "$C/opentelemetry-instrumentation" -e "$C/util/opentelemetry-util-genai" \
  -e "$C/instrumentation-genai/opentelemetry-instrumentation-vertexai[instruments]"
runpy vertex otel-vertexai "$C/instrumentation-genai/opentelemetry-instrumentation-vertexai" tests --vcr-record=none
fi

if want openllmetry; then
# --- OpenLLMetry (Traceloop)
mkvenv llm-openai "${SEMCONV_AI[@]}" -e "$L/opentelemetry-instrumentation-openai" 'openai[datalib]==1.99.7' requests "${OLTEST[@]}"
runpy llm-openai llm-openai "$L/opentelemetry-instrumentation-openai" tests/traces
mkvenv llm-anthropic "${SEMCONV_AI[@]}" -e "$L/opentelemetry-instrumentation-anthropic" 'anthropic[bedrock]>=0.86.0' "${OLTEST[@]}"
runpy llm-anthropic llm-anthropic "$L/opentelemetry-instrumentation-anthropic" tests --ignore=tests/test_completion.py
mkvenv llm-bedrock "${SEMCONV_AI[@]}" -e "$L/opentelemetry-instrumentation-bedrock" 'boto3>=1.34.120,<2' 'aioboto3>=13,<15' 'aiobotocore>=2.13,<3' "${OLTEST[@]}"
runpy llm-bedrock llm-bedrock "$L/opentelemetry-instrumentation-bedrock" tests/traces
mkvenv llm-cohere "${SEMCONV_AI[@]}" -e "$L/opentelemetry-instrumentation-cohere" 'cohere>=5.18,<6' 'opentelemetry-sdk>=1.38,<2' 'pytest-recording>=0.13.1,<0.14' 'pytest>=8.2.2,<9' 'vcrpy>=8,<9' 'pytest-asyncio>=1.2,<2'
runpy llm-cohere llm-cohere "$L/opentelemetry-instrumentation-cohere" tests
mkvenv llm-genai "${SEMCONV_AI[@]}" -e "$L/opentelemetry-instrumentation-google-generativeai" 'google-genai>=1,<2' 'opentelemetry-sdk>=1.38,<2' 'pytest-recording>=0.13.1,<0.14' 'pytest>=8.2.2,<9' 'vcrpy>=8,<9' 'pytest-asyncio>=1.2,<2'
runpy llm-genai llm-genai "$L/opentelemetry-instrumentation-google-generativeai" tests
mkvenv llm-groq "${SEMCONV_AI[@]}" -e "$L/opentelemetry-instrumentation-groq" 'groq>=1.2' 'opentelemetry-sdk>=1.38,<2' 'pytest-recording>=0.13.1,<0.14' 'pytest>=8.2.2,<9' 'vcrpy>=8,<9' 'pytest-asyncio>=0.23.7,<0.24'
runpy llm-groq llm-groq "$L/opentelemetry-instrumentation-groq" tests/traces
mkvenv llm-mistral "${SEMCONV_AI[@]}" -e "$L/opentelemetry-instrumentation-mistralai" 'mistralai>=1,<2' 'opentelemetry-sdk>=1.38,<2' 'pytest-recording>=0.13.1,<0.14' 'pytest>=8.2.2,<9' 'vcrpy>=8,<9' 'pytest-asyncio>=0.23.7,<1.4'
runpy llm-mistral llm-mistral "$L/opentelemetry-instrumentation-mistralai" tests
mkvenv llm-agents "${SEMCONV_AI[@]}" -e "$L/opentelemetry-instrumentation-openai-agents" -e "$L/opentelemetry-instrumentation-openai" 'openai-agents>=0.14.2' 'litellm>=1.71.2,<2' 'opentelemetry-sdk>=1.38,<2' 'pytest-recording>=0.13.1,<0.14' 'pytest>=8.2.2,<9' 'vcrpy>=8,<9' 'pytest-asyncio>=1,<2'
runpy llm-agents llm-agents "$L/opentelemetry-instrumentation-openai-agents" tests
fi

if want openinference; then
# --- OpenInference (Arize Phoenix)
OICORE=(-e "$OI/openinference-semantic-conventions" -e "$OI/openinference-instrumentation")
oi() { echo "-e $OI/instrumentation/openinference-instrumentation-$1"; }
mkvenv oi-openai "${OICORE[@]}" $(oi openai) openai==2.8.0 opentelemetry-sdk opentelemetry-instrumentation-httpx respx numpy pytest-recording 'httpx<0.28' trio pytest-asyncio
runpy oi-openai oi-openai "$OI/instrumentation/openinference-instrumentation-openai" tests
mkvenv oi-anthropic "${OICORE[@]}" $(oi anthropic) anthropic==1.8.0 opentelemetry-sdk pytest-asyncio pytest-recording
runpy oi-anthropic oi-anthropic "$OI/instrumentation/openinference-instrumentation-anthropic" tests
mkvenv oi-litellm "${OICORE[@]}" $(oi litellm) litellm==1.84.0 fastapi orjson opentelemetry-sdk opentelemetry-instrumentation-httpx pytest-recording tenacity pytest-asyncio
TL_HOOK=processor runpy oi-litellm oi-litellm "$OI/instrumentation/openinference-instrumentation-litellm" tests
mkvenv oi-genai "${OICORE[@]}" $(oi google-genai) google-genai==2.0.1 opentelemetry-sdk pytest-asyncio pytest-recording respx
TL_HOOK=processor runpy oi-genai oi-genai "$OI/instrumentation/openinference-instrumentation-google-genai" tests
mkvenv oi-pydanticai "${OICORE[@]}" $(oi pydantic-ai) pytest opentelemetry-sdk opentelemetry-exporter-otlp-proto-http pytest-recording pydantic-ai==2.24.0 genai-prices==0.1.1 pytest-asyncio
TL_HOOK=processor runpy oi-pydanticai oi-pydanticai "$OI/instrumentation/openinference-instrumentation-pydantic-ai" tests
mkvenv oi-adk "${OICORE[@]}" $(oi google-adk) google-adk==2.10.0 opentelemetry-sdk pytest pytest-asyncio pytest-recording
TL_HOOK=processor runpy oi-adk oi-adk "$OI/instrumentation/openinference-instrumentation-google-adk" tests
mkvenv oi-strands "${OICORE[@]}" $(oi strands-agents) strands-agents==1.19.0 openai opentelemetry-sdk pytest pytest-asyncio pytest-recording
TL_HOOK=processor runpy oi-strands oi-strands "$OI/instrumentation/openinference-instrumentation-strands-agents" tests
fi

if want pai; then
# --- Pydantic AI's own instrumentation, its own tests, at every instrumentation-settings version
mkvenv pai -e "$P/pydantic_ai_slim[openai,anthropic,google,groq,mistral,cohere,bedrock,logfire]" -e "$P/pydantic_graph" -e "$P/pydantic_evals" \
  'anyio>=4.11' trio dirty-equals inline-snapshot 'pytest>=9' pytest-mock cassetter genai-prices brotli devtools asgi-lifespan opentelemetry-sdk \
  'blockbuster>=1.5.28,<1.6' pytest-xdist pytest-pretty hypothesis fastmcp sqlparse nest-asyncio
# Pydantic AI's conftest fills huggingface_hub's provider tables when the package is importable, and
# fails on the versions that arrive as a dependency; without the package it skips that step.
uvenv uv pip uninstall -q --python "$WORK/venvs/pai/bin/python" huggingface-hub
for v in 2 3 4 5 6; do
  TL_HOOK=processor TL_PAI_VERSION=$v PLUGINS="-p pai_plugin" runpy pai "pai-v$v" "$P" -W ignore::DeprecationWarning -W ignore::pydantic_ai.exceptions.PydanticAIDeprecationWarning \
    tests/models/test_openai.py tests/models/test_anthropic.py tests/models/test_google.py tests/models/test_groq.py tests/models/test_mistral.py tests/models/test_cohere.py
done
fi

if want aisdk; then
# --- Vercel AI SDK: recorded responses from the repository's fixtures, replayed through a local server
npm_clean() { env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$WORK/home" npm_config_cache="${TL_NPM_CACHE:-$WORK/npmcache}" "$@"; }
OTELJS="@opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/context-async-hooks @opentelemetry/otlp-transformer"
mkdir -p "$WORK/aisdk7" "$WORK/aisdk6"
npm_clean bash -c "cd $WORK/aisdk7 && npm init -y >/dev/null && npm i --ignore-scripts --no-audit --no-fund ai@7.0.133 @ai-sdk/otel@1.0.133 @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/mistral @ai-sdk/groq @ai-sdk/deepseek $OTELJS >$WORK/logs/install-aisdk7.log 2>&1"
npm_clean bash -c "cd $WORK/aisdk6 && npm init -y >/dev/null && npm i --ignore-scripts --no-audit --no-fund ai@ai-v6 @ai-sdk/openai@ai-v6 @ai-sdk/anthropic@ai-v6 @ai-sdk/google@ai-v6 @ai-sdk/mistral@ai-v6 @ai-sdk/groq@ai-v6 @ai-sdk/deepseek@ai-v6 $OTELJS >$WORK/logs/install-aisdk6.log 2>&1"
cp "$HERE/replay-aisdk.mjs" "$WORK/aisdk7/replay.mjs"; cp "$HERE/replay-aisdk.mjs" "$WORK/aisdk6/replay.mjs"
npm_clean bash -c "cd $WORK/aisdk7 && node replay.mjs v7-otel $WORK/src/ai $WORK/out/aisdk-v7-otel.jsonl >$WORK/logs/run-aisdk-v7-otel.log 2>&1; node replay.mjs v7-legacy $WORK/src/ai $WORK/out/aisdk-v7-legacy.jsonl >$WORK/logs/run-aisdk-v7-legacy.log 2>&1"
npm_clean bash -c "cd $WORK/aisdk6 && node replay.mjs v6 $WORK/src/ai $WORK/out/aisdk-v6.jsonl >$WORK/logs/run-aisdk-v6.log 2>&1"
wc -l "$WORK"/out/aisdk-*.jsonl
fi

# --- the versions that resolved
{
  for v in "$WORK"/venvs/*; do echo "== $(basename "$v")"; uvenv uv pip list --python "$v/bin/python" 2>/dev/null | grep -i -E "^(opentelemetry|openinference|openai|anthropic|pydantic-ai|google-genai|google-adk|litellm|strands|cohere|mistralai|groq|boto3|vcrpy|pytest |pytest-recording|cassetter)"; done
  for d in aisdk7 aisdk6; do echo "== $d"; (cd "$WORK/$d" && npm_clean npm ls --depth=0 2>/dev/null | tail -n +2); done
} >"$WORK/versions.txt"
echo "done; spans in $WORK/out, versions in $WORK/versions.txt"
