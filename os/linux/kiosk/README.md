# HA View Linux kiosk (prebuilt)

Maintainer: `npm ci` then `npm run build:linux-kiosk` on the target Linux architecture.
Client: extract the whole supplied tar.gz preserving permissions. Run `./Run.sh`
(or invoke it by path from another working directory) for direct bundled Electron.
Arguments are forwarded unchanged; no installer, watchdog, Node, compiler or CLI
credentials are needed. Runtime exit status and signals are preserved through exec.
The desktop and Electron runtime libraries are still required.

Direct extraction needs a working Chromium sandbox. Some desktop environments deny
unprivileged user namespaces, so the extracted runtime cannot start directly there.
Use the standard `./install.sh` installation below on such systems; do not use
`--no-sandbox`, run Electron as root, or disable distribution security policy.
Run.sh does not grant permissions or change sandbox configuration.
No build or Node/npm is required on the client. Python 3, sudo and a normal graphical
Linux desktop with Electron runtime libraries are required. Installer uses normal
sudo authentication to install root-owned binaries and the Chromium setuid sandbox
helper under `/opt/ha.view-kiosk`. It never runs the UI as root or disables sandboxing.

First run opens compact native URL settings, then Home Assistant's own login.
No HA token is an installation requirement. CLI application settings remain optional.
A normal desktop login launches HA View through XDG autostart. The session-local
supervisor restarts crashes with backoff, stops after five rapid failures, and respects
normal Quit. No autologon, linger, system-wide desktop session, or security bypass.
Errors are recorded in `~/.local/state/ha.view/kiosk.log` (or XDG_STATE_HOME).

`./install.sh --force` updates only an owned install, preserving Electron user settings
and retaining one previous version. `./install.sh --rollback` swaps it back.
If MQTT is turned on, the same update can be started from Home Assistant instead:
the app downloads the new release, checks it against the fingerprint published
with it, and runs this installer with `--force`. That needs password-free sudo,
because no one is at the screen to type a password when an update starts. Both stop only identity-checked installed supervisors and payload
session members before swapping; foreign/unverifiable group members cause refusal.
Termination is bounded: TERM, then KILL if needed. Each installer signal reports the
exact PID, UID, executable and signal; it never uses killall or signals foreign groups.
The persistent root-owned `/opt/.ha.view-kiosk-install.lock` is outside the swapped
installation and survives reboot. Normal users open it read-only for a shared spawn
gate; installers hold the exclusive gate until shutdown and swapping finish. Missing,
symlinked, writable or foreign-owned gates fail closed (rerun the installer to provision
an absent gate). No runtime-directory gate must be recreated after reboot.
Reopen HA View via Applications or let the normal-user installer launch it afterward.
`--no-start` defers launch to desktop login; `--verify-only` checks the local bundle.
The script discovers payload and SHA256 version manifest beside itself automatically.
Hashes detect corruption, not publisher authenticity: this development bundle is
unsigned. Obtain it through a trusted channel. No network downloads during install.

Missing shared libraries: install your distribution's Electron desktop dependencies
using its package manager. No flags weakening Chromium sandboxing are a workaround.
This implementation targets ordinary GNOME/XFCE desktops, not a headless login.
