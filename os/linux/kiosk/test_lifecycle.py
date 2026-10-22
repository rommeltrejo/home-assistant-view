"""Focused lifecycle tests. Native /proc/waitid checks run on Linux, not macOS."""
import contextlib, importlib.util, io, os, pathlib, signal, subprocess, sys, tempfile, time, unittest
from unittest import mock
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
import install as installer
import supervisor


class Transactions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / 'current'
        self.previous = self.root.with_name('current.previous')
        for path, value in ((self.root, 'current'), (self.previous, 'previous')):
            path.mkdir(); (path / 'value').write_text(value)
        self.patch = mock.patch.object(installer, 'ROOT', self.root); self.patch.start()
    def tearDown(self): self.patch.stop(); self.tmp.cleanup()
    def test_rollback_failure_each_rename_restores_both_versions(self):
        original = pathlib.Path.rename
        for failed_call in (1, 2, 3):
            calls = 0
            def rename(path, target):
                nonlocal calls
                calls += 1
                if calls == failed_call: raise OSError('injected rename failure')
                return original(path, target)
            with mock.patch.object(installer, 'owned', return_value=True), mock.patch.object(installer, 'verify'), mock.patch.object(pathlib.Path, 'rename', rename):
                with self.assertRaises(OSError): installer.rollback()
            self.assertEqual((self.root / 'value').read_text(), 'current')
            self.assertEqual((self.previous / 'value').read_text(), 'previous')
            self.assertFalse(self.root.with_name('current.swap').exists())
    def test_rollback_success(self):
        with mock.patch.object(installer, 'owned', return_value=True), mock.patch.object(installer, 'verify'):
            installer.rollback()
        self.assertEqual((self.root / 'value').read_text(), 'previous')
        self.assertEqual((self.previous / 'value').read_text(), 'current')
    def test_deploy_promotion_failure_preserves_versions(self):
        source = pathlib.Path(self.tmp.name) / 'bundle'; source.mkdir()
        (source / 'payload').mkdir(); (source / 'payload/chrome-sandbox').write_text('helper')
        original = pathlib.Path.rename
        def rename(path, target):
            if path.name.startswith('.ha.view-stage-'): raise OSError('injected promotion failure')
            return original(path, target)
        with mock.patch.object(installer, 'owned', return_value=True), mock.patch.object(installer, 'verify'), mock.patch.object(installer.os, 'chown'), mock.patch.object(pathlib.Path, 'rename', rename):
            with self.assertRaises(OSError): installer.deploy(source, True)
        self.assertEqual((self.root / 'value').read_text(), 'current')
        self.assertEqual((self.previous / 'value').read_text(), 'previous')
        self.assertFalse(self.root.with_name('current.retired').exists())


def identity(pid=42, **changes):
    p = dict(pid=pid, state='S', ppid=1, group=pid, start='123', uid=1000,
             uids=('1000',)*4, exe='/opt/ha.view-kiosk/payload/ha.view', cmd=[b'app'])
    p.update(changes); return p


