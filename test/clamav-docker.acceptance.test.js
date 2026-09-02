import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const enabled = process.env.SPORADES_REAL_CLAMAV_DOCKER === "1";

test("real Capsule image acquires signatures and scans only over its local Unix socket", { skip: !enabled }, () => {
  const image = `sporades-clamav-acceptance:${process.pid}`;
  const volume = `sporades-clamav-acceptance-${process.pid}`;
  const identityData = mkdtempSync(path.join(tmpdir(), "sporades-clamav-uid-"));
  let primaryFailure;
  const script = String.raw`
set -eu
test ! -e /tmp/sporades-clamd.sock
/usr/bin/freshclam --config-file=/etc/clamav/freshclam.conf
test -s /app/data/clamav/daily.cld -o -s /app/data/clamav/daily.cvd
/usr/bin/freshclam --daemon --foreground=true --config-file=/etc/clamav/freshclam.conf >/tmp/freshclam.log 2>&1 &
freshclam_pid=$!
/usr/sbin/clamd --foreground --config-file=/etc/clamav/clamd.conf >/tmp/clamd.log 2>&1 &
clamd_pid=$!
trap 'kill -TERM "$clamd_pid" "$freshclam_pid" 2>/dev/null || true; wait "$clamd_pid" "$freshclam_pid" 2>/dev/null || true' EXIT INT TERM
kill -0 "$freshclam_pid"
for attempt in $(seq 1 100); do test -S /tmp/sporades-clamd.sock && break; sleep .1; done
test -S /tmp/sporades-clamd.sock
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
  try {
    const build = spawnSync("docker", ["build", "-f", "Dockerfile.base", "-t", image, "."], { encoding: "utf8", timeout: 10 * 60_000 }); assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const run = spawnSync("docker", ["run", "--rm", "--entrypoint", "/bin/sh", image, "-ec", script], { encoding: "utf8", timeout: 10 * 60_000 }); assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    for (let restart = 0; restart < 2; restart += 1) { const lifecycle = spawnSync("docker", ["run", "--rm", "-e", "SPORADES_CLAMAV_MANAGED=1", ...(restart === 1 ? ["-e", "SPORADES_SMOKE_REPLACEMENT=1"] : []), "-v", `${volume}:/app/data`, "-v", `${path.resolve()}:/src:ro`, "--entrypoint", "node", image, "/src/test/fixtures/clamav-runtime-smoke.mjs"], { encoding: "utf8", timeout: 10 * 60_000 }); assert.equal(lifecycle.status, 0, `${lifecycle.stdout}\n${lifecycle.stderr}`); }
    const runtimeUid = process.getuid(); const runtimeGid = process.getgid();
    const identityLifecycle = spawnSync("docker", ["run", "--rm", "--user", `${runtimeUid}:${runtimeGid}`, "-e", "SPORADES_CLAMAV_MANAGED=1", "-e", `SPORADES_EXPECT_RUNTIME_UID=${runtimeUid}`, "-v", `${identityData}:/app/data`, "-v", `${path.resolve()}:/src:ro`, "--entrypoint", "node", image, "/src/test/fixtures/clamav-runtime-smoke.mjs"], { encoding: "utf8", timeout: 10 * 60_000 }); assert.equal(identityLifecycle.status, 0, `${identityLifecycle.stdout}\n${identityLifecycle.stderr}`);
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanupFailures = [];
    for (const [kind, name] of [["volume", volume], ["image", image]]) { const removed = spawnSync("docker", [kind, "rm", "-f", name], { encoding: "utf8", timeout: 30_000 }); if (removed.status !== 0 && !/No such/i.test(`${removed.stdout}\n${removed.stderr}`)) cleanupFailures.push(new Error(`Failed to remove Docker ${kind} ${name}: ${removed.stderr || removed.stdout}`)); const inspect = spawnSync("docker", [kind, "inspect", name], { encoding: "utf8", timeout: 30_000 }); if (inspect.status === 0) cleanupFailures.push(new Error(`Docker ${kind} ${name} remained after cleanup.`)); }
    try { rmSync(identityData, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
    if (primaryFailure && cleanupFailures.length > 0) throw new AggregateError([primaryFailure, ...cleanupFailures], "ClamAV acceptance and Docker cleanup both failed.");
    if (primaryFailure) throw primaryFailure;
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "ClamAV Docker cleanup failed.");
  }
});
