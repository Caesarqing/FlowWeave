import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path('/Users/qingpeng/.codex/worktrees/static-loading-rebuild/FlowWeave')
OUT = Path('/tmp/flowweave-a5-current-source-2026-10-09-de5xb2k2')
MIRROR = OUT / 'source'
EVIDENCE = ROOT / 'docs/evidence/static-graph-generalization/A5-current-source-local-package-2026-10-09-de5xb2k2'
SOURCE_ITEMS = ['src', 'scripts', 'tests', 'logo', 'flowweave-plugin', 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'index.html', 'vitest.config.ts', 'LICENSE.txt']
REPORT = {'task': 'A5 current-source local arm64 package', 'date': '2026-10-09', 'sourceRoot': str(ROOT), 'sourceMirror': str(MIRROR), 'outputDirectory': str(OUT), 'commands': [], 'sourceItems': SOURCE_ITEMS, 'formalDistribution': False, 'notarized': False, 'status': 'running'}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root: Path, items: list[str]) -> list[dict]:
    result = []
    for item in items:
        entry = root / item
        candidates = sorted(entry.rglob('*')) if entry.is_dir() else [entry]
        for path in candidates:
            if path.is_symlink():
                result.append({'path': str(path.relative_to(root)), 'symlink': os.readlink(path)})
            elif path.is_file():
                result.append({'path': str(path.relative_to(root)), 'bytes': path.stat().st_size, 'sha256': sha(path)})
    return sorted(result, key=lambda row: row['path'])


def save() -> None:
    (EVIDENCE / 'summary.json').write_text(json.dumps(REPORT, indent=2) + '\n')


def write_inventory(name: str, data: list[dict]) -> dict:
    path = EVIDENCE / name
    path.write_text(json.dumps(data, indent=2) + '\n')
    return {'path': str(path), 'sha256': sha(path), 'entryCount': len(data)}


