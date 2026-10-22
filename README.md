# HA View

HA View turns a Home Assistant dashboard into a touch-friendly, fullscreen display, with a clock or calendar face ready when the screen is idle. It builds on [TouchKio](https://github.com/leukipp/touchkio), bringing its dashboard, browser and MQTT foundations into an Electron app.

> HA View is an independent project and is not affiliated with Apple.

## Downloads

**HA View 0.34** provides unsigned x64 distributions built from the same verified source commit. Download the archive and its matching SHA-256 file:

| Platform | Download | Checksum |
| --- | --- | --- |
| Linux x64 kiosk | [tar.gz](https://github.com/rommeltrejo/home-assistant-view/releases/download/0.34/ha.view-0.34.0-linux-x64-kiosk.tar.gz) | [SHA-256](https://github.com/rommeltrejo/home-assistant-view/releases/download/0.34/ha.view-0.34.0-linux-x64-kiosk.tar.gz.sha256) |
| Windows x64 portable | [ZIP](https://github.com/rommeltrejo/home-assistant-view/releases/download/0.34/ha.view-0.34.0-win32-x64-portable.zip) | [SHA-256](https://github.com/rommeltrejo/home-assistant-view/releases/download/0.34/ha.view-0.34.0-win32-x64-portable.zip.sha256) |

Verify each downloaded archive with its sidecar (`sha256sum -c <filename>.sha256` on Linux, or compare with `Get-FileHash <filename> -Algorithm SHA256` on Windows). These are unsigned builds; installation and automatic updates are not enabled. [Run from source](#run-from-source) instead if preferred.

## Explore HA View

![Clock 1 idle face in HA View](docs/faces/clock-two.png)

Connect to your dashboard, then choose what to show when the display is idle. The [screen guide](docs/README.md) covers setup, Home Assistant, faces, the browser, and settings. Images show the desktop interface; appearance may vary by platform.

### Home Assistant dashboard

Your existing Home Assistant dashboard stays at the center of HA View. Use its cards and navigation as you normally would.

![Home Assistant dashboard in HA View](docs/HA/dashboard-overview.png)

[Using your dashboard](docs/HA/README.md)

### Idle faces

Choose between two clocks, Calendar, Upcoming Events, and Weather. Press and hold to open the face chooser, then swipe and tap a face. Calendar and Upcoming Events use calendars available to your Home Assistant account; Weather uses a configured Home Assistant weather entity.

![Clock 2 idle face in HA View](docs/faces/clock-one.png)

[Choosing a face](docs/faces/README.md) · [Face settings and schedules](docs/settings/README.md)

### Browser and Home Assistant tools

Use the built-in browser for a website, or open the Home Assistant shortcuts for devices, entities, scenes, automations, and cameras. What appears depends on your Home Assistant setup.

![HA View browser with address and navigation controls](docs/browser/browser-entry.png)

[Using the browser](docs/browser/README.md) · [Home Assistant dashboard](docs/HA/README.md)

## Run from source

From the repository root, install dependencies and launch the Electron app directly:

```sh
npm ci
npm start
```

`npm start` runs `electron .` against this source tree; it does not package, sign or deploy an app. The app uses your saved Home Assistant URL. To supply a URL explicitly, use `npm start -- --web-url=http://YOUR-HA:8123/ --app-kiosk=framed`.

On a first launch without a saved URL, enter your dashboard URL in native settings. Home Assistant handles dashboard login. Existing settings are not reset.

## Windows portable

Extract the **whole ZIP folder** and double-click **Run.cmd**. The bundled Electron app needs no Node, compiler, or installation. First run opens native URL settings; an optional `Run.cmd --web-url=http://YOUR-HA:8123/ --app-kiosk=framed` supplies the URL. Your saved profile is retained.

**Install-Kiosk.cmd** and **Update-Kiosk.cmd** are separate, optional per-user kiosk operations for logon startup and restart recovery. Direct Run does not install or update a kiosk. Keep the separate kiosk folder intact. See `os/windows/portable/README.md`.

This build is unsigned: **Unknown publisher is expected**. Windows protections remain unchanged; no security bypass or certificate setup is included.

Build from this source tree with Node 24 and a Windows x64 native host compiled from `os/windows/kiosk/native/Kiosk.cs`: `HA_VIEW_KIOSK_NATIVE=/path/to/HA.View.Kiosk.exe npm run build:windows-portable`. Output is `out/windows-portable`. Existing strict signing build modes are separate and unchanged.

macOS packaging remains outside the source-run workflow. Physical wake/hardware behavior and macOS MQTT/device integration are not claimed verified.

## Linux prebuilt

Extract the **whole tar.gz folder**, preserving executable permissions, then run `./Run.sh` from that folder (or invoke it by path from another directory). It invokes bundled Electron directly and forwards arguments, for example `./Run.sh --web-url=http://YOUR-HA:8123/ --app-kiosk=framed`. No Node, compiler, kiosk installation or CLI credentials are needed. A supported graphical Linux desktop and Electron shared libraries are required. First launch without a saved URL opens native settings, followed by Home Assistant’s own login.

Direct extraction depends on the distribution allowing Chromium’s sandbox to initialize. On desktops that restrict unprivileged user namespaces, direct extracted execution may fail. Do **not** add `--no-sandbox` or disable system security policy. Use `./install.sh` for the existing standard root-owned installation and Chromium setuid helper; it requires Python 3 and normal sudo authentication, runs the UI as your normal user, and enables desktop-login startup/recovery. See `os/linux/kiosk/README.md` for update, rollback and dependency guidance. Direct Run itself neither installs nor enables a watchdog.

## TouchKio capabilities

HA View builds on TouchKio’s existing browser and MQTT features. Depending on the platform, hardware and MQTT setup, these include touch-focused browsing, page navigation, zoom and themes; screen wake behavior; and remote access to tools such as the on-screen keyboard, display controls, network details, system status and sensors.

For upstream Linux, Raspberry Pi and Debian setup guidance, consult the [TouchKio project](https://github.com/leukipp/touchkio); this README does not reproduce those instructions. The normal source-run workflow uses `npm start`; availability of inherited hardware and MQTT features varies by platform and setup.

## Credits

HA View is based on [TouchKio](https://github.com/leukipp/touchkio) by leukipp, released under the MIT license. Thank you to the TouchKio project for the foundation HA View builds on.

## License

HA View is released under the MIT License. See [LICENSE](LICENSE) for the full license text, including Copyright (c) 2024 leukipp and Copyright (c) 2026 HA.View contributors.
