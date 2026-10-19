#!/usr/bin/env python3
"""Deny network socket creation across exec without remapping filesystem owners."""

import ctypes
import errno
import os
import socket
import sys


class ArgumentComparison(ctypes.Structure):
    _fields_ = [
        ("argument", ctypes.c_uint),
        ("operation", ctypes.c_uint),
        ("value", ctypes.c_uint64),
        ("mask", ctypes.c_uint64),
    ]


def restrict_network() -> None:
    library = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    library.seccomp_release.restype = None
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_syscall_resolve_name.restype = ctypes.c_int
    library.seccomp_rule_add_array.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint,
        ctypes.POINTER(ArgumentComparison),
    ]
    library.seccomp_rule_add_array.restype = ctypes.c_int
    library.seccomp_load.argtypes = [ctypes.c_void_p]
    library.seccomp_load.restype = ctypes.c_int
    allow = 0x7FFF0000  # SCMP_ACT_ALLOW
    deny = 0x00050000 | errno.EPERM  # SCMP_ACT_ERRNO
    context = library.seccomp_init(allow)
    if not context:
        raise RuntimeError("cannot allocate seccomp filter")
    try:
        unix_only = ArgumentComparison(0, 1, socket.AF_UNIX, 0)  # SCMP_CMP_NE
        # io_uring can create sockets without invoking the socket syscall.
        for name, comparison in ((b"socket", unix_only), (b"socketpair", unix_only), (b"io_uring_setup", None)):
            syscall = library.seccomp_syscall_resolve_name(name)
            if syscall < 0:
                raise RuntimeError(f"libseccomp does not recognize {name.decode()}")
            result = library.seccomp_rule_add_array(
                context, deny, syscall, int(comparison is not None),
                ctypes.byref(comparison) if comparison is not None else None,
            )
            if result != 0:
                raise RuntimeError(f"cannot restrict {name.decode()}: {os.strerror(-result)}")
        # libseccomp sets no_new_privs before loading. The filter is inherited by
        # children and cannot be removed by clearing environment variables.
        result = library.seccomp_load(context)
        if result != 0:
            raise RuntimeError(f"cannot load seccomp filter: {os.strerror(-result)}")
    finally:
        library.seccomp_release(context)


if __name__ == "__main__":
    try:
        if len(sys.argv) < 2:
            raise RuntimeError("missing isolated command")
        restrict_network()
        os.execvp(sys.argv[1], sys.argv[1:])
    except (OSError, RuntimeError) as error:
        print(f"offline test isolation unavailable: {error}", file=sys.stderr)
        raise SystemExit(1)
