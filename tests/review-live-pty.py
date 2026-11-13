"""Exercise the real CLI in a terminal; stdlib only, no UI testing dependency."""
import errno
import base64
import fcntl
import json
import os
import pty
import select
import shlex
import re
import unicodedata
import signal
import struct
import subprocess
import sys
import termios
import time

root, node, cli, repo, state, base = sys.argv[1:7]
scenario = sys.argv[7] if len(sys.argv) > 7 else "keyboard"
terminal_rows, terminal_columns = 34, 160
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    if scenario in ('shell', 'shell-function'):
        os.execvpe('zsh', ['zsh', '-f', '-i'], {
            **os.environ, 'PROMPT': 'RL_SHELL_READY> ', 'ZDOTDIR': root,
        })
    if scenario in ('terminal-raw', 'terminal-noecho'):
        broken = termios.tcgetattr(0)
        broken[3] &= ~termios.ECHO
        if scenario == 'terminal-raw':
            broken[3] &= ~(termios.ICANON | termios.ISIG)
            broken[0] &= ~termios.ICRNL
            broken[6][termios.VMIN] = 1
            broken[6][termios.VTIME] = 0
        termios.tcsetattr(0, termios.TCSANOW, broken)
        result = subprocess.run([cli, 'review', '--live'])
        assert result.returncode == 0, result.returncode
        attributes = termios.tcgetattr(0)
        for flag, label in [(termios.ICANON, 'canonical input'), (termios.ECHO, 'echo'), (termios.ISIG, 'signals')]:
            assert attributes[3] & flag, f'Shell did not recover {label}'
        assert attributes[0] & termios.ICRNL, 'Enter did not recover carriage-return translation'
        print('SHELL_CAN_READ', flush=True)
        typed = os.read(0, 65536)
        assert typed == b'typing-after-review\n', typed
        print('SHELL_TYPED_OK', flush=True)
        sys.exit(0)
    if scenario == "handoff":
        result = subprocess.run([node, cli, 'review', '--live'])
        assert result.returncode == 0, result.returncode
        # A shell resumes on this same terminal after the public CLI exits.
        attributes = termios.tcgetattr(0)
        assert attributes[3] & termios.ICANON, 'Shell inherited raw mode'
        probe = termios.tcgetattr(0)
        probe[3] &= ~(termios.ICANON | termios.ECHO)
        probe[6][termios.VMIN] = 0
        probe[6][termios.VTIME] = 0
        termios.tcsetattr(0, termios.TCSANOW, probe)
        pending = os.read(0, 65536)
        termios.tcsetattr(0, termios.TCSANOW, attributes)
        assert not pending, f'Mouse packets leaked to the shell: {pending!r}'
        print('SHELL_INPUT_CLEAN', flush=True)
        sys.exit(0)
    if scenario == "quit":
        os.execv(node, [node, cli, 'review', '--live'])
    extra = ['--pr', '99', '--remote-interval', '10'] if scenario in ('pr-navigation', 'pr-freeze') else []
    os.execv(node, [node, cli, 'review', '--repo', repo, '--state-dir', state,
                      '--base-dir', base, '--default-base', 'develop', '--live', *extra])

output = bytearray()
osc_expression = re.compile(r'\x1b\].*?(?:\x07|\x1b\\)', re.S)
csi_expression = re.compile(r'\x1b\[([?0-9;]*)([@-~])')

def size(rows, columns):
    global terminal_rows, terminal_columns
    terminal_rows, terminal_columns = rows, columns
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

def expect(text, start=0, timeout=35):
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