def run(name: str, args: list[str], cwd: Path, env: dict[str, str], timeout: int) -> None:
    log_path = EVIDENCE / (name + '.log')
    start = time.monotonic()
    with log_path.open('w') as log:
        result = subprocess.run(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    entry = {'name': name, 'argv': args, 'cwd': str(cwd), 'exitCode': result.returncode, 'elapsedSeconds': round(time.monotonic() - start, 3), 'log': str(log_path), 'logSha256': sha(log_path)}
    REPORT['commands'].append(entry)
    save()
    print(json.dumps(entry), flush=True)
    if result.returncode != 0:
        REPORT['status'] = 'failed'
        REPORT['error'] = f'{name} failed with exit code {result.returncode}; log: {log_path}'
        save()
        raise RuntimeError(REPORT['error'])


EVIDENCE.mkdir()
MIRROR.mkdir()
shutil.copy2(__file__, EVIDENCE / 'build-and-verify.py')
source_before = inventory(ROOT, SOURCE_ITEMS)
REPORT['sourceManifest'] = write_inventory('source-manifest.json', source_before)
REPORT['gitHead'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
(EVIDENCE / 'source-git-status.txt').write_text(subprocess.check_output(['git', 'status', '--short', '--branch'], cwd=ROOT, text=True))
REPORT['sourceGitStatus'] = str(EVIDENCE / 'source-git-status.txt')
protected_items = ['out', 'release/mac-arm64/FlowWeave.app']
protected_before = inventory(ROOT, protected_items)
REPORT['originalOutputManifestBefore'] = write_inventory('original-output-manifest-before.json', protected_before)
for item in SOURCE_ITEMS:
    source = ROOT / item
    target = MIRROR / item
    if source.is_dir():
        shutil.copytree(source, target, symlinks=True)
    else:
        shutil.copy2(source, target)
if inventory(MIRROR, SOURCE_ITEMS) != source_before:
    raise RuntimeError('Source changed during snapshot or mirror differs from source manifest.')
REPORT['sourceMirrorMatchesSnapshot'] = True
REPORT['environment'] = {'os': subprocess.check_output(['sw_vers', '-productVersion'], text=True).strip(), 'architecture': subprocess.check_output(['uname', '-m'], text=True).strip(), 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'npm': subprocess.check_output(['npm', '--version'], text=True).strip()}
save()
env = os.environ.copy()
run('copy-installed-dependencies', ['/usr/bin/ditto', str(ROOT / 'node_modules'), str(MIRROR / 'node_modules')], ROOT, env, 180)
run('build-current-arm64', ['npm', 'run', 'dist:mac:arm64', '--', '--config.npmRebuild=false'], MIRROR, env, 300)
unsigned = MIRROR / 'release/mac-arm64/FlowWeave.app'
signed = OUT / 'signed/FlowWeave.app'
signed.parent.mkdir()
run('copy-built-app', ['/usr/bin/ditto', str(unsigned), str(signed)], MIRROR, env, 120)
REPORT['unsignedApp'] = str(unsigned)
REPORT['signedApp'] = str(signed)
REPORT['unsignedArtifactHashes'] = {'appAsarSha256': sha(unsigned / 'Contents/Resources/app.asar'), 'executableSha256': sha(unsigned / 'Contents/MacOS/FlowWeave')}
run('adhoc-sign', ['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(signed)], MIRROR, env, 120)
run('strict-verify', ['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(signed)], MIRROR, env, 120)
run('signature-metadata', ['/usr/bin/codesign', '--display', '--verbose=4', str(signed)], MIRROR, env, 120)
REPORT['artifact'] = {'path': str(signed), 'architecture': 'arm64', 'signature': 'ad-hoc', 'notarized': False, 'appAsarSha256': sha(signed / 'Contents/Resources/app.asar'), 'executableSha256': sha(signed / 'Contents/MacOS/FlowWeave')}
REPORT['resourcesManifest'] = write_inventory('resources-manifest.json', inventory(signed, ['Contents/Resources']))
REPORT['smokeUserData'] = 'Harness creates unique temporary fresh userData and synthetic fixture per run; fixture data is removed by the harness after each run.'
REPORT['smokeReports'] = []
for fixture in ['edges', 'empty', 'four-languages', 'save-failure', 'tab-switch', 'viewport-only', 'details-race']:
    report_path = EVIDENCE / ('graph-smoke-' + fixture + '.json')
    smoke_env = dict(env, FLOWWEAVE_PACKAGED_EXECUTABLE=str(signed / 'Contents/MacOS/FlowWeave'), FLOWWEAVE_GRAPH_SMOKE_EVIDENCE_PATH=str(report_path), FLOWWEAVE_GRAPH_SMOKE_FIXTURE=fixture)
    run('graph-smoke-' + fixture, ['node', 'scripts/run-graph-smoke.mjs'], MIRROR, smoke_env, 180)
    REPORT['smokeReports'].append({'fixture': fixture, 'path': str(report_path), 'sha256': sha(report_path), 'exitCode': 0})
    save()
REPORT['sourceStillMatchesSnapshot'] = inventory(ROOT, SOURCE_ITEMS) == source_before
protected_after = inventory(ROOT, protected_items)
REPORT['originalOutputManifestAfter'] = write_inventory('original-output-manifest-after.json', protected_after)
REPORT['originalOutputsUnchanged'] = protected_after == protected_before
REPORT['status'] = 'passed' if REPORT['sourceStillMatchesSnapshot'] and REPORT['originalOutputsUnchanged'] else 'source-or-protected-output-changed-during-run'
REPORT['limitations'] = ['Local ad-hoc arm64 test package; no Developer ID or notarization.', 'No claim of native keyboard or human visual review; graph smoke uses existing automated input.', 'Installed dependencies were copied; no dependency installation, native rebuild or corpus project build executed.', 'Build embeds its current VITE_BUILD_TIME, so its app.asar need not equal prior build hashes.']
save()
if REPORT['status'] != 'passed':
    raise RuntimeError(REPORT['status'])
print('A5_CURRENT_REPORT=' + str(EVIDENCE / 'summary.json'), flush=True)
