/** HA.View Clock 2 title-removal regression; accepted face layout stays intact. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const clock = fs.readFileSync(path.join(__dirname, "faces", "clock.html"), "utf8");

test("Clock 2 has no visible brand heading, house icon, or unused brand CSS", () => {
  const body = clock.match(/<body>([\s\S]*?)<script>/)[1];
  assert.doesNotMatch(body, /HA View|<header\b|<svg\b|class="brand"/);
  assert.doesNotMatch(clock, /\.brand\b/);
});

test("Clock 2 preserves the clock, date, artwork and center grid row without a touch hint", () => {
  assert.match(clock, /<time id="time"[^>]*aria-label="Current local time"/);
  assert.match(clock, /<span id="period"/);
  assert.match(clock, /<p id="date" aria-label="Current local date"/);
  assert.doesNotMatch(clock, /Touch to open your home|class="cue"/);
  assert.match(clock, /main\s*\{\s*grid-row: 2;/);
  assert.match(clock, /grid-template-rows: auto 1fr auto;/);
  assert.match(clock, /body::before/);
  assert.match(clock, /body::after/);
  assert.match(clock, /linear-gradient\(155deg, #211b20 12%, #3b2932 58%, #694735\)/);
  assert.match(clock, /scheduleNextMinute\(\);/);
});