def screen(with_colours=False):
    backgrounds = [[None] * terminal_columns for _ in range(terminal_rows)]
    background = None
    grid = [[' '] * terminal_columns for _ in range(terminal_rows)]
    data = output.decode('utf8', errors='replace')
    x = y = i = 0
    while i < len(data):
        if data[i] == '\x1b':
            osc = osc_expression.match(data, i)
            if osc:
                i += len(osc.group(0))
                continue
            match = csi_expression.match(data, i)
            if match:
                parameters, operation = match.groups()
                if operation == 'H':
                    values = [int(v or 1) for v in parameters.split(';')]
                    y, x = values[0]-1, (values[1] if len(values)>1 else 1)-1
                elif operation == 'J' and parameters == '2':
                    grid = [[' '] * terminal_columns for _ in range(terminal_rows)]
                    backgrounds = [[background] * terminal_columns for _ in range(terminal_rows)]
                elif operation == 'm':
                    codes = [int(value or 0) for value in parameters.split(';')]
                    n = 0
                    while n < len(codes):
                        if codes[n] == 0:
                            background = None
                        elif codes[n] in (38, 48) and codes[n+1:n+2] == [2]:
                            if codes[n] == 48:
                                background = tuple(codes[n+2:n+5])
                            n += 4
                        n += 1
                i += len(match.group(0))
                continue
        char = data[i]
        if char == '\r':
            x = 0
        elif char == '\n':
            y += 1
        elif ord(char) >= 32 and not unicodedata.combining(char):
            width = 2 if unicodedata.east_asian_width(char) in ('W', 'F') else 1
            if 0 <= y < terminal_rows and 0 <= x < terminal_columns:
                grid[y][x] = char
                backgrounds[y][x] = background
            x += width
        i += 1
    rows = [''.join(row) for row in grid]
    return (rows, backgrounds) if with_colours else rows

def expect_screen(text, timeout=35):
    deadline = time.monotonic()+timeout
    while not any(text in row for row in screen()):
        assert time.monotonic()<deadline, f'Missing {text!r} on screen: {screen()}'
        pump(.1)

def locate(text):
    for y, row in enumerate(screen()):
        if text in row:
            return row.index(text), y
    raise AssertionError(f'Cannot click missing label {text!r}')

def mouse(button, x, y, release=False):
    key(f'\x1b[<{button};{x+1};{y+1}{"m" if release else "M"}')

def click(text):
    x, y = locate(text)
    mouse(0, x+1, y)
    mouse(0, x+1, y, True)

def assert_background(text, expected):
    rows, backgrounds = screen(True)
    for y, row in enumerate(rows):
        x = row.find(text)
        if x >= 0:
            assert all(backgrounds[y][n] == expected for n in range(x, x+len(text))), f'{text} has the wrong background'
            return
    raise AssertionError(f'Missing selected file {text}')

def assert_selected(text):
    assert_background(text, (40, 52, 72))

def diff_position():
    for row in screen():
        match = re.search(r'· (\d+)–(\d+) / (\d+)', row)
        if match:
            return int(match[1])
    return None

def expect_position(position):
    deadline = time.monotonic()+35
    while diff_position() != position:
        assert time.monotonic()<deadline, f'Diff position {diff_position()}, expected {position}'
        pump(.1)


