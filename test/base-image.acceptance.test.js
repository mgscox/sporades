import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { baseImageMetadata } from "../dist/base-image.js";

const run = promisify(execFile);

test("Base image runs non-root SSH validation and Unix-only ClamAV without external services", {
  skip: process.env.SPORADES_REAL_BASE_IMAGE !== "1" ? "Set SPORADES_REAL_BASE_IMAGE=1 after building Dockerfile.base locally." : false,
  timeout: 120_000,
}, async (t) => {
  const image = baseImageMetadata().image;
  const script = String.raw`
set -eu
test "$(id -u)" -eq 10001
test "$(id -g)" -eq 10001
test "$(node --version)" = v24.22.1
fail2ban-client --version
ssh-keygen -t ed25519 -f /app/data/host_key -N '' >/dev/null
/usr/sbin/sshd -t -o HostKey=/app/data/host_key -o PidFile=/tmp/sshd.pid
mkdir -p /app/data/clamav
# A deterministic local signature proves scanning without a signature download.
printf '%s\n' 'SporadesCompatibilityProbe:0:*:73706f72616465732d6e6f646532342d7363616e2d70726f6265' > /app/data/clamav/probe.ndb
! grep -Eq '^[[:space:]]*(TCPAddr|TCPSocket)[[:space:]]' /etc/clamav/clamd.conf
/usr/sbin/clamd --foreground --config-file=/etc/clamav/clamd.conf >/tmp/clamd.log 2>&1 &
clamd_pid=$!
trap 'kill -TERM "$clamd_pid" 2>/dev/null || true; wait "$clamd_pid" 2>/dev/null || true' EXIT
ready=0
for attempt in $(seq 1 100); do
  if test -S /tmp/sporades-clamd.sock && printf 'clean evidence' | clamdscan --config-file=/etc/clamav/clamd.conf --stream - >/tmp/clean.out 2>&1; then ready=1; break; fi
  kill -0 "$clamd_pid" || { cat /tmp/clamd.log; exit 1; }
  sleep .1
done
test "$ready" -eq 1 || { cat /tmp/clamd.log /tmp/clean.out; exit 1; }
set +e
printf 'sporades-node24-scan-probe' | clamdscan --config-file=/etc/clamav/clamd.conf --stream - >/tmp/infected.out 2>&1
infected_status=$?
set -e
test "$infected_status" -eq 1 || { cat /tmp/clamd.log /tmp/infected.out; exit 1; }
grep -q 'SporadesCompatibilityProbe.*FOUND' /tmp/infected.out
echo 'Node 24, non-root SSH config, Fail2ban and Unix-only clean/infected scanning passed'
`;
  const name = `sporades-base-compat-${process.pid}`;
  try {
    const result = await run("docker", ["run", "--rm", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
      "--tmpfs", "/app/data:rw,noexec,nosuid,uid=10001,gid=10001,size=32m", image, "sh", "-ec", script], { timeout: 90_000 });
    t.diagnostic(`${image}: ${result.stdout.trim()}`);
  } finally {
    await run("docker", ["rm", "--force", name], { timeout: 10_000 }).catch((error) => {
      if (!/No such container/i.test(error.stderr ?? "")) throw error;
    });
  }
});
