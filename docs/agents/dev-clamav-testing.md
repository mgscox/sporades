# Dev ClamAV readiness tests

`test/dev-clamav-sidecar.test.js` runs local Node executables that emulate Docker;
it needs neither Docker nor a Host server. Keep `SPORADES_CONFIG_DIR` inside the
worktree. On macOS, use a short private temporary directory owned by the test
user and group (uid 501 / gid 20 on the team's Mac), with mode 0700. Retain
`COPYFILE_DISABLE=1` for the full suite's archive tests.

```sh
mkdir -p .tmp/clamav-config
clamav_test_tmp=$(mktemp -d /tmp/sp-clamav-XXXXXX)
chmod 700 "$clamav_test_tmp"
chgrp "$(id -g)" "$clamav_test_tmp"
export SPORADES_CONFIG_DIR="$PWD/.tmp/clamav-config"
export TMPDIR="$clamav_test_tmp"
export COPYFILE_DISABLE=1
node --test --test-name-pattern='Dev ClamAV readiness accepts only an exact newline-framed stdout control' test/dev-clamav-sidecar.test.js
node --test test/dev-clamav-sidecar.test.js
npm run typecheck
npm test
rm -rf "$clamav_test_tmp"
```

## Why the framing fixture needs startup headroom

Issue #190 tracked an intermittent assertion on a valid stdout frame. The old
fixture allowed 200 ms for startup. The runtime starts its monotonic deadline
after the Docker child emits `spawn`, before the fake Node executable has
initialized. That same deadline covers stdout readiness proof, a lifecycle
turn, the first `container inspect`, Unix proxy publication, and a second
`container inspect`. Image inspection before `run` and shutdown cleanup are
outside this deadline.

On macOS / Node 24.19.0, twenty consecutive unmodified focused runs passed.
Instrumenting the existing timing hook and fake commands showed ordinary
successful startup spending roughly 77–102 ms in the deadline. Adding 80 ms
of latency to `run` and each liveness inspection reproduced the assertion:
the exact LF proof arrived at 117 ms, leaving 83 ms for an inspection that
also needed process launch plus 80 ms. The inspection timed out, correctly
denying publication despite a valid frame. With the delayed fixture and the
old 200 ms budget, all four valid framing cases failed; the six invalid cases
still rejected. This controlled reproduction demonstrates budget exhaustion;
it does not claim to identify the scheduler conditions of QA's original run.

The framing fixture therefore uses a five-second test-only readiness budget
and retains the 80 ms delays. Successful startup must complete both liveness
checks through the fake Docker executable and bind a real Unix proxy. Invalid frames must
come from a live fake scanner that actually emitted its output, must never
reach liveness checks or proxy creation, and must be cleaned up. Named
subtests identify each framing case independently.

The runtime parser and production timeout are unchanged. LF, CRLF, chunked
stdout, and an exact line among diagnostics remain accepted; stderr,
prefixed/suffixed/embedded markers, and an unterminated frame remain denied.
The separate injected-clock test still checks proof immediately before, at,
and after the deadline. Exit with or immediately after proof, exit during
proxy publication, early exit, timeout, and exact-container cleanup retain
their separate tests. Do not replace these boundaries with a longer timeout
or make the framing test's small wall-clock budget a production requirement.