def mouse_scenario():
    expect_screen('+++working-a')
    assert_selected('a.txt (unstaged)')
    assert_background('+++working-a', (28, 53, 43))
    assert_background('-a120', (59, 37, 44))
    assert b'\x1b[48;2;17;21;26m' in output, 'Reference background missing'
    assert b'\x1b[48;2;29;36;45m' in output, 'Diff surface missing'
    assert b'\x1b[38;2;136;213;165m' in output, 'Reference addition colour missing'
    # Browsing the timeline must not load a commit or change the working diff.
    commit_x, commit_y = locate('1 COMMITS')
    mouse(65, commit_x+10, commit_y+4)
    pump(.15)
    expect_screen('+++working-a')
    assert_selected('a.txt (unstaged)')
    assert not any('Latest source' in row for row in screen()), 'Commit wheel did not scroll the list'
    mouse(64, commit_x+10, commit_y+4)
    expect_screen('Latest source')
    expect_screen('+++working-a')
    click('Reviewable source')
    expect_screen('A b.txt')
    click('A b.txt')
    expect_screen('+b001')
    assert_selected('A b.txt')
    sidebar = [row[:57] for row in screen()[3:31]]
    x, y = locate('3 DIFF PREVIEW')
    mouse(65, x+10, y+8)
    expect_position(4)
    for _ in range(30):
        mouse(65, x+10, y+8)
    pump(.2)
    assert diff_position() <= 10, 'A fast wheel burst jumped too many lines'
    for _ in range(30):
        mouse(65, x+10, y+8)
        pump(.07)
    pump(.2)
    position = diff_position()
    assert position > 60, 'Deliberate wheel steps did not use the faster scroll speed'
    assert [row[:57] for row in screen()[3:31]] == sidebar, 'Diff wheel moved the sidebar'
    assert_selected('A b.txt')
    # Grab the thumb, hold and drag outside the track, then release elsewhere.
    rows = screen()
    thumb_y, thumb_x = next((row, text.index('▐')) for row, text in enumerate(rows) if '▐' in text)
    mouse(0, thumb_x, thumb_y)
    mouse(32, 1, 6)
    expect_position(1)
    mouse(32, thumb_x, terminal_rows-1)
    expect_screen('+b120')
    end_position = diff_position()
    assert end_position > position, 'Held thumb drag did not reach the end'
    mouse(0, 1, terminal_rows-1, True)
    mouse(32, thumb_x, 6)
    pump(.15)
    assert diff_position() == end_position, 'Released scrollbar kept dragging'
    assert [row[:57] for row in screen()[3:31]] == sidebar, 'Dragging over the sidebar changed its selection'
    # Clicking the track also jumps; pressing within the thumb must not jump.
    mouse(0, thumb_x, 6)
    mouse(0, thumb_x, 6, True)
    expect_position(1)
    mouse(0, thumb_x, 10)
    mouse(0, thumb_x, 10, True)
    pump(.15)
    position = diff_position()
    assert 1 < position < end_position, 'Clicking the scrollbar track did not jump'
    thumb_y, thumb_x = next((row, text.index('▐')) for row, text in enumerate(screen()) if '▐' in text)
    mouse(0, thumb_x, thumb_y)
    pump(.1)
    assert diff_position() == position, 'Grabbing the thumb jumped before dragging'
    mouse(0, thumb_x, thumb_y, True)
    click('A a.txt')
    expect_screen('+a001')
    assert_selected('A a.txt')
    click('A b.txt')
    expect_position(position)
    assert_selected('A b.txt')
    click('[Expand]')
    expect_screen('[Back]')
    assert not any('1 COMMITS' in row for row in screen()[3:31]), 'Expand kept sidebar'
    key('\x1b[F')
    expect_screen('+b120')
    key('\x1b[H')
    expect_screen('+b001')
    key('\x1b[6~')
    expect_screen('+b016')
    click('[Back]')
    expect_screen('WORKING TREE')
    click('a.txt (unstaged)')
    expect_screen('+++working-a')
    assert_selected('a.txt (unstaged)')
    _, latest_y = locate('Latest source')
    mouse(0, 3, latest_y)
    expect_screen('1 selected commit · files grouped by commit')
    key('jj ')
    expect_screen('2 selected commits · files grouped by commit')
    key('kk3')
    expect_screen('Latest source')
    expect_screen('+latest-only')
    expect_screen('A a.txt')
    assert_selected('Latest source')
    assert_selected('Reviewable source')
    assert not any('A skipped.txt' in row for row in screen()), 'An unselected commit leaked into the file list'
    click('A a.txt')
    expect_screen('+a001')
    assert_selected('Latest source')
    assert_selected('Reviewable source')
    _, first_y = locate('Reviewable source')
    mouse(0, 3, first_y)
    expect_screen('1 selected commit · files grouped by commit')
    expect_screen('+latest-only')
    click('Middle source')
    expect_screen('+middle-only')
    assert not any('files grouped by commit' in row for row in screen()), 'A regular click should restore single selection'
    assert b'Marked inspected snapshot' not in output, 'Mouse packet triggered m shortcut'
    click('R Range')
    expect_screen('Range FROM TO')
    click('Q Quit')