class Ownership(unittest.TestCase):
    def test_foreign_group_never_signalled(self):
        p = identity(); foreign = identity(43, group=42, exe='/usr/bin/sleep')
        with mock.patch.object(installer, 'processes', return_value=[p, foreign]), mock.patch.object(installer, 'stop_processes') as stop:
            with self.assertRaises(ValueError): installer.stop_owned()
            stop.assert_not_called()
    def test_uid_mismatch_never_signalled(self):
        p = identity(); other = identity(43, group=42, uid=1001, uids=('1001',)*4)
        with mock.patch.object(installer, 'processes', return_value=[p, other]), mock.patch.object(installer, 'stop_processes') as stop:
            with self.assertRaises(ValueError): installer.stop_owned()
            stop.assert_not_called()
    def test_supervisor_before_payload(self):
        s = identity(40, exe=os.path.realpath('/usr/bin/python3'), cmd=[b'/usr/bin/python3', b'/opt/ha.view-kiosk/supervisor.py'])
        p = identity(ppid=40)
        with mock.patch.object(installer, 'processes', side_effect=[[s, p], []]), mock.patch.object(installer, 'stop_processes') as stop:
            installer.stop_owned()
            self.assertEqual(stop.call_args_list, [mock.call([s]), mock.call([p])])
    def test_reused_pid_rejected(self):
        p = identity()
        with mock.patch.object(installer.os, 'pidfd_open', create=True, return_value=91), mock.patch.object(installer.os, 'close'), mock.patch.object(installer, 'process_identity', return_value=identity(start='999')), mock.patch.object(installer.signal, 'pidfd_send_signal', create=True) as send:
            with self.assertRaises(ValueError): installer.signal_identity(p, signal.SIGTERM)
            send.assert_not_called()
    def test_unrelated_python_not_owned(self):
        self.assertFalse(installer.supervisor_identity(identity(exe='/usr/bin/python3', cmd=[b'/usr/bin/python3', b'/tmp/supervisor.py'])))
        self.assertFalse(installer.payload_identity(identity(uid=0)))
        self.assertFalse(installer.payload_identity(identity(exe='/opt/ha.view-kiosk/payload/ha.view (deleted)')))

    def test_legacy_supervisor_spelling_and_zombie_stop(self):
        s = identity(40, exe=os.path.realpath('/usr/bin/python3'),
                     cmd=[b'python3', os.fsencode(installer.ROOT / 'supervisor.py')])
        z = identity(ppid=40, state='Z', exe='', cmd=[])
        self.assertTrue(installer.supervisor_identity(s))
        with mock.patch.object(installer, 'processes', side_effect=[[s, z], []]), mock.patch.object(installer, 'stop_processes') as stop:
            installer.stop_owned()
            self.assertEqual(stop.call_args_list[0], mock.call([s]))
    def test_supervisor_exact_args_and_interpreter_required(self):
        script = os.fsencode(installer.ROOT / 'supervisor.py')
        for cmd in ([b'python3', script, b'--extra'], [b'python3'],
                    [b'python3', b'/tmp/supervisor.py'], [b'python', script],
                    [b'/tmp/python3', script], [b'python3', b'-c', script]):
            self.assertFalse(installer.supervisor_identity(identity(exe='/usr/bin/python3', cmd=cmd)))
        for exe in ('/tmp/python3', '/usr/bin/python3 (deleted)'):
            self.assertFalse(installer.supervisor_identity(identity(exe=exe, cmd=[b'python3', script])))
        self.assertFalse(installer.supervisor_identity(identity(uid=0, uids=('0',)*4, exe='/usr/bin/python3', cmd=[b'python3', script])))
        self.assertFalse(installer.supervisor_identity(identity(uids=('1000','1001','1000','1000'), exe='/usr/bin/python3', cmd=[b'python3', script])))
    def test_changed_uid_credentials_not_signalled(self):
        p = identity()
        with mock.patch.object(installer.os, 'pidfd_open', create=True, return_value=91), mock.patch.object(installer.os, 'close'), mock.patch.object(installer, 'process_identity', return_value=identity(uids=('1000','1001','1000','1000'))), mock.patch.object(installer.signal, 'pidfd_send_signal', create=True) as send:
            with self.assertRaises(ValueError): installer.signal_identity(p, signal.SIGTERM)
            send.assert_not_called()


class SessionLocks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.tmp.name) / 'lock'
        self.path.write_bytes(b'legacy'); self.path.chmod(0o664)
    def tearDown(self): self.tmp.cleanup()
    def test_legacy_mode_migrates_same_inode_without_truncation(self):
        inode = self.path.stat().st_ino
        with supervisor.session_lock(self.path) as fd:
            self.assertEqual(os.fstat(fd).st_mode & 0o7777, 0o600)
            self.assertEqual(self.path.stat().st_ino, inode)
            self.assertEqual(self.path.read_bytes(), b'legacy')
    def test_live_lock_is_not_migrated(self):
        with self.path.open('r+') as holder:
            supervisor.fcntl.flock(holder, supervisor.fcntl.LOCK_EX | supervisor.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError), supervisor.session_lock(self.path): pass
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o664)
    def test_symlink_and_hardlink_refused(self):
        alias = self.path.with_name('alias'); alias.symlink_to(self.path)
        with self.assertRaises(OSError), supervisor.session_lock(alias): pass
        alias.unlink(); os.link(self.path, alias)
        with self.assertRaises(RuntimeError), supervisor.session_lock(self.path): pass
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o664)
    def test_foreign_owner_refused_without_chmod(self):
        with mock.patch.object(supervisor.os, 'getuid', return_value=os.getuid()+1), mock.patch.object(supervisor.os, 'fchmod') as chmod:
            with self.assertRaises(RuntimeError), supervisor.session_lock(self.path): pass
            chmod.assert_not_called()
    def test_substitution_after_flock_refused_without_chmod(self):
        flock = supervisor.fcntl.flock
        def substitute(fd, flags):
            flock(fd, flags)
            self.path.rename(self.path.with_name('original'))
            self.path.write_bytes(b'replacement'); self.path.chmod(0o664)
        with mock.patch.object(supervisor.fcntl, 'flock', side_effect=substitute), mock.patch.object(supervisor.os, 'fchmod') as chmod:
            with self.assertRaises(RuntimeError), supervisor.session_lock(self.path): pass
            chmod.assert_not_called()
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o664)


