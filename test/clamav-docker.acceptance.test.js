import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const enabled = process.env.SPORADES_REAL_CLAMAV_DOCKER === "1";

test("real Capsule image acquires signatures and scans only over its local Unix socket", { skip: !enabled }, () => {
  const image = `sporades-clamav-acceptance:${process.pid}`;
  const build = spawnSync("docker", ["build", "-f", "Dockerfile.base", "-t", image, "."], { encoding: "utf8", timeout: 10 * 60_000 });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const script = String.raw`
set -eu
test ! -e /tmp/sporades-clamav/clamd.sock
/usr/bin/freshclam --config-file=/etc/clamav/freshclam.conf
test -s /app/data/clamav/daily.cld -o -s /app/data/clamav/daily.cvd
/usr/bin/freshclam --daemon --foreground=true --config-file=/etc/clamav/freshclam.conf >/tmp/freshclam.log 2>&1 &
freshclam_pid=$!
/usr/sbin/clamd --foreground --config-file=/etc/clamav/clamd.conf >/tmp/clamd.log 2>&1 &
clamd_pid=$!
trap 'kill -TERM "$clamd_pid" "$freshclam_pid" 2>/dev/null || true; wait "$clamd_pid" "$freshclam_pid" 2>/dev/null || true' EXIT INT TERM
kill -0 "$freshclam_pid"
for attempt in $(seq 1 100); do test -S /tmp/sporades-clamav/clamd.sock && break; sleep .1; done
test -S /tmp/sporades-clamav/clamd.sock
ready=0
for attempt in $(seq 1 100); do if printf 'clean support evidence' | clamdscan --config-file=/etc/clamav/clamd.conf --stream - >/tmp/clean.out 2>&1; then ready=1; break; fi; sleep .1; done
if test "$ready" -ne 1; then cat /tmp/clamd.log /tmp/clean.out >&2; exit 1; fi
set +e
printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' | clamdscan --config-file=/etc/clamav/clamd.conf --stream - >/tmp/infected.out
infected_status=$?
set -e
test "$infected_status" -eq 1
if ! grep -q 'FOUND' /tmp/infected.out; then cat /tmp/clamd.log /tmp/infected.out >&2; exit 1; fi
! grep -Eq '^[[:space:]]*(TCPAddr|TCPSocket)[[:space:]]' /etc/clamav/clamd.conf
kill -TERM "$clamd_pid" "$freshclam_pid"
set +e
wait "$clamd_pid" "$freshclam_pid"
set -e
trap - EXIT INT TERM
! kill -0 "$clamd_pid" 2>/dev/null
! kill -0 "$freshclam_pid" 2>/dev/null
`;
  const run = spawnSync("docker", ["run", "--rm", "--entrypoint", "/bin/sh", image, "-ec", script], { encoding: "utf8", timeout: 10 * 60_000 });
  spawnSync("docker", ["image", "rm", "-f", image], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
