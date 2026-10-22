#!/bin/sh
# HA.View prebuilt Linux installer. No client Node/npm/build required.
set -eu
command -v python3 >/dev/null || { echo 'Install Python 3 using your distribution package manager.' >&2; exit 1; }
exec python3 "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/install.py" "$@"
