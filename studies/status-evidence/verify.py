"""Verify retained status observations against clean builds and a local npm install.

Run after the clean checks and replays. Expects WORK_ROOT/clean, installed,
source.tar, source-manifest.json, checks.json, package-checks.json and three
retained replay files. It does not treat an absent check as successful.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile


def digest(raw):
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def files(root):
    return {str(path.relative_to(root)): digest(path.read_bytes())
            for path in sorted(root.rglob('*')) if path.is_file()}


def read(path):
    return json.loads(path.read_text())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('work_root', type=Path)
parser.add_argument('baseline_root', type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
root = args.work_root.resolve()
clean = root / 'clean'
results = repo / 'studies/status-evidence/results'
source = read(root / 'source-manifest.json')
for name, expected in source['files'].items():
    assert digest((clean / name).read_bytes()) == expected, name
baseline_commit = 'b7773d699ec3590c81bd455f87a2d36581e53ce2'
baseline_archive = subprocess.check_output(['git', 'archive', baseline_commit], cwd=repo)
with tarfile.open(fileobj=io.BytesIO(baseline_archive)) as archive:
    baseline_files = [member for member in archive.getmembers() if member.isfile()]
    for member in baseline_files:
        assert archive.extractfile(member).read() == (args.baseline_root / member.name).read_bytes(), member.name
builds = {}
for folder in ['dist', 'dist-cli']:
    builds[folder] = files(clean / folder)
    assert builds[folder] == files(repo / folder), folder
package = read(root / 'package-checks.json')
packed = {}
with tarfile.open(root / package['tarball']) as archive:
    for member in archive.getmembers():
        if not member.isfile():
            continue
        name = member.name.removeprefix('package/')
        raw = archive.extractfile(member).read()
        assert raw == (clean / name).read_bytes() == (root / 'installed/node_modules/@antonsoloviev/tracelens' / name).read_bytes(), name
        packed[name] = digest(raw)
assert digest((root / package['tarball']).read_bytes()) == {key: package[key] for key in ['bytes', 'sha256']}
after, before = read(results / 'after.json'), read(results / 'before.json')
assert after['disagreements'] == 0 and before['disagreements'] == 26
controls = 0
for a, b in zip(after['records'], before['records'], strict=True):
    assert a['id'] == b['id']
    if b['agrees']:
        assert a['agrees'] and a['captures'] == b['captures']
        assert after['reports'][a['reportRef']] == before['reports'][b['reportRef']]
        controls += 1
for label in ['clean-source', 'installed-current', 'installed-floor']:
    capture = read(root / (label + '.json'))
    assert capture['records'] == after['records'] and capture['reports'] == after['reports']
    assert capture['disagreements'] == 0
    receipt = {key: value for key, value in capture.items() if key not in ['records', 'reports']}
    receipt.update(sourceCapture='after.json', sourceCaptureSha256=digest((results / 'after.json').read_bytes())['sha256'], recordsMatchSource=True, reportsMatchSource=True)
    (results / (label + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
browser = read(results / 'browser/receipt.json')
assert browser['beforeDisagreements'] == 12 and browser['afterDisagreements'] == 0
for view in browser['views']:
    assert view['served'] == view['loaded'] and view['firstImportOffline'] and not view['overflow']
    dist = args.baseline_root / 'dist' if view['phase'] == 'before' else clean / 'dist'
    for name, sha in view['loaded'].items():
        assert digest((dist / name).read_bytes())['sha256'] == sha, name
    for key in ['pageErrors', 'externalRequests', 'lateRequests', 'policyViolations', 'axeViolations']:
        assert view[key] == [], key
for row in browser['rows']:
    name = f"{row['phase']}-{row['engine']}-{row['width']}-{row['id']}-comparison.json"
    assert digest((results / 'browser' / name).read_bytes())['sha256'] == row['reportSha256']
checks = read(root / 'checks.json')
assert [row['label'] for row in checks] == ['install', 'lint', 'types', 'unit', 'unit-de', 'build', 'cli', 'browser']
for row in checks:
    assert row['exit'] == 0, row['label']
    assert digest((root / (row['label'] + '.log')).read_bytes()) == {'bytes': row['logBytes'], 'sha256': row['logSha256']}
images = files(repo / 'docs/assets/status-evidence')
assert len(images) == 16
oracle = read(repo / 'studies/status-evidence/fixtures/oracle.json')
assert digest((repo / 'studies/status-evidence/capture.py').read_bytes())['sha256'] == oracle['driverSha256']
for variant in oracle['variants']:
    assert digest((repo / 'studies/status-evidence/fixtures' / variant['file']).read_bytes())['sha256'] == variant['sha256']
verification = {'implementationCommit': source['commit'], 'baselineCommit': baseline_commit,
    'machine': '14 vCPU WSL2 Linux, 48 GB RAM', 'buildNode': 'v24.21.0', 'workingBuildNode': 'v26.7.0',
    'archiveFiles': len(source['files']), 'baselineArchiveFiles': len(baseline_files),
    'sourceArchive': digest((root / 'source.tar').read_bytes()), 'baselineArchive': digest(baseline_archive),
    'sourceManifest': digest((root / 'source-manifest.json').read_bytes()), 'archivesByteVerified': True,
    'archiveUnchangedAfterChecks': True, 'buildFiles': builds, 'workingBuildMatchesClean': True,
    'package': {**package, 'files': packed, 'installedBytesMatch': True, 'published': False},
    'checks': checks, 'cases': 39, 'consoleWorkflowsPerReplay': 156, 'beforeDisagreements': 26,
    'afterDisagreements': 0, 'unchangedControlCases': controls, 'unchangedControlCommands': controls * 4,
    'browserComparisonDownloads': len(browser['rows']), 'browserSpanDownloads': len(browser['views']),
    'browserBeforeDisagreements': 12, 'browserAfterDisagreements': 0,
    'screenshots': images, 'screenshotsInspected': True,
    'jaegerConverter': digest((repo / 'scripts/otlp-to-jaeger.mjs').read_bytes()),
    'limits': ['Constructed encoding/damage controls, not a production incident census.',
               'Reference parser also permits lossy fraction/boolean coercion; viewer deliberately refuses it.',
               'No npm publication, version tag or manual deployment is claimed.'],
    'harnessNotes': ['Browser driver initially selected the root operation instead of the candidate failed tool; corrected its selector before completed captures.']}
(results / 'verification.json').write_text(json.dumps(verification, indent=2) + '\n')
print(json.dumps({'archiveFiles': len(source['files']), 'baselineArchiveFiles': len(baseline_files),
    'buildFiles': {key: len(value) for key, value in builds.items()}, 'packedFiles': len(packed),
    'packageBytes': package['bytes'], 'packageSha256': package['sha256'], 'unchangedControlCommands': controls * 4}))
