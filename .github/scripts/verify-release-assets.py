#!/usr/bin/env python3
"""Validate exactly three platform artifacts before granting the publisher access."""
import pathlib
import sys
from importlib.machinery import SourceFileLoader

publisher = SourceFileLoader('publisher', str(pathlib.Path(__file__).with_name('publish-release.py'))).load_module()
if len(sys.argv) != 2:
    raise SystemExit('Usage: verify-release-assets.py DIRECTORY')
publisher.verify(pathlib.Path(sys.argv[1]))
print('Six assets and all three SHA-256 sidecars verified')
