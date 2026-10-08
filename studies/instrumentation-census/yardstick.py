"""The yardstick: what the provider's own recorded response said about each model call.

Reads VCR cassettes (YAML) that the instrumentation libraries' test suites replay and returns, per
recorded HTTP exchange with a model endpoint, the facts the API reported: model, token counts,
tool calls, finish reasons. Nothing here looks at any span.

Token fields are kept as the API reports them (`raw_*`) and, for the one provider whose
`input_tokens` does not include the cached tokens (Anthropic), also as the total the
OpenTelemetry GenAI convention asks for (`input_total`: "SHOULD include all types of input
tokens, including cached"). Run with `python3 -I`.
"""
import glob
import gzip
import json
import os
import re
import urllib.parse

import yaml


def _json(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def _sse(text):
    """Server-sent events as a list of (event, parsed data)."""
    out, event = [], None
    for line in text.splitlines():
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data = line[5:].strip()
            if data and data != "[DONE]":
                parsed = _json(data)
                if parsed is not None:
                    out.append((event, parsed))
            event = None
    return out


def _call(api, status, stream):
    return {
        "api": api, "status": status, "stream": stream, "model": None, "id": None,
        "input_total": None, "raw_input": None, "output": None, "raw_output": None, "cache_read": None, "cache_write": None,
        "reasoning": None, "tools": [], "finish": [], "text": False,
    }


def openai_chat(body, status, stream):
    c = _call("openai.chat", status, stream)
    events = [d for _, d in _sse(body)] if stream else [_json(body)]
    tools, finish, text = {}, {}, False
    for ev in events:
        if not isinstance(ev, dict):
            continue
        c["model"] = ev.get("model") or c["model"]
        c["id"] = ev.get("id") or c["id"]
        usage = ev.get("usage")
        if isinstance(usage, dict):
            c["input_total"] = c["raw_input"] = usage.get("prompt_tokens")
            c["output"] = usage.get("completion_tokens")
            c["cache_read"] = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
            c["reasoning"] = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
        for ch in ev.get("choices") or []:
            idx = ch.get("index", 0)
            if ch.get("finish_reason"):
                finish[idx] = ch["finish_reason"]
            msg = ch.get("message") or ch.get("delta") or {}
            if msg.get("content") or ch.get("text"):
                text = True
            for tc in msg.get("tool_calls") or []:
                fn = tc.get("function") or {}
                key = (idx, tc.get("index", len(tools)))
                if fn.get("name"):
                    tools[key] = fn["name"]
            fc = msg.get("function_call")
            if isinstance(fc, dict) and fc.get("name"):
                tools[(idx, "fc")] = fc["name"]
    c["tools"] = [tools[k] for k in sorted(tools, key=str)]
    c["finish"] = [finish[k] for k in sorted(finish)]
    c["text"] = text
    return c


def openai_completion(body, status, stream):
    c = openai_chat(body, status, stream)
    c["api"] = "openai.completions"
    return c


def openai_embeddings(body, status, stream):
    c = _call("openai.embeddings", status, False)
    d = _json(body)
    if isinstance(d, dict):
        c["model"] = d.get("model")
        u = d.get("usage") or {}
        c["input_total"] = c["raw_input"] = u.get("prompt_tokens")
    return c


def openai_responses(body, status, stream):
    c = _call("openai.responses", status, stream)
    resp = None
    if stream:
        for _, ev in _sse(body):
            if isinstance(ev, dict) and isinstance(ev.get("response"), dict) and str(ev.get("type", "")).startswith(
                ("response.completed", "response.incomplete", "response.failed")
            ):
                resp = ev["response"]
    else:
        resp = _json(body)
    if not isinstance(resp, dict):
        return c
    c["model"] = resp.get("model")
    c["id"] = resp.get("id")
    u = resp.get("usage") or {}
    c["input_total"] = c["raw_input"] = u.get("input_tokens")
    c["output"] = u.get("output_tokens")
    c["cache_read"] = (u.get("input_tokens_details") or {}).get("cached_tokens")
    c["reasoning"] = (u.get("output_tokens_details") or {}).get("reasoning_tokens")
    for item in resp.get("output") or []:
        if item.get("type") in ("function_call", "custom_tool_call") and item.get("name"):
            c["tools"].append(item["name"])
        if item.get("type") == "message":
            c["text"] = True
    c["finish"] = [resp["status"]] if resp.get("status") else []
    return c


def anthropic_messages(body, status, stream):
    c = _call("anthropic.messages", status, stream)
    usage = {}
    if stream:
        for ev_name, ev in _sse(body):
            if not isinstance(ev, dict):
                continue
            t = ev.get("type")
            if t == "message_start":
                m = ev.get("message") or {}
                c["model"] = m.get("model")
                c["id"] = m.get("id")
                usage.update({k: v for k, v in (m.get("usage") or {}).items() if v is not None})
            elif t == "content_block_start":
                blk = ev.get("content_block") or {}
                if blk.get("type") == "tool_use" and blk.get("name"):
                    c["tools"].append(blk["name"])
                if blk.get("type") == "text":
                    c["text"] = True
            elif t == "message_delta":
                if (ev.get("delta") or {}).get("stop_reason"):
                    c["finish"] = [ev["delta"]["stop_reason"]]
                usage.update({k: v for k, v in (ev.get("usage") or {}).items() if v is not None})
    else:
        d = _json(body)
        if isinstance(d, dict):
            c["model"] = d.get("model")
            c["id"] = d.get("id")
            usage = d.get("usage") or {}
            if d.get("stop_reason"):
                c["finish"] = [d["stop_reason"]]
            for blk in d.get("content") or []:
                if blk.get("type") == "tool_use" and blk.get("name"):
                    c["tools"].append(blk["name"])
                if blk.get("type") == "text":
                    c["text"] = True
    if len(usage.get("iterations") or []) > 1:  # server-side compaction: one response, several billed passes
        c["unscored_usage"] = True
    if usage:
        raw = usage.get("input_tokens")
        cr, cw = usage.get("cache_read_input_tokens"), usage.get("cache_creation_input_tokens")
        c["raw_input"] = raw
        c["input_total"] = None if raw is None else raw + (cr or 0) + (cw or 0)
        c["output"] = usage.get("output_tokens")
        c["cache_read"], c["cache_write"] = cr, cw
    return c


def gemini_generate(body, status, stream):
    c = _call("gemini.generateContent", status, stream)
    d = _json(body)
    if isinstance(d, list):  # streamGenerateContent without alt=sse is a JSON array of chunks
        events = d
    elif isinstance(d, dict):
        events = [d]
    else:
        events = [e for _, e in _sse(body)]
    finish = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        c["model"] = ev.get("modelVersion") or c["model"]
        c["id"] = ev.get("responseId") or c["id"]
        u = ev.get("usageMetadata")
        if isinstance(u, dict):
            # Google bills the tool-use prompt tokens as input and the thinking tokens as output;
            # candidatesTokenCount and promptTokenCount leave them out.
            c["raw_input"] = u.get("promptTokenCount")
            c["input_total"] = None if c["raw_input"] is None else c["raw_input"] + (u.get("toolUsePromptTokenCount") or 0)
            c["raw_output"] = u.get("candidatesTokenCount")
            c["output"] = None if c["raw_output"] is None and not u.get("thoughtsTokenCount") else (c["raw_output"] or 0) + (u.get("thoughtsTokenCount") or 0)
            c["cache_read"] = u.get("cachedContentTokenCount")
            c["reasoning"] = u.get("thoughtsTokenCount")
        for cand in ev.get("candidates") or []:
            if cand.get("finishReason"):
                finish.append(cand["finishReason"])
            for part in (cand.get("content") or {}).get("parts") or []:
                if "functionCall" in part:
                    c["tools"].append(part["functionCall"].get("name"))
                if part.get("text"):
                    c["text"] = True
    c["finish"] = finish
    return c


def bedrock_converse(body, status, stream):
    c = _call("bedrock.converse", status, stream)
    d = _json(body)
    if not isinstance(d, dict):
        return c
    u = d.get("usage") or {}
    c["raw_input"] = u.get("inputTokens")
    cr, cw = u.get("cacheReadInputTokens"), u.get("cacheWriteInputTokens")
    c["input_total"] = None if c["raw_input"] is None else c["raw_input"] + (cr or 0) + (cw or 0)
    c["output"] = u.get("outputTokens")
    c["cache_read"], c["cache_write"] = cr, cw
    if d.get("stopReason"):
        c["finish"] = [d["stopReason"]]
    for blk in ((d.get("output") or {}).get("message") or {}).get("content") or []:
        if "toolUse" in blk:
            c["tools"].append(blk["toolUse"].get("name"))
        if blk.get("text"):
            c["text"] = True
    return c


def bedrock_invoke(body, status, stream):
    """InvokeModel returns the model family's own body; only the Anthropic one is read here."""
    c = anthropic_messages(body, status, False)
    c["api"] = "bedrock.invoke"
    c["stream"] = stream
    d = _json(body)
    if isinstance(d, dict) and "usage" not in d:  # Titan, Llama, Cohere, AI21 bodies
        c["unparsed"] = True
    return c


def cohere_chat(body, status, stream):
    c = _call("cohere.chat", status, False)
    d = _json(body)
    if not isinstance(d, dict):
        return c
    c["id"] = d.get("id") or d.get("response_id")
    u = d.get("usage") or {}
    tok = u.get("tokens") or (d.get("meta") or {}).get("tokens") or {}
    billed = u.get("billed_units") or (d.get("meta") or {}).get("billed_units") or {}
    c["raw_input"] = c["input_total"] = tok.get("input_tokens", billed.get("input_tokens"))
    c["output"] = tok.get("output_tokens", billed.get("output_tokens"))
    # Cohere reports two counts: tokens, and the billed units (which leave out the prompt a
    # request shares with an earlier one). An emitter may write either.
    c["alt_input"], c["alt_output"] = billed.get("input_tokens"), billed.get("output_tokens")
    if d.get("finish_reason"):
        c["finish"] = [d["finish_reason"]]
    for tc in (d.get("message") or {}).get("tool_calls") or d.get("tool_calls") or []:
        name = (tc.get("function") or {}).get("name") or tc.get("name")
        if name:
            c["tools"].append(name)
    c["unparsed"] = False
    return c


def streamed_unparsed(api):
    def parse(body, status, stream):
        c = _call(api, status, True)
        c["unparsed"] = True  # a binary event stream: not read, so no field is scored
        return c

    return parse


ROUTES = [
    (re.compile(r"/chat/completions"), openai_chat),
    (re.compile(r"/v1/completions$"), openai_completion),
    (re.compile(r"/embeddings$"), openai_embeddings),
    (re.compile(r"/v1/responses$"), openai_responses),
    (re.compile(r"/v1/messages$"), anthropic_messages),
    (re.compile(r"(:generateContent|:streamGenerateContent)$"), gemini_generate),
    (re.compile(r"/model/[^/]+/converse$"), bedrock_converse),
    (re.compile(r"/model/[^/]+/invoke$"), bedrock_invoke),
    (re.compile(r"/model/[^/]+/(converse-stream|invoke-with-response-stream)$"), streamed_unparsed("bedrock.stream")),
    (re.compile(r"/v[12]/chat$"), cohere_chat),
]


_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
_cache = {}


def read_cassette(path):
    """Model-endpoint exchanges of one cassette, in recorded order."""
    if path not in _cache:
        _cache[path] = _read_cassette(path)
    return [dict(c) for c in _cache[path]]


def _read_cassette(path):
    with open(path) as fh:
        doc = yaml.load(fh, Loader=_LOADER)  # safe: SafeLoader or its C twin
    out = []
    for item in (doc or {}).get("interactions", []):
        req, resp = item["request"], item["response"]
        if req.get("method", "").upper() != "POST":
            continue
        path_only = re.sub(r"\?.*", "", req["uri"])
        for pattern, parser in ROUTES:
            if pattern.search(path_only):
                status = resp.get("status")
                status = status.get("code") if isinstance(status, dict) else status
                status = int(status) if str(status).isdigit() else status
                if "parsed_body" in resp:  # the cassetter plugin (Pydantic AI) stores the body already parsed
                    body = resp["parsed_body"] if isinstance(resp["parsed_body"], str) else json.dumps(resp["parsed_body"])
                else:
                    raw = resp.get("body") or {}
                    body = raw.get("string", "") if "string" in raw else raw.get("content", "")  # vcrpy / cassetter
                    if not isinstance(body, (str, bytes)):
                        body = json.dumps(body)
                if isinstance(body, bytes):
                    if body[:2] == b"\x1f\x8b":  # recorded still compressed
                        body = gzip.decompress(body)
                    body = body.decode("utf-8", "replace")
                req_body = req.get("parsed_body") if isinstance(req.get("parsed_body"), dict) else (_json(req.get("body") if isinstance(req.get("body"), str) else "") or {})
                stream = bool(req_body.get("stream")) or "text/event-stream" in str(resp.get("headers", {})).lower()
                call = parser(body, status, stream)
                if call["raw_output"] is None:
                    call["raw_output"] = call["output"]
                call["request_model"] = req_body.get("model")
                bedrock = re.search(r"/model/([^/]+)/", path_only)
                if bedrock:  # a Bedrock request names its model in the URL, and the response does not repeat it
                    call["request_model"] = call["model"] = urllib.parse.unquote(bedrock.group(1))
                call["uri"] = path_only
                out.append(call)
                break
    return out


def index_cassettes(package_dir):
    """{(module-or-None, stem): path} for every cassette under a package's tests."""
    found = {}
    for path in glob.glob(os.path.join(package_dir, "**", "cassettes", "**", "*.yaml"), recursive=True):
        rel = os.path.relpath(path, package_dir).split(os.sep)
        after = rel[rel.index("cassettes") + 1 :]
        module = after[0] if len(after) > 1 else None
        found.setdefault((module, os.path.splitext(after[-1])[0]), path)
    return found


def cassette_for_test(index, test_id):
    """Find the cassette a pytest id replays: `file.py::[Class::]name[param]`."""
    parts = test_id.split("::")
    module = os.path.splitext(os.path.basename(parts[0]))[0]
    name = parts[-1]
    base = re.sub(r"\[.*\]$", "", name)
    cls = parts[-2] if len(parts) > 2 else None
    keys = [(module, name), (module, base), (None, name), (None, base), (base, name), (base, base)]
    if cls:  # pytest-recording names a class's cassettes `Class.test`
        keys += [(base, f"{cls}.{name}"), (base, f"{cls}.{base}"), (module, f"{cls}.{name}"), (module, f"{cls}.{base}")]
    for key in keys:
        if key in index:
            return index[key]
    param = re.search(r"\[(.*)\]$", name)
    if param:
        for key in ((base, param.group(1)), (base, f"{name}")):
            if key in index:
                return index[key]
    # pytest-recording sanitises a parametrised name: `test[a-b]` becomes `test[a-b]` or `test_a-b`
    for (mod, stem), path in index.items():
        if mod in (module, None) and stem.startswith(base) and re.sub(r"\W", "", stem) == re.sub(r"\W", "", name):
            return path
    return None


FIXTURE_PARSERS = {
    "openai/src/responses": openai_responses,
    "anthropic/src": anthropic_messages,
    "google/src": gemini_generate,
    "mistral/src": openai_chat,
    "groq/src": openai_chat,
    "deepseek/src/chat": openai_chat,
}


def read_fixture(repo_dir, test_id):
    """The one recorded exchange of a Vercel AI SDK fixture, named `<package dir>::<file>`."""
    pkg_dir, name = test_id.split("::", 1)
    path = os.path.join(repo_dir, "packages", pkg_dir, "__fixtures__", name)
    with open(path) as fh:
        text = fh.read()
    stream = name.endswith(".chunks.txt")
    body = "".join(f"data: {line}\n\n" for line in text.splitlines() if line.strip()) if stream else text
    call = FIXTURE_PARSERS[pkg_dir](body, 200, stream)
    call["request_model"] = None
    call["uri"] = test_id
    if call["raw_output"] is None:
        call["raw_output"] = call["output"]
    return [call]
