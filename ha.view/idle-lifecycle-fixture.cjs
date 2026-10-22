/** Test-only extraction of actual upstream entrypoints, without device/app imports. */
const fs = require('node:fs');
const vm = require('node:vm');
module.exports = hooks => {
  global.ARGS.app_disable ||= [];
  console.verbose ||= () => {};
  const source = fs.readFileSync(require('node:path').join(__dirname, '../js/webview.js'), 'utf8');
  const start = source.indexOf('const applyView =');
  const end = source.indexOf('const updateView =', start);
  return vm.runInThisContext(`(function(require){${source.slice(start, end)};return {applyView,idleView};})`)(() => hooks);
};
