#!/usr/bin/env python3
"""An explicit public-source allowlist, separate from internal handoff evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DOCS = {'INSTALLATION.md', 'ARCHITECTURE.md', 'RELEASING.md', 'RELEASE_NOTES.md', 'RELEASE_ACCEPTANCE.md'}
METADATA = {'README.md', 'README_EN.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.main.json', 'vite.config.ts', 'start.sh'}

def public_file(file):
    relative = file.relative_to(ROOT)
    current = ROOT
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return False
    if not file.is_file():
        return False
    if relative.as_posix() in METADATA:
        return True
    if relative.parts[:2] == ('.github', 'workflows') and len(relative.parts) == 3 and file.suffix in {'.yml', '.yaml'}:
        return True
    if any(p.startswith('.') or p in {'node_modules', '__pycache__', 'private', 'privacy', 'secrets', 'auth', 'credentials', 'userdata', 'userData'} for p in relative.parts):
        return False
    if file.suffix.lower() in {'.pem', '.key', '.p12', '.pfx', '.pyc', '.log'} or file.name in {'auth.json', 'profiles.json', 'credentials.json'}:
        return False
    if relative.parts[0] in {'src', 'tests', 'scripts'}:
        return file.suffix in {'.ts', '.tsx', '.css', '.html', '.cjs', '.py', '.ps1'}
    if len(relative.parts) == 2 and relative.parts[0] == 'docs':
        return relative.name in PUBLIC_DOCS
    if relative.as_posix() in {'build/icon.icns', 'vendor/codex/LICENSE', 'vendor/open-codex-computer-use/LICENSE', 'vendor/open-codex-computer-use/Package.swift'}:
        return True
    return relative.parts[:3] in {('vendor', 'open-codex-computer-use', 'Sources'), ('vendor', 'open-codex-computer-use', 'Tests')} and file.suffix == '.swift'

def package(output):
    # Walk only owned source trees; don't enumerate huge browser caches or private state.
    candidates = [ROOT / name for name in METADATA]
    for directory in ['src', 'tests', 'scripts', 'docs', '.github/workflows', 'vendor/open-codex-computer-use/Sources', 'vendor/open-codex-computer-use/Tests']:
        candidates.extend((ROOT / directory).rglob('*'))
    candidates.extend(ROOT / name for name in ['build/icon.icns', 'vendor/codex/LICENSE', 'vendor/open-codex-computer-use/LICENSE', 'vendor/open-codex-computer-use/Package.swift'])
    files = {p.relative_to(ROOT).as_posix(): p.read_bytes() for p in candidates if public_file(p)}
    manifest = {name: {'bytes':len(data), 'sha256':hashlib.sha256(data).hexdigest()} for name,data in sorted(files.items())}
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name,data in sorted(files.items()): archive.writestr('AgentBridgeStudio/' + name, data)
        archive.writestr('AgentBridgeStudio/SOURCE_MANIFEST.json', json.dumps(manifest, indent=2) + '\n')
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        for name,item in manifest.items(): assert hashlib.sha256(archive.read('AgentBridgeStudio/' + name)).hexdigest() == item['sha256']
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(digest + '  ' + output.name + '\n')
    return {'files':len(files), 'bytes':output.stat().st_size, 'sha256':digest, 'path':str(output)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    print(json.dumps(package(args.output or ROOT / f'dist-public/AgentBridgeStudio-{version}-source.zip'), indent=2))
