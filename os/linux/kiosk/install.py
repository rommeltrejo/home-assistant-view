"""HA.View owned, transactional prebuilt installer; run from the extracted bundle."""
import argparse, fcntl, hashlib, json, os, pathlib, platform, select, shutil, signal, stat, subprocess, sys, tempfile, time
from contextlib import contextmanager
ROOT = pathlib.Path('/opt/ha.view-kiosk')
MARKER = 'ha.view-linux-kiosk-v1'

def verify(bundle, installed=False):
    manifest = json.loads((bundle / 'manifest.json').read_text())
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    if manifest.get('schema') != 1 or manifest.get('platform') != 'linux' or manifest.get('arch') != arch:
        raise ValueError('Bundle architecture/platform mismatch')
    if not isinstance(manifest.get('version'), str) or not manifest['version'] or len(manifest['version']) > 64:
        raise ValueError('Invalid version')
    expected = set()
    for entry in manifest['files']:
        name = entry['path']
        parts = name.split('/')
        if any(p in ('', '.', '..') for p in parts) or '\\' in name or name in expected:
            raise ValueError('Unsafe or duplicate manifest path')
        expected.add(name)
        file = bundle / name
        if any((bundle.joinpath(*parts[:i])).is_symlink() for i in range(1, len(parts)+1)) or not file.is_file():
            raise ValueError('Missing file or symlink: ' + name)
        if file.stat().st_size != entry['size'] or hashlib.sha256(file.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('Integrity mismatch: ' + name)
    actual = set()
    for file in bundle.rglob('*'):
        if file.is_symlink(): raise ValueError('Bundle links forbidden')
        if file.is_file(): actual.add(file.relative_to(bundle).as_posix())
    if actual != expected | ({'manifest.json', '.owner'} if installed else {'manifest.json'}): raise ValueError('Unmanifested bundle files')
    for name in ('payload/ha.view', 'payload/chrome-sandbox', 'payload/resources/app/package.json', 'supervisor.py', 'install.py', 'install.sh'):
        if name not in expected: raise ValueError('Incomplete bundle: ' + name)
    app = json.loads((bundle / 'payload/resources/app/package.json').read_text())
    if app['version'] != manifest['version']: raise ValueError('Payload version mismatch')
    if (bundle / 'payload/ha.view').read_bytes()[:4] != b'\x7fELF': raise ValueError('Not a Linux executable')
    return manifest

def owned(root):
    if not root.is_dir() or root.is_symlink(): return False
    if not (root / '.owner').exists(): return False
    marker = root / '.owner'
    for file in (root, marker):
        info = file.lstat()
        if file.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022: return False
    return marker.is_file() and marker.read_text() == MARKER

# Outside the swapped tree: the same inode coordinates all installed generations.
COORDINATION = pathlib.Path('/opt/.ha.view-kiosk-install.lock')

@contextmanager
def coordination(exclusive=False, timeout=12):
    flags = os.O_NOFOLLOW | (os.O_RDWR | os.O_CREAT if exclusive else os.O_RDONLY)
    fd = os.open(COORDINATION, flags, 0o644)
    try:
        info = os.fstat(fd)
        binding = COORDINATION.lstat()
        if (binding.st_dev, binding.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError('Coordination lock substituted')
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Unsafe installation coordination lock')
        if exclusive: os.fchmod(fd, 0o644)  # Explicitly allow normal-user shared reads despite sudo umask.
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline: raise ValueError('Installation coordination timed out')
                time.sleep(.05)
        yield
    finally: os.close(fd)

def process_identity(pid):
    try:
        proc = pathlib.Path('/proc') / str(pid)
        fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
        uids = next(line for line in (proc / 'status').read_text().splitlines() if line.startswith('Uid:')).split()[1:]
        return dict(pid=pid, state=fields[0], ppid=int(fields[1]), group=int(fields[2]),
                    start=fields[19], uid=int(uids[0]), uids=tuple(uids),
                    exe=os.readlink(proc / 'exe') if fields[0] != 'Z' else '',
                    cmd=(proc / 'cmdline').read_bytes().split(b'\0')[:-1])
    except OSError: return None  # Vanished or unreadable (e.g. another user's process): never an owned payload.

def processes():
    return [p for entry in pathlib.Path('/proc').iterdir() if entry.name.isdigit()
            for p in [process_identity(int(entry.name))] if p]

def supervisor_identity(p):
    return (p['uid'] > 0 and len(set(p['uids'])) == 1 and
            p['exe'] in ('/usr/bin/python3', os.path.realpath('/usr/bin/python3')) and
            len(p['cmd']) == 2 and p['cmd'][0] in (b'python3', b'/usr/bin/python3') and
            p['cmd'][1] == os.fsencode(ROOT / 'supervisor.py'))

def payload_identity(p):
    return (p['uid'] > 0 and len(set(p['uids'])) == 1 and
            p['exe'].startswith(str(ROOT / 'payload') + '/') and
            '..' not in pathlib.Path(p['exe']).parts and not p['exe'].endswith(' (deleted)'))

def signal_identity(p, sig):
    # pidfd pins the process, not a potentially reused numeric PID.
    fd = os.pidfd_open(p['pid'])
    try:
        current = process_identity(p['pid'])
        if current and (current['start'], current['uid'], current['uids'], current['exe'], current['cmd']) == (p['start'], p['uid'], p['uids'], p['exe'], p['cmd']):
            signal.pidfd_send_signal(fd, sig)
            print('HA.View stop pid=%s uid=%s signal=%s executable=%s' %
                  (p['pid'], p['uid'], sig.name, p['exe']))
        elif current: raise ValueError('Process identity changed; refusing termination')
    finally: os.close(fd)

def stop_processes(targets, grace=3):
    live = [p for p in targets if p['state'] != 'Z']
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 3)):
        for p in live:
            try: signal_identity(p, sig)
            except ProcessLookupError: pass
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            live = [p for p in live if (q := process_identity(p['pid'])) and q['start'] == p['start'] and q['state'] != 'Z']
            if not live: return
            time.sleep(.05)
    raise ValueError('Owned processes did not stop within deadline')