def preview_scenario():
    expect_screen('+alpha')
    diff_x, diff_y = locate('3 DIFF PREVIEW')
    divider_x = diff_x - 2
    mouse(0, divider_x, diff_y+4)
    mouse(32, 40, diff_y+4)
    mouse(0, 40, diff_y+4, True)
    expect_screen('Sidebar 39 columns')
    assert locate('3 DIFF PREVIEW')[0] == 42, 'Divider drag did not resize the panels'
    mouse(32, 90, diff_y+4)
    pump(.1)
    assert locate('3 DIFF PREVIEW')[0] == 42, 'Divider kept dragging after release'
    key('+')
    expect_screen('Sidebar 43 columns')
    assert locate('3 DIFF PREVIEW')[0] == 46
    key('-')
    expect_screen('Sidebar 39 columns')
    size(34, 100)
    pump(.15)
    assert locate('3 DIFF PREVIEW')[0] == 42, 'Terminal resize lost the requested panel width'
    size(34, 160)
    pump(.15)
    assert locate('3 DIFF PREVIEW')[0] == 42
    # Select only text from the preview, never sidebar columns or ANSI colours.
    x, y = locate('+alpha')
    mouse(0, x+1, y)
    mouse(32, x+6, y)
    mouse(0, x+6, y, True)
    expect_screen('Text selected')
    assert_selected('alpha')
    offset = key('y')
    expect('Copied 5 characters', offset)
    def clipboard():
        matches = re.findall(rb'\x1b\]52;c;([A-Za-z0-9+/=]*)\x1b\\', bytes(output))
        assert matches, 'Copy did not emit a clipboard payload'
        return base64.b64decode(matches[-1]).decode()
    assert clipboard() == 'alpha', clipboard()
    with open(os.path.join(root, 'a.txt')) as file:
        content = file.read()
    with open(os.path.join(root, 'a.txt'), 'w') as file:
        file.write(content.replace('alpha', 'newer', 1))
    expect_screen('newer diff available')
    expect_screen('+alpha')
    assert not any('+newer' in row for row in screen()), 'Live updates overwrote selected text'
    key('\x03')
    pump(.15)
    assert clipboard() == 'alpha', 'Ctrl-C copied a different revision'
    key('\x1b')
    expect_screen('+newer')
    key('=')
    expect_screen('Sidebar 56 columns')
    assert locate('3 DIFF PREVIEW')[0] == diff_x
    click('[Expand]')
    expect_screen('[Back]')
    key('jjjj')
    expect_position(5)
    key('\t')
    expect_screen('+beta')
    expect_screen('[Back]')
    assert not any('1 COMMITS' in row for row in screen()), 'Tab collapsed the expanded preview'
    key('\x1b[Z')
    expect_position(5)
    expect_screen('[Back]')
    key(']')
    expect_screen('+beta')
    expect_screen('[Back]')
    key('[')
    expect_position(5)
    key('\x1b[H')
    expect_screen('+newer')
    key('\x1b[F')
    expect_screen('+a100')
    key('\x1b[H\x1b[6~')
    expect_position(22)
    key('\x1b[5~')
    expect_position(1)
    # Drag several lines in reverse and copy while expanded.
    x, y = locate('+newer')
    mouse(0, x+4, y+1)
    mouse(32, x+1, y)
    mouse(0, x+1, y, True)
    key('y')
    expect_screen('Copied')
    assert clipboard() == "newer 界é    omega\n+a00", clipboard()
    key('\x1b')
    expect_screen('Sidebar 56 columns')
    expect_screen('[Back]')
    key('\x1b')
    expect_screen('1 COMMITS')
    key('q')

