#!/usr/bin/env python3
import fcntl
import os
import sys
import time


def fail(message):
    sys.stderr.write(f"{message}\n")
    raise SystemExit(64)


args = sys.argv[1:]
if len(args) < 8 or args[0] not in ("--exclusive", "--shared") or args[1] != "--timeout" or args[3] != "--conflict-exit-code" or args[5] != "--no-fork":
    fail("unsupported test flock invocation")

try:
    timeout = float(args[2])
except ValueError:
    fail("invalid test flock timeout")

conflict_exit_code = int(args[4])
lock_path = args[6]
command = args[7:]
fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
deadline = time.monotonic() + timeout
while True:
    try:
        operation = fcntl.LOCK_EX if args[0] == "--exclusive" else fcntl.LOCK_SH
        if os.environ.get("SPORADES_TEST_OPEN_WITHOUT_FLOCK") != "1":
            fcntl.flock(fd, operation | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            raise SystemExit(conflict_exit_code)
        time.sleep(0.025)

flags = fcntl.fcntl(fd, fcntl.F_GETFD)
fcntl.fcntl(fd, fcntl.F_SETFD, flags & ~fcntl.FD_CLOEXEC)
os.environ["SPORADES_TEST_OS_LOCK_FD"] = str(fd)
os.execvp(command[0], command)
