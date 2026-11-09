import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Only missing prerequisites skip. Failures after the drill starts still fail.
export async function telemetryAcceptancePrerequisite(scenario) {
  let docker;
  try { docker = await run('docker', ['info', '--format', '{{.OSType}} {{.CgroupVersion}}'], { timeout: 5000 }); }
  catch { return 'Docker CLI/daemon unavailable (5s probe).'; }
  if (!docker.stdout.startsWith('linux ')) return 'Docker Linux containers are required.';
  if (process.platform === 'win32') return 'Telemetry Docker acceptance requires a POSIX runner (npm executable, uid/gid and ps); use Linux/WSL or macOS.';
  for (const file of ['../../bin/sporades.js', '../../dist/base-image.js', '../../dist/bundle-pipeline.js',
    '../../dist/cli/host-telemetry-relay.js', '../../dist/templates/server-bundle-module-graph.js']) {
    try { await access(new URL(file, import.meta.url)); }
    catch { return 'Built CLI/runtime unavailable; run npm run build before telemetry acceptance.'; }
  }
  if (scenario !== 'outage') {
    try { await run('npm', ['--version'], { timeout: 5000 }); }
    catch { return 'npm executable unavailable for packed CLI installation (5s probe).'; }
  }
  if (scenario === 'private-ca') {
    try {
      const help = await run('openssl', ['req', '-help'], { timeout: 5000 });
      if (!`${help.stdout}${help.stderr}`.includes('-addext')) return 'OpenSSL req lacks -addext for the disposable private-CA SAN certificate.';
    }
    catch { return 'OpenSSL unavailable for the disposable private CA (5s probe).'; }
  }
  if (scenario === 'outage') {
    const directory = await mkdtemp(new URL('../../.telemetry-prerequisite-', import.meta.url));
    try {
      const file = `${directory}/protected`;
      await writeFile(file, '', { mode: 0o600 });
      await chmod(file, 0o600);
      if ((await stat(file)).mode & 0o077) return 'Fixture filesystem lacks POSIX 0600 permissions for protected monitoring credentials; use a Linux filesystem.';
    } finally { await rm(directory, { recursive: true, force: true }); }
    if (docker.stdout.trim() !== 'linux 2') return 'Monitoring outage acceptance requires Docker cgroup v2 for charged memory evidence.';
    try { await run('docker', ['compose', 'version'], { timeout: 5000 }); }
    catch { return 'Docker Compose unavailable for monitoring outage acceptance (5s probe).'; }
    try { await run('ps', ['-o', 'rss=', '-p', String(process.pid)], { timeout: 5000 }); }
    catch { return 'POSIX ps unavailable for Capsule RSS evidence (5s probe).'; }
  }
  return null;
}
