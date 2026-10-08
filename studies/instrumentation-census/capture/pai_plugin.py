"""pytest plugin for Pydantic AI's own suite: instrument every Agent at one settings version.

Pydantic AI's tests do not turn instrumentation on by default, so this fixture does what a user
does with `Agent.instrument_all(InstrumentationSettings(version=N))`, then dump_plugin (processor
hook) copies the spans. TL_PAI_VERSION picks N.
"""
import os

import pytest


@pytest.fixture(autouse=True)
def _tl_instrument_all(no_instrumentation_by_default):  # run after the suite resets instrumentation
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from pydantic_ai import Agent
    from pydantic_ai.models.instrumented import InstrumentationSettings

    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(InMemorySpanExporter()))
    Agent.instrument_all(InstrumentationSettings(tracer_provider=provider, version=int(os.environ["TL_PAI_VERSION"])))
    yield
    Agent.instrument_all(False)