def filter_scenario():
    expect_screen('Updated')
    expect_screen('[t Focus: 5 hidden]')
    assert not any('source.test.ts' in row or 'new.spec.ts' in row or 'styles.css' in row or 'package-lock.json' in row or 'types.generated.ts' in row for row in screen()), 'Default filter revealed tests, styles or boilerplate'
    click('source.ts (unstaged)')
    expect_screen('+live-source')
    assert_selected('source.ts (unstaged)')
    with open(os.path.join(root, 'source.ts'), 'a') as file:
        file.write('live-updated\n')
    expect_screen('+live-updated')
    expect_screen('[t Focus: 5 hidden]')
    click('[t Focus: 5 hidden]')
    expect_screen('[t All files]')
    assert_selected('source.ts (unstaged)')
    click('source.test.ts (unstaged)')
    expect_screen('+live-test')
    key('t')
    expect_screen('+live-updated')
    assert not any('live-test' in row for row in screen()), 'Hidden test diff remained visible'
    click('Tests only')
    expect_screen('Only filtered files changed. Press t to show all.')
    expect_screen('[t Focus: 1 hidden]')
    click('[t Focus: 1 hidden]')
    expect_screen('+only-test')
    key('t')
    expect_screen('Only filtered files changed. Press t to show all.')
    click('Mixed source and tests')
    expect_screen('+source1')
    expect_screen('[t Focus: 7 hidden]')
    assert not any('renamed.test.ts' in row or 'deleted.spec.ts' in row for row in screen()), 'Renamed/deleted tests remained visible'
    click('A source.ts')
    key('jjjj')
    expect_position(5)
    key('t')
    expect_screen('[t All files]')
    expect_position(5)
    assert_selected('A source.ts')
    key('t')
    expect_screen('[t Focus: 7 hidden]')
    expect_position(5)
    key('w')
    expect_screen('+live-updated')
    key('f')
    expect_screen('FROZEN')
    key('t')
    expect_screen('[t All files]')
    assert_selected('M source.ts')
    key('t')
    expect_screen('[t Focus: 5 hidden]')
    with open(os.path.join(root, 'tests/newer.spec.ts'), 'w') as file:
        file.write('newer-untracked-test\n')
    expect_screen('NEW CHANGES')
    expect_screen('[t Focus: 5 hidden]')
    key('f')
    expect_screen('[t Focus: 6 hidden]')
    assert not any('newer.spec.ts' in row for row in screen()), 'Live refresh revealed a filtered test'
    size(24, 70)
    key('3')
    expect_screen('[t Focus: 6 hidden]')
    click('[t Focus: 6 hidden]')
    expect_screen('[t All files]')
    click('[Filters]')
    expect_screen('FILE FILTERS')
    click('2 [x] Styles')
    expect_screen('2 [ ] Styles')
    click('1 [x] Tests')
    expect_screen('1 [ ] Tests')
    expect_screen('3 [x] Boilerplate')
    expect_screen('[t Focus: 2 hidden]')
    key('\x1b')
    expect_screen('3 DIFF PREVIEW')
    key('t')
    expect_screen('[t All files]')
    key('t')
    expect_screen('[t Focus: 2 hidden]')
    key('T')
    expect_screen('FILE FILTERS')
    expect_screen('1 [ ] Tests')
    expect_screen('2 [ ] Styles')
    key('n')
    expect_screen('3 [ ] Boilerplate')
    expect_screen('[t Focus: 0 hidden]')
    key('d')
    expect_screen('1 [x] Tests')
    expect_screen('2 [x] Styles')
    expect_screen('3 [x] Boilerplate')
    expect_screen('[t Focus: 6 hidden]')
    key('12')
    expect_screen('1 [ ] Tests')
    expect_screen('2 [ ] Styles')
    expect_screen('[t Focus: 2 hidden]')
    key('T')
    expect_screen('3 DIFF PREVIEW')
    key('q')

