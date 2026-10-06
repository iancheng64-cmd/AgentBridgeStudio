#!/usr/bin/env python3
"""Seal a completed local bundle after all payload copies; ad-hoc is not Developer ID."""
import argparse
import json
from pathlib import Path
import plistlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("bundle", help="Completed AgentBridge Studio.app bundle")
args = parser.parse_args()
bundle = Path(args.bundle).resolve()
info_path = bundle / "Contents/Info.plist"
if bundle.name != "AgentBridge Studio.app" or not info_path.is_file():
    raise SystemExit("Expected a completed AgentBridge Studio.app bundle")
info = plistlib.loads(info_path.read_bytes())
identifier = info.get("CFBundleIdentifier")
if identifier != "com.agentbridge.studio":
    raise SystemExit("Unexpected bundle identity")
if not (bundle / "Contents/Resources/app.asar").is_file():
    raise SystemExit("Application payload is missing")
# Electron's copied executable signature cannot seal the final application payload.
# Deep signing keeps nested code self-consistent; run only after every file copy.
subprocess.run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", "--identifier", identifier, "--timestamp=none", str(bundle)], check=True)
subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(bundle)], check=True)
print(json.dumps({"bundle": str(bundle), "version": info.get("CFBundleShortVersionString"), "identifier": identifier, "signature": "ad-hoc", "strictVerification": True}))
