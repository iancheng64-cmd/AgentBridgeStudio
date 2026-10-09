import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

PACKAGER = Path(__file__).resolve().parents[1] / 'scripts/package-public.py'
spec = importlib.util.spec_from_file_location('public_packager', PACKAGER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PublicPackaging(unittest.TestCase):
    def test_private_evidence_and_symlink_ancestors_are_excluded_but_github_metadata_is_kept(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'source'
            previous = module.ROOT
            module.ROOT = root
            try:
                for name in ['README.md', 'start.sh', '.gitignore', '.github/workflows/release.yml', 'src/main/app.ts', 'docs/INSTALLATION.md', 'docs/evidence/account.json', 'docs/CLEANUP.json', 'src/private/secret.ts', 'src/auth.json', '.env', 'build/runtime-browsers/browser.bin']:
                    file = root / name
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_text('fixture')
                (root / 'start.sh').chmod(0o755)
                outside = Path(temp) / 'outside'
                outside.mkdir()
                (outside / 'secret.ts').write_text('private fixture')
                (root / 'src/link').symlink_to(outside, target_is_directory=True)
                output = Path(temp) / 'public.zip'
                module.package(output)
                with zipfile.ZipFile(output) as archive:
                    names = set(archive.namelist())
                    self.assertEqual(archive.getinfo('AgentBridgeStudio/start.sh').external_attr >> 16 & 0o777, 0o755)
                self.assertIn('AgentBridgeStudio/.gitignore', names)
                self.assertIn('AgentBridgeStudio/.github/workflows/release.yml', names)
                self.assertIn('AgentBridgeStudio/src/main/app.ts', names)
                self.assertIn('AgentBridgeStudio/docs/INSTALLATION.md', names)
                self.assertEqual(len(names), 7)  # Six public inputs + manifest.
            finally:
                module.ROOT = previous

if __name__ == '__main__': unittest.main()
