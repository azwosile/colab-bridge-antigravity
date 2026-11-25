"""Run google-colab-cli with filelock.ReadWriteLock shimmed onto FileLock.

Reason: filelock>=4 ReadWriteLock uses an SQLite+oplock based lock which
Windows sandboxes or restricted handles can reject with PermissionError
(WinError 5). colab_cli only needs read_lock()/write_lock() context managers,
so a plain FileLock is functionally sufficient for single-user CLI access.
"""
import os
import sys

_site = os.environ.get("COLAB_BRIDGE_SITE_PACKAGES")
if _site and os.path.isdir(_site) and _site not in sys.path:
    sys.path.insert(0, _site)

import filelock


class _RWShim:
    def __init__(self, path, *args, **kwargs):
        self._lock = filelock.FileLock(path, timeout=15)

    def read_lock(self, *args, **kwargs):
        return self._lock

    def write_lock(self, *args, **kwargs):
        return self._lock


filelock.ReadWriteLock = _RWShim

from colab_cli.cli import app  # noqa: E402

if __name__ == "__main__":
    app()
