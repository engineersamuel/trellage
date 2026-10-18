"""Create a disposable source snapshot without installed dependencies or test caches."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess


def snapshot(source: Path, destination: Path) -> dict:
    source, destination = source.resolve(), destination.absolute()
    if destination.exists():
        raise ValueError('clean-start destination must not exist')
    names = subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=source)
    paths = sorted(set(names.split(b'\0')) - {b''})
    # A local clone preserves repository history for tests that inspect Git.
    # Overlay the exact selected worktree bytes, including additions/deletions.
    subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--no-hardlinks',
                    '--no-checkout', '--local', str(source), str(destination)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    subprocess.run(['git', 'read-tree', 'HEAD'], cwd=destination, check=True)
    copied = 0
    for raw in paths:
        relative = Path(os.fsdecode(raw))
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError(f'unsafe source inventory path: {relative}')
        original, target = source / relative, destination / relative
        if original.is_symlink():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(os.readlink(original))
            copied += 1
        elif original.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, target)
            copied += 1
        elif original.exists():
            raise ValueError(f'unsupported source inventory entry: {relative}')
    dependencies = list(destination.glob('**/node_modules'))
    if dependencies:
        raise ValueError('clean-start source inventory unexpectedly includes installed dependencies')
    return {'source':str(source),'destination':str(destination),'copiedFiles':copied,
            'state':'source only; no installed dependencies or ignored test caches',
            'gitHistory':'local clone; no checkout hooks, no remote access'}
