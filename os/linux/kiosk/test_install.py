import hashlib, importlib.util, json, pathlib, tempfile, unittest
from unittest import mock
spec = importlib.util.spec_from_file_location('installer', pathlib.Path(__file__).with_name('install.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class Integrity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.bundle = pathlib.Path(self.tmp.name)
        files = {'payload/ha.view': b'\x7fELFtest', 'payload/chrome-sandbox': b'sandbox',
                 'payload/resources/app/package.json': b'{"version":"1.6.0"}',
                 'supervisor.py': b'test', 'install.py': b'test', 'install.sh': b'test'}
        entries = []
        for name, data in files.items():
            p = self.bundle / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)
            entries.append(dict(path=name, size=len(data), sha256=hashlib.sha256(data).hexdigest()))
        self.manifest = dict(schema=1, platform='linux', arch={'x86_64':'x64','aarch64':'arm64'}.get(m.platform.machine()), version='1.6.0', files=entries)
        self.save()
    def save(self): (self.bundle / 'manifest.json').write_text(json.dumps(self.manifest))
    def tearDown(self): self.tmp.cleanup()
    def test_valid(self): self.assertEqual(m.verify(self.bundle)['version'], '1.6.0')
    def test_manifested_direct_launcher(self):
        data = b'#!/bin/sh\nexec "$0/payload/ha.view" "$@"\n'
        (self.bundle / 'Run.sh').write_bytes(data)
        self.manifest['files'].append(dict(path='Run.sh', size=len(data), sha256=hashlib.sha256(data).hexdigest()))
        self.save()
        self.assertEqual(m.verify(self.bundle)['version'], '1.6.0')
        (self.bundle / 'Run.sh').write_bytes(b'corrupt')
        with self.assertRaises(ValueError): m.verify(self.bundle)

    def test_corrupt(self):
        (self.bundle / 'supervisor.py').write_text('changed')
        with self.assertRaises(ValueError): m.verify(self.bundle)
    def test_extra_recursive(self):
        (self.bundle / 'payload/secret').write_text('no')
        with self.assertRaises(ValueError): m.verify(self.bundle)
    def test_traversal(self):
        self.manifest['files'][0]['path'] = '../outside'; self.save()
        with self.assertRaises(ValueError): m.verify(self.bundle)
    def test_duplicate(self):
        self.manifest['files'].append(self.manifest['files'][0]); self.save()
        with self.assertRaises(ValueError): m.verify(self.bundle)
    def test_symlink(self):
        p = self.bundle / 'supervisor.py'; p.unlink(); p.symlink_to('install.py')
        with self.assertRaises(ValueError): m.verify(self.bundle)
    def test_architecture(self):
        self.manifest['arch'] = 'wrong'; self.save()
        with self.assertRaises(ValueError): m.verify(self.bundle)
    def test_version(self):
        self.manifest['version'] = 'different'; self.save()
        with self.assertRaises(ValueError): m.verify(self.bundle)

class ProcessScan(unittest.TestCase):
    def test_unreadable_process_is_skipped(self):
        # Updates scan /proc before stopping owned processes. One unreadable
        # entry (another user's process under ptrace restrictions) must not
        # abort the scan or the update.
        with mock.patch.object(pathlib.Path, 'read_text', side_effect=PermissionError(13, 'Permission denied')):
            self.assertIsNone(m.process_identity(1))
        with mock.patch.object(pathlib.Path, 'iterdir', return_value=iter([pathlib.Path('/proc/1')])), \
                mock.patch.object(pathlib.Path, 'read_text', side_effect=PermissionError(13, 'Permission denied')):
            self.assertEqual(m.processes(), [])
