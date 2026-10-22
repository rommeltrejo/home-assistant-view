// HA.View Dashboard Chrome: headless IPC and host-height contract regression checks.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadChrome(name) {
  const html = fs.readFileSync(path.join(__dirname, "..", "html", `${name}.html`), "utf8");
  const controls = new Map();
  for (const [, tag, id] of html.matchAll(/<(button|input)[^>]*\bid="([^"]+)"/g)) {
    const classes = new Set();
    controls.set(id, {
      tag,
      id,
      listeners: {},
      disabled: false,
      addEventListener(event, handler) {
        this.listeners[event] = handler;
      },
      parentNode: {
        classList: {
          toggle(key, on) {
            on ? classes.add(key) : classes.delete(key);
          },
          contains(key) {
            return classes.has(key);
          },
        },
      },
      select() {
        this.selected = true;
      },
      blur() {
        this.blurred = true;
      },
    });
  }
  controls.set("title", {});
  const receives = new Map();
  const sent = [];
  const attributes = {};
  const ipcRenderer = {
    send(...args) {
      sent.push(args);
    },
    on(event, handler) {
      receives.set(event, handler);
    },
  };
  vm.runInNewContext(
    html.match(/<script>([\s\S]*?)<\/script>/)[1],
    {
      require(name) {
        assert.equal(name, "electron");
        return { ipcRenderer };
      },
      document: {
        querySelectorAll(tag) {
          return [...controls.values()].filter((control) => control.tag === tag);
        },
        getElementById(id) {
          return controls.get(id);
        },
        documentElement: {
          setAttribute(key, value) {
            attributes[key] = value;
          },
        },
      },
      window: {
        getSelection() {
          return { removeAllRanges() {} };
        },
      },
    },
    { timeout: 1000 },
  );
  return { html, controls, receives, sent, attributes };
}

for (const name of ["header", "navigation"]) {
  test(`${name}: accessible controls retain IPC IDs and nested click targeting`, () => {
    const chrome = loadChrome(name);
    const expected =
      name === "header"
        ? ["release", "minimize", "fullscreen", "terminate"]
        : ["home", "refresh", "previous", "next", "backward", "forward", "minus", "plus", "camera-dashboard", "dashboard-layout-help", "native-management"];
    assert.deepEqual(
      [...chrome.controls.values()].filter((c) => c.tag === "button").map((c) => c.id),
      expected,
    );
    for (const id of expected) {
      assert.match(chrome.html, new RegExp(`<button\\s+id="${id}"[^>]*aria-label="[^"]+"`));
      const control = chrome.controls.get(id);
      control.listeners.click({ target: { id: "" }, currentTarget: control });
      assert.equal(chrome.sent.at(-1)[0], "button-click");
      assert.equal(chrome.sent.at(-1)[1].id, id);
      chrome.receives.get("button-disabled")({}, { id, disabled: true });
      assert.equal(control.disabled, true);
      assert.equal(control.parentNode.classList.contains("disabled"), true);
      chrome.receives.get("button-disabled")({}, { id, disabled: false });
      assert.equal(control.disabled, false);
      chrome.receives.get("button-hidden")({}, { id, hidden: true });
      assert.equal(control.parentNode.classList.contains("hidden"), true);
      chrome.receives.get("button-hidden")({}, { id, hidden: false });
      assert.equal(control.parentNode.classList.contains("hidden"), false);
    }
    chrome.receives.get("data-theme")({}, { theme: "light" });
    assert.equal(chrome.attributes["data-theme"], "light");
    assert.match(chrome.html, /:focus-visible/);
    assert.match(chrome.html, /prefers-reduced-motion/);
  });
}

test("host heights: bounded targets and border-box fit 40px header / 50px navigation", () => {
  const header = loadChrome("header").html;
  const navigation = loadChrome("navigation").html;
  assert.match(header, /height: min\(40px, 100vh\)/);
  assert.match(navigation, /height: min\(44px, calc\(100vh - 6px\)\)/);
  for (const html of [header, navigation]) {
    assert.match(html, /box-sizing: border-box/);
    assert.doesNotMatch(html, /min-height:/);
  }
  assert.match(navigation, /overflow-x: auto/);
  assert.match(header, /min-width: 0/);
});

test("navigation: address editing, selection and upstream input IPC remain intact", () => {
  const chrome = loadChrome("navigation");
  const input = chrome.controls.get("url");
  assert.match(chrome.html, /aria-label="Dashboard address"/);
  chrome.receives.get("input-readonly")({}, { id: "url", readonly: false });
  assert.equal(input.readOnly, false);
  chrome.receives.get("input-text")({}, { id: "url", text: "https://ha.local", placeholder: "Dashboard" });
  assert.equal(input.value, "https://ha.local");
  assert.equal(input.placeholder, "Dashboard");
  for (const event of ["focus", "blur"]) {
    input.listeners[event]({ target: input });
    assert.equal(chrome.sent.at(-1)[0], `input-${event}`);
    assert.equal(chrome.sent.at(-1)[1].id, "url");
  }
  input.listeners.keydown({ key: "Enter", target: input });
  assert.equal(chrome.sent.at(-1)[0], "input-enter");
  assert.equal(chrome.sent.at(-1)[1].text, input.value);
  chrome.receives.get("input-select")({}, { id: "url", select: true });
  assert.equal(input.selected, true);
  chrome.receives.get("input-select")({}, { id: "url", select: false });
  assert.equal(input.blurred, true);
});

test("header: dynamic title remains text-only", () => {
  const chrome = loadChrome("header");
  chrome.receives.get("text-content")({}, { id: "title", content: "HA View" });
  assert.equal(chrome.controls.get("title").textContent, "HA View");
});
