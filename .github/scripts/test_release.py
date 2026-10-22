"""Offline tests for the one-shot publisher: input never reaches network if invalid."""
import hashlib
from importlib.machinery import SourceFileLoader
from pathlib import Path
import tempfile
import unittest

publisher = SourceFileLoader('publisher', str(Path(__file__).with_name('publish-release.py'))).load_module()


class ReleaseInputTests(unittest.TestCase):
    def test_two_archives_and_sidecars_are_required(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            for name in publisher.NAMES:
                data = name.encode()
                (path / name).write_bytes(data)
                (path / (name + '.sha256')).write_text(f'{hashlib.sha256(data).hexdigest()}  {name}\n')
            self.assertEqual(len(publisher.verify(path)), 4)
            first = path / publisher.NAMES[0]
            first.write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'SHA-256 mismatch'):
                publisher.verify(path)

    def test_unexpected_assets_and_incomplete_sidecars_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            with self.assertRaisesRegex(RuntimeError, 'Missing'):
                publisher.verify(path)
            for name in publisher.NAMES:
                (path / name).write_bytes(b'payload')
                (path / (name + '.sha256')).write_text(f"{hashlib.sha256(b'payload').hexdigest()}  wrong\n")
            with self.assertRaisesRegex(RuntimeError, 'Invalid SHA-256'):
                publisher.verify(path)
            for name in publisher.NAMES:
                (path / (name + '.sha256')).write_text(f"{hashlib.sha256(b'payload').hexdigest()}  {name}\n")
            (path / 'unexpected.txt').write_text('no')
            with self.assertRaisesRegex(RuntimeError, 'Unexpected'):
                publisher.verify(path)


if __name__ == '__main__':
    unittest.main()