@unittest.skipUnless(sys.platform == 'linux', 'requires Linux waitid and /proc')
class NativeLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.path = pathlib.Path(self.tmp.name) / 'payload'
        self.log = tempfile.TemporaryFile(mode='w+')
    def tearDown(self): self.log.close(); self.tmp.cleanup()
    def payload(self, body):
        self.path.write_text('#!/usr/bin/python3\n' + body); self.path.chmod(0o755)
    def run_payload(self, stopping=lambda: False, **kwargs):
        return supervisor.run(self.path, self.log, stopping, probe=.1, backoff=lambda _: .05,
                              gate=contextlib.nullcontext, **kwargs)
    def test_intentional_quit_no_restart(self):
        count = pathlib.Path(self.tmp.name) / 'count'
        self.payload("from pathlib import Path\np=Path(%r)\np.write_text(p.read_text()+'x' if p.exists() else 'x')\n" % str(count))
        messages=[]; self.assertEqual(self.run_payload(notify=messages.append), 0)
        self.assertEqual(count.read_text(), 'x'); self.assertIn('FAILED early payload exit=0', messages)
    def test_crashes_bounded_and_reaped(self):
        count = pathlib.Path(self.tmp.name) / 'count'
        self.payload("from pathlib import Path\np=Path(%r)\np.write_text(p.read_text()+'x' if p.exists() else 'x')\nraise SystemExit(7)\n" % str(count))
        self.assertEqual(self.run_payload(), 1); self.assertEqual(count.read_text(), 'xxxxx')
        with self.assertRaises(ChildProcessError): os.waitpid(-1, os.WNOHANG)
    def test_term_during_running_child_reaps(self):
        self.payload('import time\ntime.sleep(60)\n')
        deadline=time.monotonic()+.25; messages=[]
        self.assertEqual(self.run_payload(lambda: time.monotonic() >= deadline, notify=messages.append), 0)
        self.assertEqual(messages, ['READY'])
        with self.assertRaises(ChildProcessError): os.waitpid(-1, os.WNOHANG)
    def test_term_during_backoff(self):
        self.payload('raise SystemExit(8)\n'); deadline=time.monotonic()+.15
        start=time.monotonic()
        self.assertEqual(supervisor.run(self.path, self.log, lambda: time.monotonic()>=deadline,
                         gate=contextlib.nullcontext, backoff=lambda _: 30), 0)
        self.assertLess(time.monotonic()-start, 1)
    def test_stubborn_child_escalated_and_reaped(self):
        child=subprocess.Popen(['/usr/bin/python3', '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'], start_new_session=True)
        time.sleep(.1); start=time.monotonic(); supervisor.terminate(child, grace=.1)
        self.assertEqual(child.returncode, -signal.SIGKILL); self.assertLess(time.monotonic()-start, 1)
    def test_actual_signal_repeated_while_polling(self):
        self.payload('import time\ntime.sleep(60)\n')
        runner = "import sys,signal;sys.path.insert(0,%r);import supervisor,contextlib,io;intent=False\ndef stop(*_):\n global intent\n intent=True\nsignal.signal(signal.SIGTERM,stop);supervisor.run(%r,open('/dev/null','w'),lambda:intent,gate=contextlib.nullcontext)" % (str(HERE.resolve()),str(self.path))
        child=subprocess.Popen(['/usr/bin/python3','-c',runner])
        try:
            time.sleep(.2)
            for _ in range(3): child.send_signal(signal.SIGTERM); time.sleep(.01)
            self.assertEqual(child.wait(timeout=3), 0)
        finally:
            if child.poll() is None: child.kill(); child.wait()


class BootPauseLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # macOS tempfile paths use /var -> /private/var. Resolve the trusted
        # fixture root, not production paths or the deliberately unsafe links.
        self.root = pathlib.Path(self.tmp.name).resolve(strict=True)
        self.boot = '11111111-1111-4111-8111-111111111111'
        self.pause = supervisor.BootPause(self.root / 'pause', boot=lambda: self.boot)
    def tearDown(self): self.tmp.cleanup()
    @unittest.skipUnless(sys.platform == 'linux', 'requires Linux waitid/process groups')
    def test_exit42_persists_across_new_supervisor_and_only_reboot_resumes(self):
        payload = self.root / 'payload'; count = self.root / 'count'
        payload.write_text("#!/usr/bin/python3\nfrom pathlib import Path\np=Path(%r)\np.write_text(p.read_text()+'x' if p.exists() else 'x')\nraise SystemExit(42)\n" % str(count))
        payload.chmod(0o755)
        messages = []
        with tempfile.TemporaryFile(mode='w+') as log:
            def run(pause):
                return supervisor.run(payload, log, lambda: False, notify=messages.append,
                                      gate=contextlib.nullcontext, pause=pause)
            self.assertEqual(run(self.pause), 0)
            self.assertEqual(count.read_text(), 'x')
            fresh = supervisor.BootPause(self.pause.path, boot=lambda: self.boot)
            self.assertEqual(run(fresh), 0)
            self.assertEqual(count.read_text(), 'x')
            unrelated = self.pause.path / 'unrelated'; unrelated.write_text('keep')
            self.boot = '22222222-2222-4222-8222-222222222222'
            self.assertEqual(run(fresh), 0)
            self.assertEqual(count.read_text(), 'xx')
            self.assertEqual(unrelated.read_text(), 'keep')
        self.assertEqual(messages, ['PAUSED until OS restart'] * 3)
    def test_links_foreign_modes_and_invalid_records_fail_closed(self):
        self.pause.persist(); record = self.pause.path / 'pause.json'
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)
        record.chmod(0o644)
        with self.assertRaises(RuntimeError): self.pause.paused()
        record.chmod(0o600); record.write_text('{}')
        with self.assertRaises(RuntimeError): self.pause.persist()
        record.unlink(); record.symlink_to(self.root / 'missing')
        with self.assertRaises(OSError): self.pause.paused()
        with self.assertRaises(OSError): self.pause.persist()
        record.unlink(); self.pause.persist()
        os.link(record, self.root / 'hardlink')
        with self.assertRaises(RuntimeError): self.pause.paused()
    def test_directory_links_and_foreign_owner_rejected(self):
        target = self.root / 'target'; target.mkdir(mode=0o700)
        self.pause.path.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError): self.pause.persist()
        self.pause.path.unlink(); self.pause.persist()
        with mock.patch.object(supervisor.os, 'getuid', return_value=os.getuid()+1):
            with self.assertRaises(RuntimeError): self.pause.paused()
    def test_atomic_failure_preserves_record_and_unrelated_files(self):
        self.pause.persist(); record = self.pause.path / 'pause.json'; before = record.read_bytes()
        with mock.patch.object(supervisor.os, 'replace', side_effect=OSError('fixture failure')):
            with self.assertRaises(OSError): self.pause.persist()
        self.assertEqual(record.read_bytes(), before)
        self.assertEqual(list(self.pause.path.iterdir()), [record])


