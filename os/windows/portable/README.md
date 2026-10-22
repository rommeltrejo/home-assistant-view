# HA View for Windows x64

Extract the **whole ZIP folder** and double-click **Run.cmd**. Keep payload and the other folders together. No Node, compiler, or app installation is required. Run opens HA View normally; it does not install a kiosk or a restart watchdog.

On first run, enter your Home Assistant URL in native settings, then log in through Home Assistant. Your normal saved profile and settings remain in use. Optionally, from a command prompt:

```bat
Run.cmd --web-url=http://YOUR-HA:8123/ --app-kiosk=framed
```

## Optional kiosk

Use **Install-Kiosk.cmd** only if you want the existing per-user kiosk installation, logon startup and crash/restart recovery. It calls the bundled native host's fixed `setup-development` operation. **Update-Kiosk.cmd** calls `update-development` to update that installed kiosk while retaining its profile. Run these as the intended Windows user, not an administrator. The separate kiosk folder is a complete bundle for that host; do not mix its files with another version. Direct Run does not enable recovery and does not update an installed kiosk. Close a running instance before switching between direct and installed use.

This distribution is unsigned. **Unknown publisher is expected.** Windows protections are unchanged; this package does not bypass SmartScreen, Defender, policy, or security prompts. If Windows blocks it, follow your organization's policy. No certificate setup is required by HA View.
