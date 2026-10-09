"""Compare every built static file with the bytes served by a public/local URL."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('url')
parser.add_argument('dist', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--build-source', default=None)
args = parser.parse_args()
root = args.dist.resolve()
assert root.is_dir(), f'No build directory: {root}'
base = args.url.rstrip('/') + '/'
assert urllib.parse.urlsplit(base).scheme in ('http', 'https')

def check(path):
    relative = path.relative_to(root).as_posix()
    expected = hashlib.sha256(path.read_bytes()).hexdigest()
    try:
        with urllib.request.urlopen(base + urllib.parse.quote(relative), timeout=30) as response:
            body = response.read()
        observed = hashlib.sha256(body).hexdigest()
        return {'path': relative, 'bytes': len(body), 'expectedSha256': expected,
                'servedSha256': observed, 'matches': expected == observed}
    except Exception as error:
        return {'path': relative, 'expectedSha256': expected, 'matches': False,
                'error': str(error)}

with ThreadPoolExecutor(max_workers=6) as pool:
    files = list(pool.map(check, sorted(path for path in root.rglob('*') if path.is_file())))
assert files, 'Build directory contains no files'
report = {'url': base, 'buildSource': args.build_source, 'files': files,
          'allMatch': all(row['matches'] for row in files)}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'files': len(files), 'allMatch': report['allMatch']}))
if not report['allMatch']:
    raise SystemExit('Served files differ or are unavailable; see the output report')
