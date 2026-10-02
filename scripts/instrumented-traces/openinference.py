"""OpenInference (Arize): openinference-instrumentation-anthropic and -openai.

    uv run --no-project --with anthropic --with openai --with opentelemetry-sdk \
      --with opentelemetry-exporter-otlp-proto-common \
      --with openinference-instrumentation-anthropic --with openinference-instrumentation-openai \
      python scripts/instrumented-traces/openinference.py
"""
from common import dump, provider, run_anthropic, run_openai
from openinference.instrumentation.anthropic import AnthropicInstrumentor
from openinference.instrumentation.openai import OpenAIInstrumentor

AnthropicInstrumentor().instrument(tracer_provider=provider)
OpenAIInstrumentor().instrument(tracer_provider=provider)
run_anthropic()
run_openai()
dump("tests/fixtures/instrumented/openinference.json")
