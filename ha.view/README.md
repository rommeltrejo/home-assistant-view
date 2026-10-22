# ha.view/

HA View application code and local face pages live here. See the root README for setup and usage.

## Delivered foundations

The Electron app runs from source on macOS with the embedded Home Assistant dashboard and approved chrome. Clock 1 and Clock 2 are permanently complete and accepted unless the user explicitly reopens them. Clock 1 is the initial default; a saved face choice takes precedence over the `--ha-view-clock-face=2` fallback. Clock 2 is a live 24-hour clock/date with 60 seconds marks, not a 15-minute timer. Hold an idle clock to open the face picker; swipe between the two clocks, tap to select, or Cancel/Escape to keep the saved choice. A short tap returns to the dashboard on release. See [face-changer.README.md](face-changer.README.md) for validation limits. Photos and slideshows are not delivered.

## Local display policies

Daily idle dashboard/clock scheduling is configured in HA View Settings → Day Schedule… (⌘⇧D). Optional read-only entity context rules are configured in HA View Context → Context Display… (⌘⇧C). Both are disabled by default and persist only local configuration; neither interrupts active use. See [day-schedule.README.md](day-schedule.README.md) and [context-README.md](context-README.md) for precedence, safe fallback, and validation limits. Real authenticated context acceptance remains pending.

## Implementation boundaries

Keep HA.View logic here and integration call-outs in `js/webview.js` small. Do not edit protected `js/hardware.js` or `js/integration.js`; ask if a change seems necessary. Preserve upstream screen-power/wake handling and dismissal without click-through. Upstream hardware/MQTT/physical screen-wake behavior remains unsupported on macOS. New OS packaging requires a user request.

## Shared idle lifecycle

HA.View uses TouchKio's `idleView`/`applyView` lifecycle and the single
`WEBVIEW.tracker.view.timer` deadline; there is no second face inactivity timer.
The default is **120000 ms (two minutes)**, with `--ha-view-idle-ms` retained
as an override. After inactivity, the selected face (or scheduled/context idle
dashboard) supersedes the original idle icon. Layout/reapply notifications do
not dismiss the face or restart inactivity. Picker, held pointer, settings,
schedule and context safeguards remain in the HA.View presentation policy.

Display-off is a separate privacy blank, not another idle presentation: all
dashboard and face views are hidden immediately. Hardware power and first-touch
wake remain upstream; the wake press and its release cannot reach the dashboard.
Display-on restores the dashboard and starts a fresh shared inactivity deadline.
The original idle icon must never appear between a face and this blank.

`hooks.test.js` drives extracted actual `js/webview.js` idle entrypoints without
loading hardware or integrations. The local Electron idle fixture checks real
view visibility/load/resize, not physical touch or hardware power behavior.
