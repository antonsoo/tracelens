"""OpenLLMetry (Traceloop): opentelemetry-instrumentation-anthropic and -openai, which write
the OpenTelemetry GenAI semantic conventions (gen_ai.*).

    uv run --no-project --with anthropic --with openai --with opentelemetry-sdk \
      --with opentelemetry-exporter-otlp-proto-common \
      --with opentelemetry-instrumentation-anthropic --with opentelemetry-instrumentation-openai \
      python scripts/instrumented-traces/openllmetry.py
"""
from common import dump, provider, run_anthropic, run_openai
from opentelemetry.instrumentation.anthropic import AnthropicInstrumentor
from opentelemetry.instrumentation.openai import OpenAIInstrumentor

AnthropicInstrumentor().instrument(tracer_provider=provider)
OpenAIInstrumentor().instrument(tracer_provider=provider)
run_anthropic()
run_openai()
dump("tests/fixtures/instrumented/openllmetry.json")