def stop_owned():
    snapshot = processes()
    supervisors = [p for p in snapshot if supervisor_identity(p)]
    payloads = [p for p in snapshot if payload_identity(p)]
    groups = {p['group'] for p in payloads}
    owners = {p['group']: p['uid'] for p in payloads}
    targets = [p for p in snapshot if p['group'] in groups]
    for p in targets:
        if p['uid'] != owners[p['group']]:
            raise ValueError('Mixed UID payload group; refusing termination')
        if not payload_identity(p) and not (p['state'] == 'Z' and any(
                p['ppid'] == s['pid'] and p['uid'] == s['uid'] for s in supervisors)):
            raise ValueError('Foreign or unverifiable payload group member; refusing termination')
    # Stop restart sources first, while the exclusive spawn gate is held.
    stop_processes(supervisors)
    stop_processes(targets)
    if any(supervisor_identity(p) or payload_identity(p) for p in processes()):
        raise ValueError('Installed process appeared during shutdown; refusing update')

def rollback():
    previous = ROOT.with_name(ROOT.name + '.previous')
    if not owned(ROOT) or not owned(previous): raise ValueError('No owned rollback available')
    verify(ROOT, installed=True); verify(previous, installed=True)
    swap = ROOT.with_name(ROOT.name + '.swap')
    if swap.exists(): raise ValueError('Rollback swap already exists; manual recovery required')
    ROOT.rename(swap)
    promoted = False
    try:
        previous.rename(ROOT); promoted = True
        swap.rename(previous)
    except BaseException:
        # Reverse both completed moves, including failure of the final rename.
        if promoted: ROOT.rename(previous)
        swap.rename(ROOT)
        raise


