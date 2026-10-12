"""Synthetic byte-level fixtures; Python strict decoding supplies the oracle."""
import base64
import hashlib
import json
from pathlib import Path

TRACE = "a" * 32
SPAN = "1" * 16
MARK = "REPLACE"


def documents():
    span = {"traceId": TRACE, "spanId": SPAN, "name": "operation " + MARK,
            "startTimeUnixNano": "1790000000000000000", "endTimeUnixNano": "1790000001000000000"}
    otlp = json.dumps({"resourceSpans": [{"scopeSpans": [{"spans": [span]}]}]})
    jaeger = json.dumps({"data": [{"traceID": TRACE, "processes": {}, "spans": [{
        "traceID": TRACE, "spanID": SPAN, "operationName": "operation " + MARK,
        "startTime": 1790000000000000, "duration": 1000000}]}]})
    return {"otlp": otlp, "jsonl": '{"resourceMetrics": []}\n' + otlp + '\n', "jaeger": jaeger}


def variants(text):
    for encoding, bom in [("utf-8", b""), ("utf-8", b"\xef\xbb\xbf"),
                          ("utf-16le", b"\xff\xfe"), ("utf-16be", b"\xfe\xff")]:
        for label, value in [("unicode", "café 東京 🔥"), ("literal-replacement", "\ufffd")]:
            yield f"{encoding}{'-bom' if bom and encoding == 'utf-8' else ''}-{label}", encoding, bom + text.replace(MARK, value).encode(encoding)
    for label, replacement in [
        ("continuation-80", b"\x80"), ("continuation-81", b"\x81"),
        ("overlong", b"\xc0\xaf"), ("surrogate", b"\xed\xa0\x80"),
        ("beyond-unicode", b"\xf4\x90\x80\x80"),
        ("incomplete", b"\xe2\x82"), ("invalid-leading-byte", b"\xff"),
    ]:
        yield "utf-8-" + label, "utf-8", text.encode().replace(MARK.encode(), replacement)
    yield "utf-8-bom-damaged", "utf-8", b"\xef\xbb\xbf" + text.encode().replace(MARK.encode(), b"\x80")
    for encoding, bom in [("utf-16le", b"\xff\xfe"), ("utf-16be", b"\xfe\xff")]:
        for label, value in [("high-surrogate", "\ud800"), ("low-surrogate", "\udc00")]:
            yield encoding + "-" + label, encoding, bom + text.replace(MARK, value).encode(encoding, errors="surrogatepass")
        yield encoding + "-odd-byte", encoding, bom + text.replace(MARK, "valid").encode(encoding) + b"\x20"


rows = []
prices = json.dumps([{"id": MARK, "matchModel": "synthetic-model", "provider": "synthetic",
                     "inputPerMTok": 1, "outputPerMTok": 2,
                     "sourceUrl": "https://example.invalid/synthetic", "sourceDate": "2026-10-12"}])
for format_name, text in {**documents(), "prices": prices}.items():
    for variant, encoding, raw in variants(text):
        try:
            decoded = raw.decode(encoding, errors="strict").removeprefix("\ufeff")
            valid = True
        except UnicodeDecodeError:
            decoded, valid = None, False
        rows.append({"id": format_name + "-" + variant, "format": format_name,
                     "encoding": encoding, "valid": valid, "bytes": len(raw),
                     "sha256": hashlib.sha256(raw).hexdigest(),
                     "base64": base64.b64encode(raw).decode(), "decoded": decoded})

Path(__file__).with_name("cases.json").write_text(json.dumps({
    "synthetic": True, "oracle": "Python strict UTF-8 / UTF-16LE / UTF-16BE decoding",
    "cases": rows,
}, ensure_ascii=True, indent=2) + "\n")
print(f"Generated {len(rows)} cases: {sum(r['valid'] for r in rows)} valid, {sum(not r['valid'] for r in rows)} damaged")
