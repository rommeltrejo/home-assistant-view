#!/usr/bin/env python3
"""Validate exactly two platform artifacts before granting the publisher access."""
import pathlib
import sys
from importlib.machinery import SourceFileLoader

publisher = SourceFileLoader('publisher', str(pathlib.Path(__file__).with_name('publish-release.py'))).load_module()
if len(sys.argv) != 2:
    raise SystemExit('Usage: verify-release-assets.py DIRECTORY')
publisher.verify(pathlib.Path(sys.argv[1]))
print('Four assets and both SHA-256 sidecars verified')
