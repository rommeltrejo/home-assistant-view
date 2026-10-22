"use strict";

// Node leaves exitCode undefined on normal close. Preserve every explicit status.
function quitStatus(exitCode) {
  return exitCode === undefined ? 0 : exitCode;
}

module.exports = { quitStatus };