class StartupReporting(unittest.TestCase):
    def test_installer_does_not_print_success_on_failed_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            with mock.patch.object(sys, 'argv', ['install.py']), mock.patch.object(installer, 'verify'), mock.patch.object(installer.os, 'geteuid', return_value=1000), mock.patch.object(installer.subprocess, 'run'), mock.patch.object(installer.subprocess, 'Popen') as launch, mock.patch.object(installer.select, 'select', return_value=([1], [], [])), mock.patch.object(installer.os, 'read', return_value=b'FAILED early payload exit=7\n'), mock.patch.object(pathlib.Path, 'home', return_value=home), mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': str(home / 'config'), 'DISPLAY': ':10'}), mock.patch('sys.stdout', new_callable=io.StringIO) as output:
                with self.assertRaisesRegex(ValueError, 'startup failed'): installer.main()
                self.assertNotIn('HA.View installed;', output.getvalue())
                launch.return_value.terminate.assert_called_once()
    def test_unsafe_gate_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)/'gate'; path.write_text(''); path.chmod(0o666)
            with mock.patch.object(installer, 'COORDINATION', path):
                with self.assertRaisesRegex(ValueError, 'Unsafe'):
                    with installer.coordination(): pass
    def test_symlink_gate_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)/'gate'; path.symlink_to('/dev/null')
            with mock.patch.object(installer, 'COORDINATION', path):
                with self.assertRaises(OSError):
                    with installer.coordination(): pass

@unittest.skipUnless(sys.platform == 'linux', 'requires Linux pidfd and /proc')
class NativeIdentity(unittest.TestCase):
    def test_pidfd_terminates_exact_fixture_only(self):
        child=subprocess.Popen(['/usr/bin/sleep','30'], start_new_session=True)
        foreign=subprocess.Popen(['/usr/bin/sleep','30'], start_new_session=True)
        try:
            target=installer.process_identity(child.pid)
            with mock.patch('sys.stdout', new_callable=io.StringIO): installer.stop_processes([target], grace=.2)
            self.assertEqual(child.wait(timeout=2), -signal.SIGTERM)
            self.assertIsNone(foreign.poll())
        finally:
            for p in (child, foreign):
                if p.poll() is None: p.terminate()
                p.wait(timeout=2)
    def test_descendant_ignoring_term_is_killed_after_leader_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            pidfile=pathlib.Path(tmp)/'pid'
            script="import subprocess,time; p=subprocess.Popen(['/usr/bin/python3','-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)']);open(%r,'w').write(str(p.pid));time.sleep(30)"%str(pidfile)
            child=subprocess.Popen(['/usr/bin/python3','-c',script], start_new_session=True)
            try:
                deadline=time.monotonic()+2
                while not pidfile.exists() and time.monotonic()<deadline: time.sleep(.02)
                descendant=int(pidfile.read_text()); time.sleep(.1)
                supervisor.terminate(child, grace=.2)
                deadline=time.monotonic()+2
                while time.monotonic()<deadline:
                    p=installer.process_identity(descendant)
                    if p is None or p['state']=='Z': break
                    time.sleep(.02)
                else: self.fail('descendant survived termination')
            finally:
                if child.poll() is None: supervisor.terminate(child, grace=.1)


class PersistentGate(unittest.TestCase):
    def test_gate_is_outside_volatile_run_and_swapped_install(self):
        self.assertEqual(installer.COORDINATION.parent, pathlib.Path('/opt'))
        self.assertNotEqual(installer.COORDINATION.parent, installer.ROOT)
    def test_missing_gate_fails_closed_without_user_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)/'missing'
            with mock.patch.object(installer, 'COORDINATION', path):
                with self.assertRaises(FileNotFoundError):
                    with installer.coordination(): pass
            self.assertFalse(path.exists())
    def test_shared_open_never_creates_or_writes_persistent_gate(self):
        info=type('Info', (), dict(st_mode=0o100644, st_uid=0, st_dev=1, st_ino=2))()
        with mock.patch.object(installer.os, 'open', return_value=91) as opened, mock.patch.object(installer.os, 'fstat', return_value=info), mock.patch.object(pathlib.Path, 'lstat', return_value=info), mock.patch.object(installer.fcntl, 'flock'), mock.patch.object(installer.os, 'close'):
            with installer.coordination(): pass
            flags=opened.call_args.args[1]
            self.assertFalse(flags & os.O_CREAT)
            self.assertFalse(flags & os.O_RDWR)

if __name__ == '__main__': unittest.main()