def deploy(bundle, force):
    if ROOT.exists() and (not owned(ROOT) or not force):
        raise ValueError('Existing installation: --force required for an HA.View-owned update; foreign paths are never replaced')
    previous = ROOT.with_name(ROOT.name + '.previous')
    if previous.exists() and not owned(previous): raise ValueError('Foreign rollback directory')
    stage = pathlib.Path(tempfile.mkdtemp(prefix='.ha.view-stage-', dir=ROOT.parent))
    moved = False
    try:
        shutil.copytree(bundle, stage, dirs_exist_ok=True)
        verify(stage)  # Check copied bytes, not just the original source.
        (stage / '.owner').write_text(MARKER)
        for file in stage.rglob('*'):
            os.chown(file, 0, 0)
            os.chmod(file, 0o755 if file.is_dir() or file.name in ('ha.view', 'chrome_crashpad_handler', 'install.sh', 'Run.sh') else 0o644)
        os.chmod(stage, 0o755)
        os.chmod(stage / 'payload/chrome-sandbox', 0o4755)
        retired = ROOT.with_name(ROOT.name + '.retired')
        if retired.exists(): raise ValueError('Prior interrupted transaction: .retired exists')
        if previous.exists(): previous.rename(retired)
        try:
            if ROOT.exists(): ROOT.rename(previous); moved = True
            stage.rename(ROOT)
        except BaseException:
            if moved and not ROOT.exists(): previous.rename(ROOT); moved = False
            if retired.exists(): retired.rename(previous)
            raise
        if retired.exists(): shutil.rmtree(retired)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        if moved and not ROOT.exists(): previous.rename(ROOT)
        raise

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--force', action='store_true', help='replace only an owned installation, retaining the previous version')
    parser.add_argument('--rollback', action='store_true', help='swap the current and retained owned installation')
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--no-start', action='store_true', help='install autostart but defer launch until next desktop login')
    args = parser.parse_args()
    bundle = pathlib.Path(__file__).resolve().parent
    if not args.rollback: verify(bundle)
    if args.verify_only: print('HA.View bundle integrity verified'); return
    if os.geteuid() == 0:
        with coordination(exclusive=True):
            if any(ROOT.with_name(ROOT.name + suffix).exists() for suffix in ('.swap', '.retired')):
                raise ValueError('Interrupted transaction remnants; manual recovery required')
            if ROOT.exists() and not owned(ROOT): raise ValueError('Foreign installation')
            if ROOT.exists() and not (args.force or args.rollback): raise ValueError('--force required')
            if ROOT.exists():
                verify(ROOT, installed=True)
                stop_owned()
            if args.rollback: rollback()
            else: deploy(bundle, args.force)
        return
    # Elevation is only for immutable binaries + Chromium's sandbox helper, never the GUI.
    command = ['sudo', sys.executable, str(bundle / 'install.py')]
    command += [flag for flag, enabled in (('--force', args.force), ('--rollback', args.rollback)) if enabled]
    subprocess.run(command, check=True)
    config = pathlib.Path(os.environ.get('XDG_CONFIG_HOME', pathlib.Path.home() / '.config'))
    desktop = '[Desktop Entry]\nType=Application\nName=HA View\nExec=/usr/bin/python3 /opt/ha.view-kiosk/supervisor.py\nTerminal=false\n'
    for directory in (config / 'autostart', pathlib.Path.home() / '.local/share/applications'):
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / 'ha.view-kiosk.desktop'
        if target.exists() and 'Exec=/usr/bin/python3 /opt/ha.view-kiosk/supervisor.py' not in target.read_text():
            raise ValueError('Foreign desktop entry; installation retained but entry not changed')
        target.write_text(desktop)
    if not args.no_start:
        if not os.environ.get('DISPLAY') and not os.environ.get('WAYLAND_DISPLAY'):
            raise ValueError('Installed, but no desktop session. Open HA View from Applications or log in normally.')
        read_fd, write_fd = os.pipe()
        try:
            env = dict(os.environ, HA_VIEW_STARTUP_FD=str(write_fd))
            child = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'supervisor.py')], env=env,
                                     pass_fds=(write_fd,), start_new_session=True,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.close(write_fd); write_fd = None
            ready = select.select([read_fd], [], [], 12)[0]
            message = os.read(read_fd, 256) if ready else b''
            if message != b'READY\n':
                child.terminate()
                try: child.wait(timeout=10)
                except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=3)
                raise ValueError('Installed, but startup failed: ' + message.decode(errors='replace').strip())
        finally:
            os.close(read_fd)
            if write_fd is not None: os.close(write_fd)
    print('HA.View installed; ' + ('startup deferred' if args.no_start else 'payload survived startup probe') +
          '. Your settings are unchanged.')

if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print('HA.View install failed: ' + str(error), file=sys.stderr); sys.exit(1)
