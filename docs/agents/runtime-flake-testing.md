# Runtime timing tests

Keep `SPORADES_CONFIG_DIR` and `TMPDIR` inside the worktree when running CLI
tests. All infrastructure in the deploy and File ingress test files is local
and synthetic; these files do not need a real Docker daemon or Host server.
Tests that need real services retain their explicit opt-in guards.

```sh
mkdir -p .tmp .dev-config
export SPORADES_CONFIG_DIR="$PWD/.dev-config"
export TMPDIR="$PWD/.tmp"
# Prevent AppleDouble archive entries on macOS.
export COPYFILE_DISABLE=1
node --test --test-concurrency=1 test/admission-lifecycle-proof.test.js test/file-ingress.test.js
npm run typecheck
npm test
```

Unix socket fixtures use `test/support/unix-socket-path.js`. It keeps a short
absolute pathname when possible and otherwise uses a pathname relative to the
shared working directory, bounded to 100 UTF-8 bytes for Darwin and Linux.
The socket stays inside its unique, owned fixture directory. Listeners and
clients (including child processes) must retain the same working directory.
Checkout depth and a worktree-local `TMPDIR` do not consume the socket budget.

Synthetic Host and Monitoring fixtures use `test/support/fixture-umask.js` to
model protected installation paths under a known `0022` umask. The helper
restores the caller's umask after each fixture. Tests that deliberately change
permissions or exercise `0077` continue to do so; production permission checks
remain active. Extensionless fake Node executables must also declare their
CommonJS or ES-module package boundary instead of inheriting the checkout's.

Prerender fixtures use `test/support/prerender-fixture-root.js` to declare their
own default CommonJS package and neutral TypeScript configuration. This prevents
a worktree-local temporary project from inheriting Sporades's ES-module package
or strict compiler settings. Tests for other settings replace these boundaries
explicitly.

`test/support/host-fixture-root.js` selects a canonical temporary base whose
real ancestor ownership and permissions meet the Host contract. It first tries
`TMPDIR`, then the system temporary directory, then the user home directory.
Each fixture receives a unique private directory and removes only that owned
directory. Host route fixtures permit root-owned sticky temporary ancestors;
backup secret fixtures require a fully non-writable ancestor chain, so they may
need the private home-directory fallback. Fixtures never chmod shared ancestors
or mock permission checks. Their CLI configuration stays in a separate, unique
worktree-local directory and is removed with the fixture. They never read real
Host or Telemetry profiles.

The temporary root must belong to the test user's primary group: deploy tests
check that writable Runtime data retains that ownership. A temporary root can
inherit a different group on macOS.

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
