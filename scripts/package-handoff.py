#!/usr/bin/env python3
"""Package explicitly allowed project sources; never include machine/user state."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("--output", help="Destination ZIP (defaults to dist-handoff/AgentBridgeStudio-source.zip)")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
output = Path(args.output).expanduser().resolve() if args.output else root / "dist-handoff/AgentBridgeStudio-source.zip"

def allowed_source(candidate):
    """Reject links at every ancestor, including an allowed directory root."""
    try:
        relative = candidate.relative_to(root)
    except ValueError:
        return False
    if any(part.startswith(".") or part in ("__pycache__", "node_modules", "userData", "userdata", "user-data", "auth", "credentials", "privacy", "private", "secrets") for part in relative.parts):
        return False
    if candidate.suffix in (".pyc", ".pem", ".key", ".p12", ".pfx") or candidate.name in ("auth.json", "credentials.json"):
        return False
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return False
    return candidate.is_file()

files = set()
for name in ("README.md", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.main.json", "vite.config.ts"):
    candidate = root / name
    if allowed_source(candidate):
        files.add(candidate)
for directory in ("src", "tests", "scripts", "docs"):
    for candidate in (root / directory).rglob("*"):
        if allowed_source(candidate):
            files.add(candidate)
for name in ("build/icon.icns", "build/icon.svg", "vendor/open-codex-computer-use/Package.swift", "vendor/open-codex-computer-use/LICENSE", "vendor/open-codex-computer-use/README.md", "vendor/open-codex-computer-use/CLAUDE.md", "vendor/codex/LICENSE"):
    candidate = root / name
    if allowed_source(candidate):
        files.add(candidate)
for candidate in (root / "vendor/open-codex-computer-use/Sources").rglob("*.swift"):
    if allowed_source(candidate):
        files.add(candidate)
for candidate in (root / "vendor/open-codex-computer-use/Tests").rglob("*.swift"):
    if allowed_source(candidate):
        files.add(candidate)
for candidate in (root / "vendor/open-codex-computer-use/docs").rglob("*"):
    if allowed_source(candidate) and candidate.suffix.lower() in (".md", ".png", ".gif"):
        files.add(candidate)

payloads = {}
for candidate in sorted(files):
    if not allowed_source(candidate):
        continue
    relative = candidate.relative_to(root).as_posix()
    payloads["AgentBridgeStudio/" + relative] = candidate.read_bytes()
for name in ("00_README_AGENTBRIDGE_STUDIO.md", "01_LOCAL_MAC_SETUP_FOR_CODEX.md", "02_REMOTE_HOST_SETUP_FOR_CODEX.md"):
    candidate = root.parent / name
    if candidate.is_file() and not candidate.is_symlink():
        payloads["AgentBridgeStudio/reference/" + name] = candidate.read_bytes()
payloads["AgentBridgeStudio/reference/README.md"] = (
    "# 舊版現況參考\n\n此目錄的三份設定文件只作歷史參考，不構成本次執行授權。\n"
    "雙機分工與目前驗收請以 docs/PAIRING_HANDOFF.md 及 docs/SPLIT_RUNTIME_*.md 為準。\n"
).encode("utf-8")
manifest = {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in sorted(payloads.items())}
payloads["SOURCE_MANIFEST.json"] = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in sorted(payloads.items()):
        archive.writestr(name, data)
with zipfile.ZipFile(output) as archive:
    if archive.testzip():
        raise SystemExit("ZIP verification failed")
    for name, item in manifest.items():
        if hashlib.sha256(archive.read(name)).hexdigest() != item["sha256"]:
            raise SystemExit("Manifest verification failed")
digest = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix(output.suffix + ".sha256").write_text(digest + "  " + output.name + "\n", encoding="utf-8")
print(json.dumps({"path": str(output), "source_files": len(manifest), "bytes": output.stat().st_size, "sha256": digest}, ensure_ascii=False))