def filter_reopen_scenario():
    expect_screen('Updated')
    expect_screen('[t Focus: 2 hidden]')
    key('T')
    expect_screen('FILE FILTERS')
    expect_screen('1 [ ] Tests')
    expect_screen('2 [ ] Styles')
    expect_screen('3 [x] Boilerplate')
    key('jj ')
    expect_screen('3 [ ] Boilerplate')
    expect_screen('[t Focus: 0 hidden]')
    key(' ')
    expect_screen('3 [x] Boilerplate')
    key('T')
    expect_screen('3 DIFF PREVIEW')
    key('q')

def freeze_refs():
    return subprocess.check_output([
        os.environ['REVIEW_REAL_GIT'], 'for-each-ref', '--format=%(refname)',
        'refs/rl/live-freeze',
    ], cwd=root).strip()

def improvements_scenario():
    expect_screen('+return 2;')
    expect_screen('Updated')
    pump(.3)  # The initial viewed identity is saved in the background.
    with open(os.path.join(root, 'alpha.ts')) as file:
        content = file.read()
    with open(os.path.join(root, 'alpha.ts'), 'w') as file:
        file.write(content.replace('return 2;', 'return 3;'))
    expect_screen('+return 3;')
    expect_screen('● M alpha.ts')
    key('d')
    expect_screen('Changes since you last viewed')
    expect_screen('-return 2;')
    key('d')
    expect_screen('-return 1;')
    key('v')
    expect_screen('1/2 reviewed')
    key('u')
    expect_screen('beta.ts · unstaged')
    expect_screen('+return 2;')
    key('v')
    expect_screen('2/2 reviewed')
    key('[')
    expect_screen('alpha.ts · unstaged')
    key('c')
    expect_screen('3 FILE · AFTER')
    expect_screen('return 3;')
    assert not any('+return 3;' in row for row in screen()), 'Full-file context retained diff prefixes'
    key('e')
    expect_screen('3 FILE · BEFORE')
    expect_screen('return 1;')
    key('C')
    expect_screen('3 DIFF PREVIEW')
    expect_screen('-return 1;')
    key('\x1b[H}')
    expect_screen('@@ ')
    key('\x06')
    expect_screen('Tab changes scope')
    key('return 3\r')
    expect_screen('SEARCH RESULTS · 1')
    key('\r')
    expect_screen('+return 3;')
    key('/\t\t\t')  # diff -> paths -> changes -> full reviewed files
    expect_screen('[files;')
    key('\x7f' * 100 + 'context marker 20\r')
    expect_screen('SEARCH RESULTS · 2')
    key('\r')
    expect_screen('3 FILE · AFTER')
    expect_screen('context marker')
    key('b')
    expect_screen('COMPARE · CHOOSE BASE')
    key('j\r')
    expect_screen('COMPARE · CHOOSE TARGET')
    key('\r')
    expect_screen('Range ')
    key('w')
    expect_screen('working tree')
    expect_screen('Updated')
    key('L')
    expect_screen('Logic order applied')
    key('T')
    expect_screen('Dependency lockfiles')
    key('w')
    expect_screen('Wheel lines')
    key('\x7f7\r')
    expect_screen('Review preferences saved')
    key('\x1b')
    pump(.6)
    key('+')
    expect_screen('Sidebar 60 columns')
    key('q')

def pr_navigation_scenario():
    expect_screen('+local pending')
    key('rHEAD~1 HEAD\r')
    expect_screen('Range HEAD~1')
    expect_screen('PR polled')
    assert any('Range HEAD~1' in row for row in screen()), 'Delayed PR discovery replaced the selected range'
    key('q')

