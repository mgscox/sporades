# Runtime timing tests

Keep `SPORADES_CONFIG_DIR` inside the worktree when running CLI tests. On macOS,
use `COPYFILE_DISABLE=1` for archive tests and a short temporary path for Unix
sockets. All infrastructure in the deploy and File ingress test files is local
and synthetic; these files do not need a real Docker daemon or Host server.

```sh
mkdir -p logs/test-config
export SPORADES_CONFIG_DIR="$PWD/logs/test-config"
export COPYFILE_DISABLE=1
runtime_test_tmp=$(mktemp -d /tmp/sp-runtime-XXXXXX)
chmod 700 "$runtime_test_tmp"
chgrp "$(id -g)" "$runtime_test_tmp"
export TMPDIR="$runtime_test_tmp"
node --test --test-concurrency=2 test/deploy.test.js test/file-ingress.test.js
npm run typecheck
npm test
rm -rf "$runtime_test_tmp"
```

The temporary root must belong to the test user's primary group: deploy tests
check that writable Runtime data retains that ownership. A plain `/tmp` root can
inherit a different group on macOS. A temporary root inside this repository also
needs a CommonJS package boundary for extensionless fake executables; a short
private root outside the package avoids that inheritance and Unix-socket limits.

Issue #208 removed two assumptions about scheduling speed:

- The unsafe Container public-tree test used to poll for a new candidate for
  five seconds, then mutate it during a 750 ms fake service-readiness delay.
  Fake Docker now injects the symlink at service readiness, after the Bundle
  pipeline stages the candidate and before public-tree validation. The test
  verifies that the unsafe candidate is discarded and the last successful
  public tree and Container binding survive.
- The PDF lazy-load deadline test used real cold module/worker startup to
  distinguish one-millisecond expiry from a successful two-second retry.
  `test/support/pdf-deadline-probe.mjs` now gates the cold import in a unique
  generated-runtime copy and controls the existing monotonic clock and timeout
  timer seams. It checks timer expiry while loading and checkpoint expiry after
  loading for frozen, backward and forward wall clocks, including concurrent
  requests and a successful retry. The probe still runs the real PDF.js and
  pdf-lib parsers, and removes its temporary runtime copy on completion.

Keep expiry assertions tied to these lifecycle boundaries. Cold module loading,
worker startup and child process scheduling can legitimately exceed an inspection
deadline under load; their speed must not decide whether the test's fixture is
accepted. Production inspection retains its two-second fail-closed deadline.

The ten-round stress run also exposed the ClamAV health/shutdown fixture's real
five-millisecond cleanup budget. That fixture now uses its existing clock/delay
seam while keeping child exit events asynchronous; scheduler delays no longer
consume its synthetic SIGTERM/SIGKILL budget. Runtime termination behavior is
unchanged.
