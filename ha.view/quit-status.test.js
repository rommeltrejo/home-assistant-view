"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { quitStatus } = require("./quit-status");
const source = fs.readFileSync(require.resolve("../index.js"), "utf8");

function fixture(exitCode) {
  const appEvents = {}, processEvents = {}, powerEvents = {}, exits = [], logs = [];
  const context = {
    APP: { title: "HA View", build: {} }, process: { exitCode, on: (name, fn) => processEvents[name] = fn },
    app: { on: (name, fn) => appEvents[name] = fn, exit: code => exits.push(code), quit() {
      appEvents["before-quit"]();
      appEvents["will-quit"]({ preventDefault() {} });
    } },
    powerMonitor: { on: (name, fn) => powerEvents[name] = fn }, quitStatus,
    console: { warn: text => logs.push(["warn", text]), error: (...args) => logs.push(["error", ...args]) },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  // Register app quit events'), source.indexOf('\n  return true;', source.indexOf('  // Register app quit events'))), context);
  return { context, appEvents, processEvents, powerEvents, exits, logs };
}
for (const code of [undefined, 0, 1, 2, 137]) {
  test(`normalization and native close preserve status ${code}`, () => {
    const f = fixture(code), expected = code === undefined ? 0 : code;
    assert.equal(quitStatus(code), expected);
    f.context.app.quit();
    assert.equal(f.context.APP.exiting, true);
    assert.deepEqual(f.exits, [expected]);
    assert.deepEqual(f.logs, [[expected === 0 ? "warn" : "error", `HA View Terminated (${expected})`]]);
    f.processEvents.SIGTERM(); // Reentrant shutdown must not override the result.
    assert.deepEqual(f.exits, [expected]);
  });
  for (const event of ["SIGINT", "SIGTERM", "SIGQUIT", "shutdown", "exit"]) {
    test(`${event} preserves pending status ${code}`, () => {
      const f = fixture(code);
      (event === "shutdown" ? f.powerEvents.shutdown : f.processEvents[event])();
      assert.deepEqual(f.exits, [code === undefined ? 0 : code]);
    });
  }
}
test("process exit event carries explicit failure when exitCode is unset", () => {
  const f = fixture(); f.processEvents.exit(7); assert.deepEqual(f.exits, [7]);
});
for (const code of [undefined, 0, 1, 7]) {
  for (const message of ["Unhandled failure", "Object has been destroyed"]) {
    test(`actual error callback remains failure: ${message}, prior ${code}`, () => {
      const f = fixture(code);
      const start = source.indexOf('    onError({ error, versions }) {');
      const end = source.indexOf('\n    },', start);
      vm.runInContext(`(${source.slice(start, end).trim().replace('onError(', 'function (')}\n})({ error: new Error(${JSON.stringify(message)}), versions: {} })`, f.context);
      assert.deepEqual(f.exits, [code || 1]);
    });
  }
}
test("configuration failures still set status 1 before quit; direct failure exits remain", () => {
  assert.equal((source.match(/process\.exitCode = 1;\s+app\.quit\(\);/g) || []).length, 2);
  assert.equal((source.match(/app\.exit\(1\)/g) || []).length, 3);
  assert.match(source, /process\.exit\(1\)/);
});
test("packaging includes quit-status runtime but excludes tests", () => {
  const { ignore } = require("./build/files");
  assert.equal(ignore("/ha.view/quit-status.js"), false);
  assert.equal(ignore("/ha.view/quit-status.test.js"), true);
});