def pr_freeze_scenario():
    expect_screen('committed branch')
    expect_screen('+old remote')
    expect_screen('Updated')
    key('f')
    expect_screen('FROZEN')
    with open(os.environ['REVIEW_NEXT_PR'], 'w') as file:
        file.write('next')
    key('\x12')
    expect_screen('NEW PR UPDATE')
    key('p')
    expect_screen('+old remote')
    pump(.3)
    assert not any('+new remote' in row for row in screen()), 'Frozen p followed a newer remote head'
    key('f')
    expect_screen('+new remote')
    key('q')

def checkpoint_quit_scenario():
    expect_screen('+version-one')
    expect_screen('Updated')
    lock = os.environ['REVIEW_STORE_LOCK']
    os.mkdir(lock)
    key('m')
    snapshots = os.environ['REVIEW_SNAPSHOT_DIRECTORY']
    deadline = time.monotonic()+10
    while not (os.path.isdir(snapshots) and os.listdir(snapshots)):
        assert time.monotonic()<deadline, 'Checkpoint never reached the contended store lock'
        pump(.05)
    started = time.monotonic()
    key('q')
    return started

def quit_scenario():
    expect('+version-one')
    expect('Updated')
    expect('FROZEN', key('f'))
    deadline = time.monotonic()+10
    while not freeze_refs():
        assert time.monotonic()<deadline, 'Freeze refs were not written'
        pump(.1)
    with open(os.environ['REVIEW_PAUSE_GIT'], 'w'):
        pass
    with open(os.path.join(root, 'live.txt'), 'w') as file:
        file.write('version-two\n')
    marker = os.environ['REVIEW_GIT_INDEX_MARKER']
    heartbeat = os.environ['REVIEW_GIT_HEARTBEAT']
    deadline = time.monotonic()+10
    while not (os.path.exists(marker) and os.path.exists(heartbeat)):
        assert time.monotonic()<deadline, 'Slow Git refresh never started'
        pump(.1)
    with open(marker) as file:
        scratch = os.path.dirname(os.path.dirname(json.load(file)))
    assert os.path.basename(scratch).startswith('rl-review-live-')
    key('q')
    return scratch

def handoff_scenario():
    expect_screen('+version-one')
    expect_screen('Updated')
    heartbeat = os.environ['REVIEW_GH_HEARTBEAT']
    deadline = time.monotonic()+10
    while not os.path.exists(heartbeat):
        assert time.monotonic()<deadline, 'Slow GitHub process never started'
        pump(.05)
    started = time.monotonic()
    offset = key(os.environ.get('REVIEW_QUIT_KEY', 'q'))
    deadline = started + 2
    while b'\x1b[?1002l' not in output[offset:]:
        assert time.monotonic() < deadline, 'Mouse reporting was not disabled on Quit'
        pump(.001)
    # The terminal can have reports in flight when it receives mouse-off.
    # Include a packet split across separate reads, as in the reported screenshot.
    for packet in ['\x1b[<65;53;31M', '\x1b[<0;51;', '21Mq\x1b[<65;53;32M']:
        os.write(fd, packet.encode())
        pump(.008)
    return started

def shell_scenario():
    expect('RL_SHELL_READY> ')
    if scenario == 'shell-function':
        integration = os.path.join(os.path.dirname(os.path.dirname(cli)), 'shell/rl.zsh')
        key(f'source {shlex.quote(integration)}; rl review --live\r')
    else:
        key(f'{shlex.quote(cli)} review --live\r')
    expect_screen('+version-one')
    expect_screen('Updated')
    start = key('q')
    expect('RL_SHELL_READY> ', start)
    key("printf '\\nSHELL_%s\\n' INPUT_OK\r")
    expect('SHELL_INPUT_OK', start)
    offset = len(output)
    expect('RL_SHELL_READY> ', start)
    key('exit\r')

def terminal_recovery_scenario():
    expect_screen('+version-one')
    expect_screen('Updated')
    start = key('q')
    expect('SHELL_CAN_READ', start)
    key('typing-after-review\r')
    expect('SHELL_TYPED_OK', start)


