#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def fingerprint(info):
    if info is None:
        return None
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def update_settings(home, model, effort, plan_effort):
    directory = home.lstat()
    if not home.is_absolute() or not stat.S_ISDIR(directory.st_mode):
        raise ValueError("Copilot home must be an absolute, non-symlink directory")
    target = home / "settings.json"
    original = None
    settings = {}
    try:
        descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if target.is_symlink():
            raise ValueError("Copilot settings must not be a symlink")
    else:
        with os.fdopen(descriptor, encoding="utf-8") as source:
            original = os.fstat(source.fileno())
            if not stat.S_ISREG(original.st_mode) or original.st_nlink != 1:
                raise ValueError("Copilot settings must be a single-link regular file")
            settings = json.load(source)
        if not isinstance(settings, dict):
            raise ValueError("Copilot settings must be a JSON object")

    defaults = {
        "model": model,
        "effortLevel": effort,
        "planModel": model,
        "planEffortLevel": plan_effort,
    }
    if all(settings.get(key) == value for key, value in defaults.items()):
        return
    settings.update(defaults)

    descriptor, temporary = tempfile.mkstemp(prefix=".settings.json.trellage.", dir=home)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as destination:
            os.fchmod(destination.fileno(), stat.S_IMODE(original.st_mode) if original else 0o600)
            json.dump(settings, destination, indent=2)
            destination.write("\n")
            destination.flush()
            os.fsync(destination.fileno())
        current_directory = home.lstat()
        if (current_directory.st_dev, current_directory.st_ino) != (directory.st_dev, directory.st_ino):
            raise ValueError("Copilot home changed while updating model settings")
        try:
            current = target.lstat()
        except FileNotFoundError:
            current = None
        if fingerprint(current) != fingerprint(original):
            raise ValueError("Copilot settings changed while updating model defaults")
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    efforts = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
    parser = argparse.ArgumentParser(description="Update only Trellage-managed Copilot model settings.")
    parser.add_argument("home", type=Path)
    parser.add_argument("model")
    parser.add_argument("effort", choices=efforts)
    parser.add_argument("plan_effort", choices=efforts)
    args = parser.parse_args()
    try:
        if not args.model.strip():
            raise ValueError("Copilot model must not be empty")
        update_settings(args.home, args.model, args.effort, args.plan_effort)
    except (OSError, ValueError) as error:
        print(f"Copilot model settings: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
