#!/usr/bin/env python3
"""Drive a real controlling terminal using explicit output/key steps."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


def execute(config):
    assert config['env']['TRELLAGE_TEST_OFFLINE'] == '1'
    command = config['command']
    assert command and os.path.isabs(command[0])
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(config['cwd'])
        os.execve(command[0], command, config['env'])
    output = bytearray()
    step = 0
    status = None
    deadline = time.monotonic() + 25
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
        while status is None:
            assert time.monotonic() < deadline, f'terminal deadline at step {step}: {output[-3000:]!r}'
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    data = os.read(master, 16384)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b''
                output.extend(data)
                assert len(output) <= 1024 * 1024, 'terminal output limit'
            plain = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output.decode('utf-8', errors='replace'))
            normalized = ' '.join(plain.split())
            if step < len(config['steps']):
                expected = config['steps'][step]
                raw = not (termios.tcgetattr(master)[3] & termios.ICANON)
                if raw and all(' '.join(marker.split()) in normalized for marker in expected['wait']):
                    os.write(master, expected['keys'].encode())
                    step += 1
                    output.clear()
            finished, raw_status = os.waitpid(pid, os.WNOHANG)
            if finished:
                status = os.waitstatus_to_exitcode(raw_status)
        assert step == len(config['steps']), f'early exit {status} at step {step}: {output[-3000:]!r}'
        assert status == 0, f'terminal exit {status}'
        return {'exitCode': status, 'stepsCompleted': step}
    finally:
        if status is None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(master)


if __name__ == '__main__':
    print(json.dumps(execute(json.load(sys.stdin))))
