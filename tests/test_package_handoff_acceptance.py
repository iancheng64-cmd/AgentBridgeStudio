"""Acceptance checks for the source-only handoff archive."""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
import zipfile


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGER = PROJECT_ROOT / "scripts" / "package-handoff.py"


def source_files(directory: Path) -> set[str]:
    result = set()
    for candidate in directory.rglob("*"):
        if not candidate.is_file() or candidate.is_symlink() or candidate.suffix == ".pyc":
            continue
        if any(part in {"__pycache__", "node_modules", ".git"} for part in candidate.parts):
            continue
        result.add(candidate.relative_to(PROJECT_ROOT).as_posix())
    return result


class PackageHandoffAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tempdir = tempfile.TemporaryDirectory(prefix="agentbridge-handoff-")
        cls.archive_path = Path(cls.tempdir.name) / "AgentBridgeStudio.zip"
        subprocess.run(
            ["python3", str(PACKAGER), "--output", str(cls.archive_path)],
            check=True,
            capture_output=True,
            text=True,
        )

    @classmethod
    def tearDownClass(cls):
        cls.tempdir.cleanup()

    def test_real_archive_manifest_hashes_sidecar_and_docs_scripts_coverage(self):
        with zipfile.ZipFile(self.archive_path) as archive:
            self.assertIsNone(archive.testzip())
            names = set(archive.namelist())
            manifest = json.loads(archive.read("SOURCE_MANIFEST.json"))

            self.assertEqual(names, set(manifest) | {"SOURCE_MANIFEST.json"})
            self.assertNotIn("SOURCE_MANIFEST.json", manifest)
            for name, metadata in manifest.items():
                content = archive.read(name)
                self.assertEqual(len(content), metadata["bytes"], name)
                self.assertEqual(hashlib.sha256(content).hexdigest(), metadata["sha256"], name)
                info = archive.getinfo(name)
                self.assertFalse(stat.S_ISLNK(info.external_attr >> 16), name)

            packaged = {
                name.removeprefix("AgentBridgeStudio/")
                for name in manifest
                if name.startswith("AgentBridgeStudio/")
            }
            for directory in (
                "src",
                "tests",
                "docs",
                "scripts",
                "vendor/open-codex-computer-use/docs",
            ):
                with self.subTest(directory=directory):
                    self.assertTrue(source_files(PROJECT_ROOT / directory) <= packaged)

            self.assertTrue({"scripts/runtime-preflight.ps1", "scripts/package-handoff.py"} <= packaged)
            for document in ("docs/SPLIT_RUNTIME_RESEARCH.md", "docs/SPLIT_RUNTIME_ACCEPTANCE.md", "docs/INSTALLATION.md", "docs/RELEASING.md"):
                if (PROJECT_ROOT / document).is_file():
                    self.assertIn(document, packaged)

            forbidden_parts = {
                "node_modules",
                ".git",
                "__pycache__",
                ".build",
                "dist",
                "dist-main",
                "dist-renderer",
                "userData",
                "userdata",
                "user-data",
                "auth",
                "credentials",
                "privacy",
                "private",
                "secrets",
            }
            for name in names:
                parts = Path(name).parts
                self.assertFalse(any(part.startswith(".") for part in parts), name)
                self.assertFalse(forbidden_parts.intersection(parts), name)
                self.assertNotIn(Path(name).suffix.lower(), {".pyc", ".pem", ".key", ".p12", ".pfx"}, name)
                if "build" in parts:
                    self.assertIn(name, {"AgentBridgeStudio/build/icon.icns", "AgentBridgeStudio/build/icon.svg"})

        digest = hashlib.sha256(self.archive_path.read_bytes()).hexdigest()
        sidecar = Path(str(self.archive_path) + ".sha256").read_text(encoding="utf-8").split()
        self.assertEqual(sidecar, [digest, self.archive_path.name])

    def test_allowlist_omits_user_state_dependencies_caches_and_symlinks(self):
        with tempfile.TemporaryDirectory(prefix="agentbridge-handoff-fixture-") as temp:
            base = Path(temp)
            root = base / "repo"
            outside = base / "outside"
            outside.mkdir()
            for directory in ("src", "tests", "scripts", "docs"):
                (root / directory).mkdir(parents=True, exist_ok=True)

            (root / "scripts" / "package-handoff.py").write_bytes(PACKAGER.read_bytes())
            fixtures = {
                "README.md": "source readme",
                "package.json": "{}",
                "src" + os.sep + "main.ts": "source",
                "tests" + os.sep + "sample.test.cjs": "test",
                "scripts" + os.sep + "runtime-preflight.ps1": "script",
                "docs" + os.sep + "research.md": "research",
                ".env": "AUTH=private",
                "src" + os.sep + ".env": "AUTH=private",
                "auth" + os.sep + "credentials.json": "private",
                "userData" + os.sep + "runtime.json": "private",
                "docs" + os.sep + "auth.json": '{"token":"private"}',
                "docs" + os.sep + "privacy" + os.sep + "account.txt": "private",
                "docs" + os.sep + "private" + os.sep + "notes.txt": "private",
                "docs" + os.sep + "secrets" + os.sep + "token.txt": "private",
                "docs" + os.sep + "private-key.pem": "private",
                "node_modules" + os.sep + "pkg" + os.sep + "index.js": "dependency",
                "build" + os.sep + "cache" + os.sep + "bundle.js": "compiled",
                "src" + os.sep + "__pycache__" + os.sep + "session.pyc": "cache",
            }
            for relative, content in fixtures.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")

            (root / "build" / "icon.svg").write_text("icon", encoding="utf-8")
            (root / "vendor" / "open-codex-computer-use" / "Sources").mkdir(parents=True)
            (root / "vendor" / "open-codex-computer-use" / "Sources" / "main.swift").write_text("swift", encoding="utf-8")
            (outside / "secret.md").write_text("outside", encoding="utf-8")
            (root / "src" / "linked-secret.ts").symlink_to(outside / "secret.md")
            (root / "docs" / "linked-directory").symlink_to(outside, target_is_directory=True)
            (root / "docs" / "privacy-alias").symlink_to(root / "docs" / "privacy", target_is_directory=True)

            archive_path = base / "fixture.zip"
            subprocess.run(
                ["python3", str(root / "scripts" / "package-handoff.py"), "--output", str(archive_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            with zipfile.ZipFile(archive_path) as archive:
                names = set(archive.namelist())

            self.assertIn("AgentBridgeStudio/src/main.ts", names)
            self.assertIn("AgentBridgeStudio/scripts/runtime-preflight.ps1", names)
            self.assertIn("AgentBridgeStudio/docs/research.md", names)
            self.assertIn("AgentBridgeStudio/vendor/open-codex-computer-use/Sources/main.swift", names)
            self.assertIn("AgentBridgeStudio/build/icon.svg", names)
            for forbidden in (
                "AgentBridgeStudio/.env",
                "AgentBridgeStudio/src/.env",
                "AgentBridgeStudio/auth/credentials.json",
                "AgentBridgeStudio/userData/runtime.json",
                "AgentBridgeStudio/docs/auth.json",
                "AgentBridgeStudio/docs/privacy/account.txt",
                "AgentBridgeStudio/docs/privacy-alias/account.txt",
                "AgentBridgeStudio/docs/private/notes.txt",
                "AgentBridgeStudio/docs/secrets/token.txt",
                "AgentBridgeStudio/docs/private-key.pem",
                "AgentBridgeStudio/node_modules/pkg/index.js",
                "AgentBridgeStudio/build/cache/bundle.js",
                "AgentBridgeStudio/src/__pycache__/session.pyc",
                "AgentBridgeStudio/src/linked-secret.ts",
                "AgentBridgeStudio/docs/linked-directory/secret.md",
            ):
                self.assertNotIn(forbidden, names)

    def test_allowlisted_directory_roots_cannot_be_symlinked_outside(self):
        with tempfile.TemporaryDirectory(prefix="agentbridge-handoff-root-link-") as temp:
            base = Path(temp)
            root = base / "repo"
            outside_source = base / "outside-source"
            outside_vendor = base / "outside-vendor"
            outside_source.mkdir()
            outside_vendor.mkdir()
            (outside_source / "source-secret.ts").write_text("private", encoding="utf-8")
            (outside_vendor / "source-secret.swift").write_text("private", encoding="utf-8")

            (root / "scripts").mkdir(parents=True)
            (root / "docs").mkdir()
            (root / "tests").mkdir()
            (root / "vendor" / "open-codex-computer-use").mkdir(parents=True)
            (root / "scripts" / "package-handoff.py").write_bytes(PACKAGER.read_bytes())
            (root / "README.md").write_text("fixture", encoding="utf-8")
            (root / "src").symlink_to(outside_source, target_is_directory=True)
            (root / "vendor" / "open-codex-computer-use" / "Sources").symlink_to(
                outside_vendor, target_is_directory=True
            )

            archive_path = base / "linked-roots.zip"
            subprocess.run(
                ["python3", str(root / "scripts" / "package-handoff.py"), "--output", str(archive_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            with zipfile.ZipFile(archive_path) as archive:
                names = set(archive.namelist())

            self.assertNotIn("AgentBridgeStudio/src/source-secret.ts", names)
            self.assertNotIn(
                "AgentBridgeStudio/vendor/open-codex-computer-use/Sources/source-secret.swift", names
            )

    def test_package_command_uses_its_documented_default_output(self):
        with tempfile.TemporaryDirectory(prefix="agentbridge-handoff-default-") as temp:
            root = Path(temp) / "repo"
            (root / "scripts").mkdir(parents=True)
            (root / "scripts" / "package-handoff.py").write_bytes(PACKAGER.read_bytes())
            (root / "README.md").write_text("fixture", encoding="utf-8")

            subprocess.run(
                ["python3", str(root / "scripts" / "package-handoff.py")],
                check=True,
                capture_output=True,
                text=True,
            )

            self.assertTrue((root / "dist-handoff" / "AgentBridgeStudio-source.zip").is_file())
            self.assertTrue((root / "dist-handoff" / "AgentBridgeStudio-source.zip.sha256").is_file())


if __name__ == "__main__":
    unittest.main()
