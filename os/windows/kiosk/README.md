# HA View native Windows kiosk distribution

**Current delivery: unsigned development package, not a trusted signed release.**
The native package does not change Windows execution policy.

Extract the **entire** delivered ZIP to a clean directory. For this unsigned
package, double-click `Setup-Development.cmd` (or `Update-Development.cmd` for an
existing install). Reserve `Setup.cmd` / `Update.cmd` for externally signed,
verified releases meeting the trust requirements below. No Bundle/Sha256 input, Node,
compiler, PowerShell runtime, elevation, or security-setting changes are used.
The compiled `HA.View.Kiosk.exe` requires Windows x64 and .NET Framework 4.x
(commonly available on Windows). SmartScreen/signing are not bypassed.

Normal launchers fail closed: Windows Authenticode trust including chain
revocation and an independently approved publisher identity are required for both
host and application: set exactly one of `HA_VIEW_PUBLISHER_THUMBPRINT` (legacy
40-hex leaf pin) or `HA_VIEW_PUBLISHER_PROFILE_EKU` (exact Microsoft Artifact
Signing Public Trust certificate-profile OID). Empty, malformed or simultaneous inputs fail
closed. The selected identity is persisted in per-user active config; watchdog
validation does not obtain it from environment or bundle metadata.
Do not obtain the pin from the package. Manifest hashes prove integrity, not
publisher authenticity. Trusted signing and signed-release acceptance remain
external and outstanding; functional validation does not establish them.

Only `Setup-Development.cmd` / `Update-Development.cmd` explicitly accept unsigned
code. Development mode is not a signed release. CMD files invoke fixed native
operations; old PS files are retired tombstones and are excluded from delivery.

Native validation rejects unsafe/reserved/alternate-case paths, reparse points,
unlisted/missing files, wrong identity/version, bad hashes and tampered copies.
Use a clean complete extraction: do not add files or logs inside it.

Installation is per-user under `%LOCALAPPDATA%\ha.view-kiosk`. The existing
`%APPDATA%\ha.view` profile is untouched. Each update installs an immutable unique
version and registers an Interactive/Limited at-logon Task Scheduler watchdog.
The watchdog creates the app suspended, assigns it to a non-inheritable
kill-on-close Windows job, then resumes it with `--app-kiosk=fullscreen`.
Task stop/watchdog crash kills only that job's descendants; no process-name kill
or unrelated-instance termination is performed. Profile conflicts fail startup.
The watchdog restarts exited children and Task Scheduler retries failed hosts.

On a profile without a Home Assistant URL, the app opens **Set up HA View**
with a URL field and **Save and open dashboard**. The watchdog's fullscreen
option is not configuration and must not skip this form. Save the URL in this
window, then sign in through Home Assistant's own login page if needed; an
already-authenticated profile can continue without another login. Credentials
are entered only in Home Assistant's login UI when needed, not in the installer. No HA token,
Windows password, or command-line configuration is required by this flow.
Existing non-URL settings are retained when the URL is added. Windows sign-in
remains interactive; the task does not log the user in or bypass OS security.

An exclusive installer lock and durable transaction journal protect updates.
A failed handshake restores previous active config and task XML/enabled/running
state; interrupted transactions recover on the next installer invocation (not
an automatic boot-time transaction recovery). Versions remain for recovery.
Native startup success verifies PID, executable path, creation time and five
seconds of survival within a bounded 180-second validation/launch window, **not rendered UI**. Keep the uniquely named
`HA.View-Native-*.log` printed in the user's TEMP directory. Rollback failures are
failures, never successful updates.
