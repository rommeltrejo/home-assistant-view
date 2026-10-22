/** HA.View session-scoped Linux display guard. No tracker writes or synthetic ON. */
'use strict';
const childProcess = require('node:child_process');
const installations = new WeakMap();
function install(hardware, { platform = process.platform, env = process.env,
  state = () => global.HARDWARE, execFileSync = childProcess.execFileSync } = {}) {
  if (platform !== 'linux') return () => {};
  if (installations.has(hardware)) return installations.get(hardware);
  const original = { init: hardware.init, getDisplayStatus: hardware.getDisplayStatus, setDisplayStatus: hardware.setDisplayStatus };
  let disposed = false;
  const remote = () => /^(1|yes|true)$/i.test(env.XDG_SESSION_REMOTE || '') ||
    !!(env.XRDP_SESSION || env.XRDP_SOCKET_PATH) ||
    /xrdp/i.test(env.DESKTOP_SESSION || '');
  const query = () => {
    try {
      const output = String(execFileSync('xset', ['-q'], { encoding: 'utf8', timeout: 2000, env, stdio: ['ignore', 'pipe', 'pipe'] }));
      if (/Server does not have the DPMS Extension/i.test(output)) return { absent: true, status: null };
      const match = output.match(/Monitor is (On|Off|Standby|Suspend)\b/i);
      return { absent: false, status: match ? (match[1].toLowerCase() === 'on' ? 'ON' : 'OFF') : null };
    } catch { return { absent: false, status: null }; }
  };
  const guard = support => {
    const current = state();
    if (!current?.display?.status) return support;
    if (remote() || (current.display.status.command === 'xset' && query().absent)) {
      current.display.status.path = null;
      support.displayStatus = false;
    }
    return support;
  };
  hardware.init = async function (...args) {
    const current = state();
    // Upstream uses lexical functions: intercept support assignment, not init completion.
    const descriptor = Object.getOwnPropertyDescriptor(current, 'support');
    let support = current.support;
    Object.defineProperty(current, 'support', { configurable: true, enumerable: true,
      get: () => support, set: value => { support = guard(value); } });
    try { return await original.init.apply(this, args); }
    finally {
      Object.defineProperty(current, 'support', { ...descriptor, value: support });
    }
  };
  hardware.getDisplayStatus = function (...args) {
    const current = state();
    if (remote()) return null;
    if (current?.display?.status.command !== 'xset') return original.getDisplayStatus.apply(this, args);
    const result = query();
    if (result.absent) guard(current.support);
    return current.support.displayStatus ? result.status : null;
  };
  hardware.setDisplayStatus = function (status, callback = null) {
    const current = state();
    if (remote() || (current?.display?.status.command === 'xset' && query().absent)) {
      if (typeof callback === 'function') callback(null, 'Not supported or display status unknown');
      return;
    }
    return original.setDisplayStatus.call(this, status, callback);
  };
  const wrappers = { init: hardware.init, getDisplayStatus: hardware.getDisplayStatus, setDisplayStatus: hardware.setDisplayStatus };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const key of Object.keys(original)) if (hardware[key] === wrappers[key]) hardware[key] = original[key];
    installations.delete(hardware);
  };
  installations.set(hardware, dispose);
  return dispose;
}
module.exports = { install };
