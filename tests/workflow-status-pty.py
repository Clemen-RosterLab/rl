"""Verify live agent state, resize, fast exit and terminal restoration."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

root, node, cli, run_id, run_file = sys.argv[1:]
master, slave = pty.openpty()
initial = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 140, 0, 0))
child = subprocess.Popen(
    [node, cli, 'workflow', 'status', run_id, '--watch'],
    cwd=root, stdin=slave, stdout=slave, stderr=slave, env=os.environ.copy(),
)
received = b''
shell = None


def expect(text, timeout=10):
    global received
    deadline = time.monotonic() + timeout
    while text not in received:
        if time.monotonic() > deadline:
            raise AssertionError(f'Missing {text!r}: {received[-6000:]!r}')
        ready, _, _ = select.select([master], [], [], .1)
        if ready:
            received += os.read(master, 65536)


try:
    expect(b'RL AGENTS')
    expect(b'FIRST PASS')
    with open(run_file) as saved:
        run = json.load(saved)
    writer = next(stage for stage in run['stages'] if stage['id'] == 'writer')
    writer['progress'] = 'Live progress from native host'
    with open(run_file + '.next', 'w') as saved:
        json.dump(run, saved)
    os.replace(run_file + '.next', run_file)
    expect(b'Live progress from native host')
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 12, 65, 0, 0))
    os.kill(child.pid, signal.SIGWINCH)
    os.write(master, b'\x1b[B')  # Arrow navigation must not close the status view.
    time.sleep(.15)
    assert child.poll() is None, 'Arrow key unexpectedly closed agent status'
    started = time.monotonic()
    os.write(master, b'q')
    while child.poll() is None and time.monotonic() - started < 2:
        ready, _, _ = select.select([master], [], [], .05)
        if ready:
            received += os.read(master, 65536)
    assert child.poll() is not None, f'Status did not exit promptly: {received[-6000:]!r}'
    assert child.returncode == 0
    assert time.monotonic() - started < 1.5, 'Status exit was not prompt'
    restored = termios.tcgetattr(slave)
    for flag in [termios.ICANON, termios.ECHO]:
        assert (initial[3] & flag) == (restored[3] & flag), 'Terminal input flags were not restored'
    shell = subprocess.Popen(['/bin/zsh', '-f', '-c', 'IFS= read -r typed; [[ "$typed" == "typing-after-status" ]] || exit 1; printf "\\nRL_SHELL_READY\\n"'], cwd=root, stdin=slave, stdout=slave, stderr=slave)
    os.write(master, b'typing-after-status\n')
    expect(b'\r\nRL_SHELL_READY\r\n')
    shell.wait(timeout=3)
    assert shell.returncode == 0
    print('PTY: live agent status, resize, keyboard and terminal restoration passed')
finally:
    if shell is not None and shell.poll() is None:
        shell.kill()
        shell.wait()
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    os.close(slave)
