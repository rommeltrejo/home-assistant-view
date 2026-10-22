# HA View

HA View turns a Home Assistant dashboard into a touch-friendly, fullscreen display, with a clock or calendar face ready when the screen is idle. It builds on [TouchKio](https://github.com/leukipp/touchkio), bringing its dashboard, browser and MQTT foundations into an Electron app.

> HA View is an independent project and is not affiliated with Apple.

## Downloads

Linux x64 and Windows x64 distributions will be available from the project Releases page after both platform builds pass. There are no downloads for this first source snapshot. Until then, [run from source](#run-from-source).

## Feature highlights

### Home Assistant dashboard

Use your existing Home Assistant dashboard as the heart of the display. HA View opens it in a fullscreen, touch-friendly window and gives you quick access to your configured pages and controls.

<!-- Feature image placeholder: Home Assistant dashboard -->

### Idle faces

When the display is idle, choose between two clock designs, a monthly calendar, an upcoming-events view, or Home Assistant weather. Open the face chooser with a press-and-hold, then swipe and tap to select a face.

<!-- Feature image placeholder: Clock faces and face chooser -->

### Weather Face

An uncluttered sky-inspired face shows current conditions, a large temperature, local time, and available wind, humidity and feels-like readings. Hourly forecasts are preferred; daily forecasts or current conditions alone are shown when hourly data is unavailable. Units and timezone come from Home Assistant.

Configure weather in **Home Assistant**, not HA View. The app automatically reads a usable weather entity through your existing authenticated connection. Without usable current conditions, Weather is grayed out and skipped by schedules and rotation; attempting to show it displays **“set up weather on Home Assistant”**. If data disappears while Weather is active, the app returns to the dashboard and re-enables Weather when readings recover. Weather is not added to your existing rotation automatically, and is not a Layout editor component.

### Face settings and schedules

Set how long the display waits before showing an idle face, choose which face appears, and create a daily schedule for the dashboard and your faces. As an alternative to the daily schedule, rotate an ordered selection of faces at a configurable interval, defaulting to five minutes. The chooser’s eye control hides or unhides faces persistently; rotation skips hidden faces without discarding the configured order, and the dashboard menu’s **Choose a face…** entry provides recovery if all rotation faces are hidden.

Calendar views use calendars already readable by your Home Assistant account. Calendar and Upcoming Events stay effectively hidden until availability is confirmed. Without a readable calendar, attempting to unhide shows “No calendar to show” and leaves them hidden. A readable calendar with zero events is valid. Loading or connection failures do not overwrite saved visibility, and recovery does not unhide faces you manually hid.

<!-- Feature image placeholder: Face settings and schedule -->

### More Home Assistant tools

HA View also provides shortcuts to Home Assistant areas such as devices, entities, scenes and automations, plus a route to a camera dashboard. What you can see and control depends on your Home Assistant setup and permissions.

<!-- Feature image placeholder: Home Assistant tools and cameras -->

## What’s available

The current consolidated application includes:

- The Home Assistant dashboard, Clock 1 and Clock 2, Calendar and Upcoming Events, the face chooser, persisted hide/unhide and calendar availability gating.
- Inactivity settings, daily schedules, ordered face rotation, face layouts and their settings. Layout help explains Home Assistant’s own dashboard editor; it does not replace it.
- Native startup URL and system settings, and the touch-friendly browser with DuckDuckGo search and page navigation.
- Shortcuts to Home Assistant-owned search, status, activity, management and conversation services. Availability and authorization depend on your Home Assistant configuration; HA View does not supply replacement smart-home services.

These features are implemented in the application source. Validate your own device and Home Assistant configuration before depending on a kiosk installation.

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
