#!/bin/sh
# HA.View direct bundled runtime; no installer, watchdog or sandbox bypass.
set -u
bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
runtime="$bundle/payload/ha.view"
if [ ! -f "$runtime" ]; then
    printf '%s\n' "HA View: missing bundled runtime: $runtime. Extract the whole archive." >&2
    exit 127
fi
if [ ! -x "$runtime" ]; then
    printf '%s\n' "HA View: bundled runtime is not executable: $runtime. Preserve archive permissions." >&2
    exit 126
fi
# exec retains the PID, runtime exit status and normal signal delivery.
# Chromium reports sandbox/dependency errors itself. Do not weaken its policy.
exec "$runtime" "$@"
