"""Check a one-trace OTLP SDK capture against a CLI timing report.

The oracle samples each interval between raw timestamp boundaries. A span
contributes self time when it is active and none of its direct children is
active. This does not import the app or reproduce its interval subtraction
and event sweep. Supports the canonical JSON emitted by capture-timing.py.
"""
import hashlib
import json
from pathlib import Path
import sys

capture_path, report_path = map(Path, sys.argv[1:])
raw = capture_path.read_bytes()
capture = json.loads(raw)
report = json.loads(report_path.read_bytes())
spans = [span for resource in capture['resourceSpans']
         for scope in resource['scopeSpans'] for span in scope['spans']]
assert {span['traceId'] for span in spans} == {report['traceId']}
start = min(int(span['startTimeUnixNano']) for span in spans)
end = max(int(span['endTimeUnixNano']) for span in spans)
assert int(report['startTimeUnixNano']) == start
assert int(report['endTimeUnixNano']) == end
bounds = sorted({int(span[key]) for span in spans
                 for key in ('startTimeUnixNano', 'endTimeUnixNano')})
children = {span['spanId']: [other for other in spans
                           if other.get('parentSpanId') == span['spanId']]
            for span in spans}
def active(span, point):
    return int(span['startTimeUnixNano']) <= point < int(span['endTimeUnixNano'])
def kind(span):
    attrs = {item['key']: item['value'].get('stringValue') for item in span.get('attributes', [])}
    return 'tool' if attrs.get('gen_ai.operation.name') == 'execute_tool' else 'other'

buckets = dict.fromkeys(('llm', 'tool', 'other', 'overlap', 'uncovered'), 0)
summed = excess = peak = 0
intervals = report['intervals']
assert sum(int(row['durationNs']) for row in intervals) == end - start
cursor = 0
for row in intervals:
    assert int(row['offsetNs']) == cursor
    assert int(row['durationNs']) > 0
    cursor += int(row['durationNs'])
for a, b in zip(bounds, bounds[1:]):
    selected = [span for span in spans if active(span, a)
                and not any(active(child, a) for child in children[span['spanId']])]
    count = len(selected)
    bucket = 'uncovered' if count == 0 else kind(selected[0]) if count == 1 else 'overlap'
    buckets[bucket] += b - a
    summed += count * (b - a)
    excess += max(0, count - 1) * (b - a)
    peak = max(peak, count)
    intersecting = [row for row in intervals if start + int(row['offsetNs']) < b
                    and start + int(row['offsetNs']) + int(row['durationNs']) > a]
    assert intersecting
    for row in intersecting:
        assert row['bucket'] == bucket
        assert row['activeCount'] == count
        assert set(row['spanIds']).issubset({span['spanId'] for span in selected})
        assert len(row['spanIds']) + row['omittedSpanCount'] == count
assert {key: int(value) for key, value in report['bucketsNs'].items()} == buckets
assert int(report['summedSelfNs']) == summed
assert int(report['overlapExcessNs']) == excess
assert report['peakConcurrency'] == peak
assert int(report['elapsedNs']) == end - start == summed - excess + buckets['uncovered']
print(json.dumps({'captureSha256': hashlib.sha256(raw).hexdigest(),
                  'spans': len(spans), 'rawIntervals': len(bounds) - 1,
                  'elapsedNs': str(end - start), 'summedSelfNs': str(summed),
                  'overlapExcessNs': str(excess), 'peakConcurrency': peak,
                  'bucketsNs': {key: str(value) for key, value in buckets.items()},
                  'result': 'matched'}, indent=2))
