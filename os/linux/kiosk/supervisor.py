"""HA.View desktop-session supervisor. Never root, no autologon, no sandbox bypass."""
import contextlib, fcntl, os, pathlib, signal, stat, subprocess, time, json, uuid
from install import ROOT, coordination


def boot_identity():
    # Kernel boot UUID survives logout/login; runtime directories do not.
    return str(uuid.UUID(pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()))


class BootPause:
    """Private persistent state, never a login-scoped XDG_RUNTIME_DIR marker."""
    def __init__(self, path, boot=boot_identity):
        self.path = pathlib.Path(path)
        self.boot = boot

    @contextlib.contextmanager
    def directory(self):
        # Walk by directory descriptors: reject links in every ancestor, including
        # dangling links, and never follow a replaced pathname during cleanup.
        path = self.path.absolute()
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in path.parts[1:]:
                try: os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError: pass
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = next_fd
            info = os.fstat(fd)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise RuntimeError('Unsafe kiosk pause directory')
            yield fd
        finally: os.close(fd)

    def read(self, directory):
        try:
            fd = os.open('pause.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError: return None
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                    info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 1024):
                raise RuntimeError('Unsafe kiosk pause record')
            record = json.loads(os.read(fd, 1025))
            if (set(record) != {'schema', 'uid', 'boot'} or record['schema'] != 1 or
                    record['uid'] != os.getuid() or str(uuid.UUID(record['boot'])) != record['boot']):
                raise RuntimeError('Invalid kiosk pause record')
            return record, info
        finally: os.close(fd)

    def paused(self):
        boot = self.boot()
        with self.directory() as directory:
            found = self.read(directory)
            if found is None: return False
            record, info = found
            if record['boot'] == boot: return True
            named = os.stat('pause.json', dir_fd=directory, follow_symlinks=False)
            if (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino):
                raise RuntimeError('Kiosk pause record replaced')
            os.unlink('pause.json', dir_fd=directory)
            os.fsync(directory)
            return False

    def persist(self):
        record = json.dumps(dict(schema=1, uid=os.getuid(), boot=self.boot())).encode()
        with self.directory() as directory:
            self.read(directory)  # Never overwrite a foreign/unsafe existing entry.
            name = '.pause-' + uuid.uuid4().hex + '.tmp'
            fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(record); stream.flush(); os.fsync(stream.fileno())
                os.replace(name, 'pause.json', src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                try: os.unlink(name, dir_fd=directory)
                except FileNotFoundError: pass


def terminate(child, grace=8):
    """Signal only our still-owned session group; poll reaps, never signal-handler wait."""
    def send(sig):
        # The leader is not reaped until after signalling its session group.
        try: os.killpg(child.pid, sig)
        except ProcessLookupError: pass
    send(signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        # waitid WNOWAIT preserves the leader PID/group identity until escalation.
        result = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if result:
            send(signal.SIGKILL)  # Includes descendants surviving their leader.
            child.wait(timeout=2)
            return
        time.sleep(.05)
    send(signal.SIGKILL)
    child.wait(timeout=3)


def run(payload, log, stopping, notify=lambda _: None, probe=3, backoff=lambda n: min(2 ** n, 30), gate=coordination, pause=None):
    if pause is not None and pause.paused():
        notify('PAUSED until OS restart'); return 0
    failures = 0
    reported = False
    while not stopping():
        started = time.monotonic()
        with gate():
            if stopping(): return 0
            child = subprocess.Popen([str(payload)], stdout=log, stderr=log, start_new_session=True)
        try:
            # Poll only from this loop. Signal handlers set intent and return.
            while not stopping():
                result = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if result: break
                if not reported and time.monotonic() - started >= probe:
                    notify('READY'); reported = True
                time.sleep(.05)
            if stopping():
                terminate(child); return 0
            # Clean up surviving descendants before reaping the group leader.
            terminate(child, grace=0)
            code = child.returncode
        except BaseException:
            if child.returncode is None: terminate(child)
            raise
        if code == 42:
            if pause is None: raise RuntimeError('Boot pause store required for exit42')
            pause.persist()
            if not reported: notify('PAUSED until OS restart'); reported = True
            return 0
        if not reported:
            notify('FAILED early payload exit=%s' % code); reported = True
        if code == 0: return 0  # Normal Quit never restarts.
        failures = failures + 1 if time.monotonic() - started < 60 else 1
        log.write('HA.View crash exit=%s attempt=%s\n' % (code, failures)); log.flush()
        if failures >= 5: return 1
        deadline = time.monotonic() + backoff(failures)
        while not stopping() and time.monotonic() < deadline: time.sleep(.05)
    return 0


@contextlib.contextmanager
def session_lock(path):
    """Migrate a private user's legacy lock only while holding its same inode."""
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        def verified():
            info = os.fstat(fd)
            named = pathlib.Path(path).lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                    info.st_nlink != 1 or not stat.S_ISREG(named.st_mode) or
                    (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
                raise RuntimeError('Unsafe session lock')
            return info
        verified()
        # Contention must remain a live-supervisor failure, not permission repair.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        info = verified()
        if stat.S_IMODE(info.st_mode) != 0o600:
            os.fchmod(fd, 0o600)
        if stat.S_IMODE(verified().st_mode) != 0o600:
            raise RuntimeError('Unsafe session lock')
        yield fd
    finally:
        os.close(fd)


def main():
    startup_fd = os.environ.pop('HA_VIEW_STARTUP_FD', None)
    def notify(message):
        nonlocal startup_fd
        if startup_fd is not None:
            fd = int(startup_fd); startup_fd = None
            try: os.write(fd, (message + '\n').encode())
            finally: os.close(fd)
    try:
        if os.geteuid() == 0: raise RuntimeError('HA View must run as the logged-in desktop user')
        runtime = os.environ.get('XDG_RUNTIME_DIR')
        if not runtime or not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
            raise RuntimeError('A normal graphical login and XDG_RUNTIME_DIR are required')
        info = pathlib.Path(runtime).lstat()
        if pathlib.Path(runtime).is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError('Unsafe XDG_RUNTIME_DIR')
        try:
            with session_lock(pathlib.Path(runtime) / 'ha.view-kiosk.lock'):
                intent = False
                def stop(*_):
                    nonlocal intent
                    intent = True
                signal.signal(signal.SIGTERM, stop)
                signal.signal(signal.SIGINT, stop)
                pause = BootPause(pathlib.Path.home() / '.local/state/ha.view-kiosk-pause')
                if pause.paused():
                    notify('PAUSED until OS restart'); return 0
                state = pathlib.Path(os.environ.get('XDG_STATE_HOME', pathlib.Path.home() / '.local/state')) / 'ha.view'
                state.mkdir(parents=True, exist_ok=True)
                with (state / 'kiosk.log').open('a') as log:
                    return run(ROOT / 'payload/ha.view', log, lambda: intent, notify, pause=pause)
        except BlockingIOError:
            notify('FAILED supervisor already active'); return 1
    except BaseException as error:
        notify('FAILED ' + str(error)); raise
    finally:
        if startup_fd is not None: notify('FAILED stopped before startup probe')


if __name__ == '__main__': raise SystemExit(main())