try:
    size(34, 160)
    if scenario == "mouse":
        mouse_scenario()
    elif scenario == "preview":
        preview_scenario()
    elif scenario == "filter":
        filter_scenario()
    elif scenario == "filter-reopen":
        filter_reopen_scenario()
    elif scenario == "improvements":
        improvements_scenario()
    elif scenario == "pr-navigation":
        pr_navigation_scenario()
    elif scenario == "pr-freeze":
        pr_freeze_scenario()
    elif scenario == "checkpoint-quit":
        quit_started = checkpoint_quit_scenario()
    elif scenario == "quit":
        scratch = quit_scenario()
    elif scenario == "handoff":
        quit_started = handoff_scenario()
    elif scenario in ('shell', 'shell-function'):
        shell_scenario()
    elif scenario in ('terminal-raw', 'terminal-noecho'):
        terminal_recovery_scenario()
    else:
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
    deadline = time.monotonic()+(2.5 if scenario == "quit" else 10)
    while True:
        pump(.1)
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            assert os.waitstatus_to_exitcode(status) == 0, (status, bytes(output[-4000:]))
            break
        assert time.monotonic() < deadline, 'CLI did not quit'
    assert b'\x1b[?1049h' in output, 'Alternate screen not entered'
    assert b'\x1b[?1049l' in output, 'Alternate screen not restored'
    assert b'\x1b[?25h' in output, 'Cursor not restored'
    assert b'\x1b[?1000l' in output and b'\x1b[?1006l' in output, 'Mouse tracking not restored'
    assert b'\x1b[?1002h' in output and b'\x1b[?1002l' in output, 'Held-button mouse tracking not enabled and restored'
    assert termios.tcgetattr(fd)[3] & termios.ICANON, 'Terminal remained in raw mode'
    if scenario == "handoff":
        assert b'SHELL_INPUT_CLEAN' in output, bytes(output[-4000:])
        assert b'^[[<' not in output, 'Late mouse packets were echoed into the shell'
        elapsed = time.monotonic()-quit_started
        assert elapsed < .8, f'Quit waited {elapsed:.3f}s for background work'
        last_heartbeat = os.stat(os.environ['REVIEW_GH_HEARTBEAT']).st_mtime_ns
        time.sleep(.1)
        assert os.stat(os.environ['REVIEW_GH_HEARTBEAT']).st_mtime_ns == last_heartbeat, 'GitHub descendant survived Quit'
        print(f'QUIT_LATENCY={elapsed:.3f}s')
    if scenario == "checkpoint-quit":
        elapsed = time.monotonic()-quit_started
        assert elapsed < .9, f'Contended checkpoint held the terminal for {elapsed:.3f}s'
        os.rmdir(os.environ['REVIEW_STORE_LOCK'])
        deadline = time.monotonic()+5
        metadata = os.environ['REVIEW_CHECKPOINT_STATE']
        while True:
            try:
                with open(metadata) as file:
                    complete = bool(json.load(file)['checkpoints'])
            except FileNotFoundError:
                complete = False
            if complete:
                break
            assert time.monotonic()<deadline, 'Disconnected checkpoint worker did not finish its save'
            time.sleep(.05)
        print(f'QUIT_LATENCY={elapsed:.3f}s')
    if scenario == "quit":
        assert not os.path.exists(scratch), 'Cancelled refresh left its temporary index'
        deadline = time.monotonic()+5
        while freeze_refs():
            assert time.monotonic()<deadline, 'Quit left its private freeze refs'
            time.sleep(.05)
        heartbeat = os.environ['REVIEW_GIT_HEARTBEAT']
        last_heartbeat = os.stat(heartbeat).st_mtime_ns
        time.sleep(.2)
        assert os.stat(heartbeat).st_mtime_ns == last_heartbeat, 'A descendant of cancelled Git is still running'
    print(f'PTY: {scenario} controls, live update, scrolling and terminal cleanup passed')
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
