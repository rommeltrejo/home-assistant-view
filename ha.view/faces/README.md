# HA.View faces

See the root README for available faces and usage.

## Complete and accepted

- Clock 1: localized time and date; default face.
- Clock 2: live 24-hour time and local date, black digital design with amber 60-second progress marks. Not a 15-minute timer.

Both clocks are permanently accepted unless explicitly reopened by the user. Select with `--ha-view-clock-face=1` or `--ha-view-clock-face=2`. Idle reveals the selected clock; dismissal returns to the dashboard without activating an underlying control. These transitions and layouts are accepted.

The clocks load locally through Electron without a separate face server or Apple-owned assets. Calendar and Upcoming Events reuse native HA rendering in the authenticated dashboard. Face Settings supplies daily scheduling, rotation and calendar selection; chooser visibility is persisted. The custom Layout face composes up to two unchanged existing clock/native HA calendar faces in fixed Left/Right slots; see `../layout.README.md` for editor behavior and verification limits. Photos/slideshows and weather faces remain deferred; prototype files alone do not establish runtime support.

Preserve upstream sleeping-screen wake handling. Physical hardware/MQTT/wake support is not claimed on macOS. Do not edit protected upstream modules; new OS packaging requires a user request.
