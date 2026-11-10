"""Exercise the real CLI in a terminal; stdlib only, no UI testing dependency."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

root, node, cli, repo, state, base = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    os.execv(node, [node, cli, 'review', '--repo', repo, '--state-dir', state,
                      '--base-dir', base, '--default-base', 'develop', '--live'])

output = bytearray()

def size(rows, columns):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    os.kill(pid, signal.SIGWINCH)

def pump(seconds=.15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([fd], [], [], max(0, deadline-time.monotonic()))
        if readable:
            try:
                data = os.read(fd, 65536)
                if not data:
                    return
                output.extend(data)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise

def expect(text, start=0, timeout=15):
    deadline = time.monotonic() + timeout
    target = text.encode()
    while target not in output[start:]:
        if time.monotonic() > deadline:
            raise AssertionError(f'Missing {text!r}; tail: {bytes(output[-6000:])!r}')
        pump(.1)

def key(value):
    start = len(output)
    os.write(fd, value.encode())
    return start

try:
    size(34, 160)
    expect('+version-one')
    expect('Updated')
    start = key('f')
    expect('FROZEN', start)
    with open(os.path.join(root, 'live.txt'), 'w') as file:
        file.write('version-two\n')
    expect('NEW CHANGES', start)
    assert b'+version-two' not in output[start:], 'Frozen patch changed'
    start = key('f')
    expect('+version-two', start)
    expect('Updated', start)
    start = key('2/')
    expect('Search files / diff', start)
    key('live\r')
    key('\x1b')
    pump(.6)  # readline distinguishes bare Escape from an Alt-key prefix.
    start = key('m')
    expect('Marked inspected snapshot', start)
    with open(os.path.join(root, 'live.txt'), 'w') as file:
        file.write('version-three\n')
    expect('+version-three', start)
    expect('Updated', start)
    start = key('s')
    expect('Reviewed', start)
    expect('-version-two', start)
    start = key('?')
    expect('KEYBOARD', start)
    key('\x1b')
    pump(.6)
    size(24, 70)
    start = key('1')
    expect('1 COMMITS', start)
    start = key('3')
    expect('3 DIFF', start)
    key('\x1b[Z\t\x1b[B\x1b[A')
    key('q')
    deadline = time.monotonic()+10
    while True:
        pump(.1)
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            assert os.waitstatus_to_exitcode(status) == 0, status
            break
        assert time.monotonic() < deadline, 'CLI did not quit'
    assert b'\x1b[?1049h' in output, 'Alternate screen not entered'
    assert b'\x1b[?1049l' in output, 'Alternate screen not restored'
    assert b'\x1b[?25h' in output, 'Cursor not restored'
    assert termios.tcgetattr(fd)[3] & termios.ICANON, 'Terminal remained in raw mode'
    print('PTY: live update, freeze, search, checkpoint, since, help, resizing, navigation, quit passed')
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
