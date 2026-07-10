import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readProjectFile(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-docs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extractShellBlockAfter(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `Expected heading ${heading}`);
  const afterHeading = markdown.slice(start);
  const matches = [...afterHeading.matchAll(/```sh\n([\s\S]*?)\n```/g)];
  const scriptBlock = matches.find((match) => match[1].startsWith("#!/usr/bin/env bash\n"));
  assert.ok(scriptBlock, `Expected executable shell block after ${heading}`);
  return scriptBlock[1];
}

async function runShell(scriptPath, options) {
  return new Promise((resolve) => {
    const child = spawn("bash", [scriptPath], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("canonical docs describe the implemented platform scope", async () => {
  const [prd, context, endpointAdr, envAdr, fieldBuilderAdr, authAdr, scaffoldTemplate] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("CONTEXT.md"),
    readProjectFile("docs/adr/0007-no-endpoints-in-v0.md"),
    readProjectFile("docs/adr/0001-env-file-mount-for-v0.md"),
    readProjectFile("docs/adr/0002-capitalised-field-builders.md"),
    readProjectFile("docs/adr/0005-better-auth-server-side-anonymous.md"),
    readProjectFile("src/templates/scaffold-template.ts"),
  ]);

  const staleClaims = [
    /v0 scope:[\s\S]*?No remote hosting, no PaaS API, no TLS/i,
    /No endpoints in v0/i,
    /v0 does not include `endpoint\(\)`/i,
    /Schema-version-locked: hash changes -> drop and recreate/i,
    /hash changes -> drop and recreate/i,
    /Data is lost on schema change/i,
    /v1 will support incremental migrations/i,
    /Future field types:\s*`Number\(\)`, `Date\(\)`, `Json\(\)`/i,
    /Container hardening is deferred to post-v2 platform hardening work/i,
    /Hardened base images and container filesystems:/i,
  ];

  for (const pattern of staleClaims) {
    assert.doesNotMatch(prd, pattern);
    assert.doesNotMatch(context, pattern);
  }

  for (const required of [
    "Implemented scope",
    "Hosted Capsules",
    "Custom endpoints",
    "File storage",
    "App messages",
    "Additive migrations",
    "practical Docker hardening defaults",
    "Caddy automatic HTTPS",
    ".scratch/post-v2-platform-hardening-and-ops/",
  ]) {
    assert.match(prd, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  for (const required of ["Hosted Capsule", "Automatic TLS", "App message", "File metadata", "Schema migration"]) {
    assert.match(context, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  assert.match(endpointAdr, /Status:\s*Superseded/i);
  assert.match(endpointAdr, /Custom endpoints/i);
  assert.match(envAdr, /Status:\s*Superseded/i);
  assert.match(envAdr, /Hosted Capsule release/i);
  assert.doesNotMatch(fieldBuilderAdr, /Future field types/i);
  assert.match(fieldBuilderAdr, /Number\(\)/);
  assert.match(fieldBuilderAdr, /Date\(\)/);
  assert.match(fieldBuilderAdr, /Json\(\)/);
  assert.match(authAdr, /Status:\s*Superseded/i);
  assert.match(authAdr, /runtime-owned auth/i);
  assert.doesNotMatch(authAdr, /Sporades uses Better Auth on the server/i);

  assert.doesNotMatch(scaffoldTemplate, /No endpoints in v0/i);
  assert.doesNotMatch(scaffoldTemplate, /WebSocket only/i);
  assert.match(scaffoldTemplate, /Use endpoints only for HTTP integrations/i);
});

test("published docs describe the complete Job scheduling contract", async () => {
  const [prd, context, guide, roadmap, serverSource, serverDeclarations, apiSchedule, apiDefinition] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("CONTEXT.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("src/server.ts"),
    readProjectFile("src/types/server.d.ts"),
    readProjectFile("docs/api/functions/server.schedule.html"),
    readProjectFile("docs/api/types/server.ScheduleDefinition.html"),
  ]);

  for (const published of [prd, guide]) {
    assert.match(published, /five-field cron/i);
    assert.match(published, /IANA timezone/i);
    assert.match(published, /`skip`[\s\S]*`latest`/i);
    assert.match(published, /at least once/i);
    assert.match(published, /Privileged server role/i);
    assert.match(published, /duplicate/i);
    assert.match(published, /sporades\s+schedules/);
    assert.match(published, /sporades\s+deploy schedules/);
    assert.match(published, /sporades\s+host schedules/);
    assert.match(published, /JSON-only/i);
  }

  assert.match(guide, /payload factor(?:y|ies)[\s\S]*may run more than once/i);
  assert.match(guide, /remov(?:e|ing)[\s\S]*fresh identity/i);
  assert.match(guide, /`availableAt`[\s\S]*not recurring/i);
  assert.match(guide, /import \{ capsule, job, schedule \} from "sporades\/server"/);
  assert.match(guide, /sendDigest:\s*job\(/);
  assert.match(guide, /jobs:\s*\{[\s\S]*sendDigest[\s\S]*schedules:\s*\{/);
  assert.match(context, /\*\*Schedule\*\*:/);
  assert.match(context, /\*\*Scheduled occurrence\*\*:/);
  assert.match(roadmap, /\| Job scheduling \| implemented \|/);
  assert.doesNotMatch(roadmap, /Recurring Job scheduling remains a dependent design item/);
  assert.doesNotMatch(roadmap, /required by future Job scheduling/);
  assert.doesNotMatch(roadmap, /Job scheduling remains a dependent roadmap track/);
  assert.match(prd, /\.scratch\/job-scheduling\/PRD\.md/);

  for (const api of [serverSource, serverDeclarations]) {
    assert.match(api, /export (?:declare )?function schedule/);
    assert.match(api, /numeric five-field cron/i);
    assert.match(api, /server-only/i);
    assert.match(api, /missedRun\?: "skip" \| "latest"/);
  }
  assert.match(apiSchedule, /numeric five-field cron/i);
  assert.match(apiSchedule, /at-least-once/i);
  assert.match(apiDefinition, /server-only recurring Job declaration/i);
});

test("Hetzner provisioning script reuses an existing SSH key with the local fingerprint", async () => {
  const hostProvisioning = await readProjectFile("docs/agents/host-provisioning.md");
  const script = extractShellBlockAfter(hostProvisioning, "## Provider script: Hetzner Cloud");

  await withTempDir(async (dir) => {
    const binDir = path.join(dir, "bin");
    await mkdir(binDir);
    const publicKeyPath = path.join(dir, "id_ed25519.pub");
    const callsPath = path.join(dir, "hcloud-calls.log");
    const scriptPath = path.join(dir, "provision-hetzner.sh");
    await writeFile(publicKeyPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey user@workstation\n");
    await writeFile(scriptPath, script);

    await writeFile(
      path.join(binDir, "ssh-keygen"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "256 MD5:aa:bb:cc:dd fake-key (ED25519)"
`,
    );
    await chmod(path.join(binDir, "ssh-keygen"), 0o755);

    await writeFile(
      path.join(binDir, "hcloud"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$HCLOUD_CALLS"
created_path="$HCLOUD_CALLS.created"
case "$*" in
  "ssh-key list -o columns=id,name,fingerprint -o noheader")
    printf '101 user@ubuntu aa:bb:cc:dd\\n'
    ;;
  "server list -o columns=id,name -o noheader")
    if [ -f "$created_path" ]; then
      printf '999 sporades-host-01\\n'
    fi
    ;;
  server\\ create*)
    touch "$created_path"
    exit 0
    ;;
  "server describe 999 -o json")
    printf '{"public_net":{"ipv4":{"ip":"203.0.113.42"}}}\\n'
    ;;
  *)
    echo "unexpected hcloud call: $*" >&2
    exit 17
    ;;
esac
`,
    );
    await chmod(path.join(binDir, "hcloud"), 0o755);

    const result = await runShell(scriptPath, {
      cwd: dir,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        HCLOUD_CALLS: callsPath,
        HCLOUD_TOKEN: "test-token",
        SPORADES_SSH_KEY_NAME: "workstation",
        SPORADES_SSH_PUBLIC_KEY: publicKeyPath,
      },
    });

    assert.equal(result.code, 0, result.stderr);
    const calls = await readFile(callsPath, "utf8");
    assert.match(calls, /^ssh-key list -o columns=id,name,fingerprint -o noheader$/m);
    assert.doesNotMatch(calls, /ssh-key create/);
    assert.match(calls, /server create[\s\S]*--ssh-key 101/);
  });
});

test("Host provisioning shared install script enables fail2ban for sshd", async () => {
  const hostProvisioning = await readProjectFile("docs/agents/host-provisioning.md");
  const script = extractShellBlockAfter(hostProvisioning, "## Shared script: install Sporades Host server");

  assert.match(script, /apt-get install -y ca-certificates curl fail2ban gnupg tar/);
  assert.match(script, /\/etc\/fail2ban\/jail\.d\/sporades-sshd\.conf/);
  assert.match(script, /systemctl enable --now fail2ban/);
  assert.match(script, /fail2ban-client status sshd/);
});

test("Host installation docs keep Fail2ban hardening separate from SSH audit truth", async () => {
  const serverInstallation = await readProjectFile("docs/server-installation.md");

  assert.match(serverInstallation, /Fail2ban protects the Host server's own `sshd` service/i);
  assert.match(serverInstallation, /hardening-adjacent telemetry/i);
  assert.match(serverInstallation, /not the audit source of truth/i);
});

test("SSH daemon session-log scanner spike records the parser and cursor decision", async () => {
  const spike = await readProjectFile(".scratch/privileged-audit-event-contract/ssh-daemon-session-log-scanner-spike.md");

  assert.match(spike, /OpenSSH `sshd -E` can write authentication and session facts/i);
  assert.match(spike, /Docker Desktop was not running/i);
  assert.match(spike, /\/app\/data\/ssh\/sshd\.log/);
  assert.match(spike, /\/app\/data\/ssh\/sshd-audit-cursor\.json/);

  for (const eventName of [
    "ssh.auth.succeeded",
    "ssh.auth.failed",
    "ssh.session.opened",
    "ssh.session.closed",
  ]) {
    assert.match(spike, new RegExp(eventName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const required of [
    "username",
    "remoteAddress",
    "keyFingerprint",
    "source: `sshd`",
    "Unknown daemon log lines",
    "full public keys",
    "raw daemon log lines",
    "private key material",
    "environment values",
    "Proceed",
  ]) {
    assert.match(spike, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("canonical docs describe Host stats without introducing host status", async () => {
  const [userGuide, serverInstallation, architecture] = await Promise.all([
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/server-installation.md"),
    readProjectFile("docs/architecture.md"),
  ]);

  assert.match(userGuide, /sporades host stats --host personal --json/);
  assert.match(userGuide, /sporades host stats team-notes --host personal --json/);
  assert.match(serverInstallation, /host stats --json` returns Host server disk, memory, load, Docker\/Caddy\s+availability/);
  assert.match(serverInstallation, /host\s+stats <subname> --json` returns normalized Docker Container stats/);
  assert.match(architecture, /`sporades host stats` reports Host server resource state/);
  assert.match(architecture, /`sporades host stats <subname>` reports Container stats and lifecycle state/);

  for (const contents of [userGuide, serverInstallation, architecture]) {
    assert.doesNotMatch(contents, /sporades host status/);
  }
});

test("docs describe implemented preferences and Container SSH access", async () => {
  const [roadmap, userGuide, prd, readme, runtimeLayout, sshPrd] = await Promise.all([
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("README.md"),
    readProjectFile("docs/runtime-layout.md"),
    readProjectFile(".scratch/ssh-to-docker/PRD.md"),
  ]);

  assert.match(roadmap, /Recently Implemented/);
  assert.match(roadmap, /User preferences table and SDK \| implemented/);
  assert.match(roadmap, /preferences\.get\(\)/);
  assert.match(roadmap, /preferences\.updated/);
  assert.doesNotMatch(roadmap, /SSH to Docker \| ready/);
  assert.match(roadmap, /SSH to Docker \| implemented/);
  assert.doesNotMatch(
    roadmap,
    /User preferences table and SDK \| ready \| Add a Sporades-owned key-value JSON preferences store/,
  );

  assert.match(userGuide, /const next = await preferences\.update/);
  assert.match(userGuide, /filter\("preferences\.updated"\)/);
  assert.match(userGuide, /The update notification is a convergence signal/);
  assert.match(userGuide, /Container SSH Access/);
  assert.match(userGuide, /"ssh":\s*\{\s*"authorizedKeys":\s*\[\s*\{\s*"key": "ssh-ed25519 AAAA/);
  assert.match(userGuide, /\{\s*"file": "~\/\.ssh\/id_ed25519\.pub"\s*\}/);
  assert.match(userGuide, /`file` entries resolve on the CLI machine/);
  assert.match(userGuide, /absolute paths, `~`, and project-relative paths/);
  assert.match(userGuide, /original\s+source\s+paths\s+are\s+not\s+copied\s+into\s+Hosted\s+Capsule\s+releases/);
  assert.match(userGuide, /OpenSSH `authorized_keys` semantics/);
  assert.match(userGuide, /`sporades` user/);
  assert.match(userGuide, /key-based\s+authentication\s+only/);
  assert.match(
    userGuide,
    /does\s+not\s+provide\s+root\s+login,\s+sudoers\s+access,\s+passwords,\s+custom\s+SSH\s+ports,\s+or\s+public\s+SSH\s+port\s+exposure/,
  );
  assert.match(userGuide, /`sporades deploy ssh`/);
  assert.match(userGuide, /`sporades host ssh`/);
  assert.match(userGuide, /Indicative examples/);
  assert.match(userGuide, /ssh -p <local-port> sporades@127\.0\.0\.1/);
  assert.match(userGuide, /ssh -N -L <local-port>:127\.0\.0\.1:<host-loopback-port> <host-profile-ssh-target>/);
  assert.doesNotMatch(userGuide, /ssh\.enabled/);

  assert.match(prd, /Container SSH access for local Container sessions and Hosted Capsules/);
  assert.match(prd, /opt-in\s+compatibility and emergency access path/);
  assert.match(prd, /same-user convergence signal/);

  assert.match(readme, /Preferences follow the Sporades user identity/);
  assert.match(readme, /Container SSH access is opt-in/);
  assert.doesNotMatch(readme, /The next shaped feature is opt-in SSH access/);
  assert.match(runtimeLayout, /\/app\/data\/ssh\/authorized_keys/);
  assert.match(runtimeLayout, /\.sporades\/ssh\/authorized_keys/);
  assert.match(runtimeLayout, /releases\/\s+<release-id>\/[\s\S]*\.sporades\/ssh\/authorized_keys/);
  assert.match(runtimeLayout, /generated public authorized-key material/);
  assert.match(runtimeLayout, /[Ss]ource `file` paths[\s\S]*are not copied/);
  assert.doesNotMatch(runtimeLayout, /do not currently start an SSH service or publish\s+container port 22/);
  assert.doesNotMatch(runtimeLayout, /Hosted Capsules do not currently publish SSH directly/);

  assert.match(sshPrd, /Status: implemented/i);
  assert.match(sshPrd, /implemented and documented/i);
});

test("docs describe the implemented Privileged audit event contract", async () => {
  const [roadmap, prd, context] = await Promise.all([
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("CONTEXT.md"),
  ]);

  assert.match(roadmap, /Privileged audit event contract \| implemented/);
  assert.doesNotMatch(roadmap, /\| Privileged audit event contract \| design \|/);
  assert.doesNotMatch(roadmap, /Blocked by Privileged audit event contract/);
  assert.match(roadmap, /implemented Privileged audit event contract/);
  assert.match(roadmap, /Real `sshd` auth\/session capture remains future scanner work/);
  assert.match(roadmap, /\.scratch\/privileged-audit-event-contract\/ssh-daemon-session-log-scanner-spike\.md/);
  assert.match(roadmap, /Implemented scheduled Privileged Jobs reuse the existing Privileged audit boundary/);

  assert.match(prd, /Privileged audit event contract for runtime-owned and platform-owned\s+security events/);
  assert.match(prd, /narrow structured JSONL audit\s+surface/);
  assert.match(prd, /not a new audit\s+database/);
  assert.match(prd, /centralized logging replacement/);
  assert.match(prd, /`sporades logs --json`/);
  assert.match(prd, /`sporades logs tail --json`/);
  assert.match(prd, /Host helper JSON/);
  assert.match(prd, /App `ctx\.log` writes\s+normal app log events only/);
  assert.match(prd, /browser\/client credentials do not carry privileged\s+authority/);

  for (const field of [
    "actorKind",
    "operation",
    "surface",
    "targetResourceKind",
    "outcome",
    "safeErrorCode",
    "metadata",
  ]) {
    assert.match(prd, new RegExp(field));
  }

  for (const actorKind of ["platform", "privileged-server-role", "captured-user", "unknown"]) {
    assert.match(prd, new RegExp(actorKind));
  }

  for (const outcome of ["started", "completed", "errored", "finished"]) {
    assert.match(prd, new RegExp(outcome));
  }
  assert.match(prd, /finally/);
  assert.match(prd, /Privileged audit emission is not best-effort/);
  assert.match(prd, /cannot emit a\s+required privileged audit event, the privileged operation throws/);
  assert.match(prd, /original\s+callback error as structured context/);
  assert.match(prd, /callback result as structured context/);
  assert.match(prd, /server-side only/);
  assert.match(prd, /must not be exposed in\s+default client-visible error responses/);
  assert.match(prd, /returns the callback result as-is/);
  assert.match(prd, /does not inspect, sanitize, or\s+classify successful callback return values/);
  assert.match(prd, /caller-supplied `AbortSignal`/);
  assert.match(prd, /privilegedCtx\.signal/);
  assert.match(prd, /fresh per-run\s+non-aborted default signal/);
  assert.match(prd, /must not use a shared\s+long-lived signal/);
  assert.match(prd, /cleaned up when the run\s+reaches `finished`/);
  assert.match(prd, /created and exposed to the callback only after\s+`started` audit emission succeeds/);
  assert.match(prd, /no privileged\s+context is handed out and the callback does not run/);
  assert.match(prd, /Required audit metadata is validated and redacted before `started`/);
  assert.match(prd, /metadata validation,\s+redaction, or generation fails/);
  assert.match(prd, /Metadata generation for `ctx\.privileged\.run\(\.\.\.\)` is synchronous and structural/);
  assert.match(prd, /must not perform\s+async DB, file, storage, network, or service work before `started`/);
  assert.match(prd, /do not introduce new runtime timeout, retry, or cancellation\s+policy/);
  assert.match(prd, /already-aborted signal/);
  assert.match(prd, /stable abort safe\s+error code/);
  assert.match(prd, /signal aborts while the callback is already running/);
  assert.match(prd, /does not interrupt arbitrary callback work/);
  assert.match(prd, /There is no audit-outcome concept of\s+allowed, denied, or\s+skipped/);
  assert.match(prd, /Existing SSH and platform audit emitters must use this same `outcome` vocabulary/);
  assert.match(prd, /the outcome\s+field does not use SSH-specific or legacy success\/failure terms/);
  for (const staleOutcome of ["requested", "allowed", "denied", "succeeded", "failed", "skipped"]) {
    assert.doesNotMatch(prd, new RegExp(`Outcomes use[^.]+${staleOutcome}`));
  }

  for (const redacted of [
    "full public keys",
    "private keys",
    "source key file paths",
    "generated authorized-key contents",
    "Server env values",
    "session tokens",
    "raw daemon logs",
  ]) {
    assert.match(prd, new RegExp(redacted.replaceAll(" ", "\\s+")));
  }

  assert.match(prd, /ssh\.config\.validated/);
  assert.match(prd, /ssh\.access\.enabled/);
  assert.match(prd, /ssh\.access\.disabled/);
  assert.match(prd, /ssh\.state\.inspected/);
  assert.match(prd, /Real\s+SSH login\/session\s+capture from `sshd` remains future scanner work/);
  assert.match(prd, /\.scratch\/privileged-audit-event-contract\/ssh-daemon-session-log-scanner-spike\.md/);
  assert.match(prd, /Security officers should be able to reconstruct incident timelines/);
  assert.match(prd, /verify that browser\s+or app\s+credentials could not forge a privileged event/);
  assert.match(prd, /redacted\s+evidence/);

  assert.match(context, /platform-owned structured JSONL log event/);
  assert.match(context, /current SSH configuration, lifecycle, and inspection events/);
  assert.match(context, /Capsule app `ctx\.log` cannot emit Privileged audit events/);
});

test("docs describe the implemented Privileged server role and Job Queue contracts", async () => {
  const [roadmap, prd, userGuide, apiServer, apiPrivileged, apiJob, apiJobApi, apiClient] = await Promise.all([
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/api/modules/server.html"),
    readProjectFile("docs/api/types/server.PrivilegedApi.html"),
    readProjectFile("docs/api/functions/server.job.html"),
    readProjectFile("docs/api/types/server.JobApi.html"),
    readProjectFile("docs/api/modules/client.html"),
  ]);

  assert.match(roadmap, /Privileged server role \| implemented/);
  assert.doesNotMatch(roadmap, /\| Privileged server role \| design \|/);
  assert.match(roadmap, /Planning remains in `\.scratch\/privileged-server-role\/PRD\.md`/);
  assert.match(roadmap, /Job queue \| implemented[\s\S]*current-user and Privileged server role actors/);
  assert.doesNotMatch(roadmap, /\| Job queue \| ready \|/);
  assert.match(roadmap, /Job scheduling \| implemented[\s\S]*duplicate-protected occurrence creation/);
  assert.doesNotMatch(roadmap, /\| Job scheduling \| ready \|/);
  assert.match(prd, /Runtime-owned Job scheduling through named server-only `schedule\(\)`/);
  assert.doesNotMatch(prd, /Durable persistence, missed-run recovery, reconciliation, and[\s\S]*operator inspection remain pending/);
  assert.doesNotMatch(prd, /Recurring Job scheduling remains future work/);

  const implementedScope = prd.slice(prd.indexOf("### Implemented scope"), prd.indexOf("### Future scope"));
  const futureScope = prd.slice(prd.indexOf("### Future scope"), prd.indexOf("## Product Principles"));
  assert.match(implementedScope, /Privileged server role/);
  assert.match(implementedScope, /`ctx\.privileged\.run\(\.\.\.\)`/);
  assert.match(implementedScope, /runtime-owned Job Queue/);
  assert.match(implementedScope, /current\s+Sporades user or the Privileged server role/);
  assert.match(implementedScope, /retry/);
  assert.match(implementedScope, /cancellation/);
  assert.match(implementedScope, /restart recovery/);
  assert.match(implementedScope, /Runtime-owned Job scheduling/);
  assert.doesNotMatch(futureScope, /- Privileged server role:/);
  assert.doesNotMatch(futureScope, /trusted userless work inside a Capsule/);
  assert.doesNotMatch(futureScope, /Vector storage, Job Queue, and Job scheduling/);
  assert.doesNotMatch(futureScope, /Job scheduling/);

  assert.match(prd, /Privileged server role is implemented/);
  assert.match(prd, /`ctx\.privileged\.run\(\.\.\.\)`/);
  assert.match(prd, /query, mutation, Custom endpoint,\s+App message, context middleware, and supported mutation hook/);
  assert.match(prd, /current user identity/);
  assert.match(prd, /captured user\s+identity/);
  assert.match(prd, /Privileged server role/);
  for (const notA of ["Capsule role", "app admin", "Teams", "user", "session", "browser credential", "service account"]) {
    assert.match(prd, new RegExp(notA));
  }
  for (const outcome of ["started", "completed", "errored", "finished"]) {
    assert.match(prd, new RegExp(outcome));
  }
  assert.match(prd, /Privileged run aborted/);
  assert.match(prd, /generated runtime artifacts/);

  assert.match(userGuide, /Choosing a server actor/);
  assert.match(userGuide, /current user/);
  assert.match(userGuide, /captured user\s+identity/);
  assert.match(userGuide, /Privileged server role/);
  assert.match(userGuide, /`ctx\.privileged\.run\(\.\.\.\)`/);
  assert.match(userGuide, /not a Capsule role, app admin, Team, user, session,\s+service account, or browser credential/);

  assert.match(apiServer, /PrivilegedApi/);
  assert.match(apiServer, /PrivilegedContext/);
  assert.match(apiPrivileged, /ctx\.privileged\.run/);
  assert.match(apiPrivileged, /server-only/);

  for (const command of ["sporades jobs", "sporades deploy jobs", "sporades host jobs"]) {
    assert.match(userGuide, new RegExp(command));
  }
  assert.match(userGuide, /JSON-only/);
  assert.match(userGuide, /all Jobs/);
  assert.match(userGuide, /payloads/);
  assert.match(userGuide, /idempotency-key values/);
  for (const excluded of ["filters", "cursor", "pagination", "human renderer", "offline inspection"]) {
    assert.match(userGuide, new RegExp(excluded));
  }
  for (const status of ["delayed", "queued", "running", "succeeded", "failed", "cancelled"]) {
    assert.match(userGuide, new RegExp(`\\b${status}\\b`));
  }
  assert.match(userGuide, /Only `queued` Jobs are ready to run/);
  assert.match(userGuide, /single worker/);
  assert.match(userGuide, /lease recovery/);
  assert.match(userGuide, /current-user inspection[\s\S]*captured execution actor/i);
  assert.match(userGuide, /Privileged inspection[\s\S]*all Jobs/);
  assert.match(userGuide, /`enqueuedBy`[\s\S]*provenance/);
  assert.match(userGuide, /numeric five-field cron expressions/);
  assert.match(userGuide, /IANA timezone[\s\S]*server timezone[\s\S]*Dev, Container,[\s\S]*Hosted/);
  assert.match(userGuide, /future occurrence calculation only[\s\S]*does not backfill/);
  assert.match(userGuide, /day-of-month and day-of-week[\s\S]*OR behavior/);
  assert.match(userGuide, /spring[\s\S]*no occurrence[\s\S]*repeated fall hour[\s\S]*both matching UTC instants/);
  assert.match(userGuide, /Use `UTC`/);

  assert.match(apiServer, /JobApi/);
  assert.match(apiServer, /JobState/);
  assert.match(apiJob, /server-only Job handler/);
  assert.match(apiJobApi, /enqueue/);
  assert.match(apiJobApi, /get/);
  assert.match(apiJobApi, /list/);
  assert.doesNotMatch(apiClient, /JobApi/);
});

test("docs describe doctor diagnostics as read-only coordination", async () => {
  const [roadmap, userGuide] = await Promise.all([
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("docs/user-guide.md"),
  ]);

  assert.match(userGuide, /## Sporades Doctor/);
  assert.match(userGuide, /sporades doctor --session dev/);
  assert.match(userGuide, /sporades doctor --session container --json/);
  assert.match(userGuide, /sporades doctor --session hosted --host personal --subname team-notes --json/);
  assert.match(userGuide, /sporades doctor --strict --json/);
  assert.match(userGuide, /read-only/i);
  assert.match(userGuide, /does not repair/i);
  assert.match(userGuide, /does not mutate/i);

  for (const command of [
    "sporades security",
    "sporades env",
    "sporades deploy ssh",
    "sporades host health",
    "sporades host stats",
    "sporades host logs",
    "sporades host ssh",
  ]) {
    assert.match(userGuide, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(userGuide, /pass/);
  assert.match(userGuide, /warn/);
  assert.match(userGuide, /fail/);
  assert.match(userGuide, /skip/);
  assert.match(userGuide, /CI/);
  assert.match(userGuide, /AFK agents/);
  assert.match(userGuide, /private keys/i);
  assert.match(userGuide, /full Server env values/i);
  assert.match(userGuide, /full SSH public-key material/i);
  assert.doesNotMatch(userGuide, /sporades doctor repair/);
  assert.doesNotMatch(userGuide, /sporades doctor fix/);

  assert.match(roadmap, /Sporades doctor \| implemented/);
  assert.doesNotMatch(roadmap, /`sporades doctor` \| ready/);
});

test("user guide documents Capsule service reset without blanket Runtime deletion", async () => {
  const userGuide = await readProjectFile("docs/user-guide.md");

  assert.match(userGuide, /sporades dev status --json/);
  assert.match(userGuide, /sporades deploy reset --json/);
  assert.match(userGuide, /does not remove\s+shared third-party service images/);
  assert.doesNotMatch(userGuide, /rm -rf \.sporades/);
});

test("canonical docs describe deferred Hosted Capsule service orchestration contract", async () => {
  const [prd, userGuide, architecture] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/architecture.md"),
  ]);

  assert.match(prd, /first Docker Compose Capsule\s+service implementation is local-only/i);
  assert.match(userGuide, /Hosted Capsule service orchestration is deferred/i);
  assert.match(architecture, /Hosted Capsule service orchestration contract/i);

  for (const required of [
    "service lifecycle",
    "networking",
    "persistence",
    "backup",
    "reset",
    "inspection",
    "failure recovery",
  ]) {
    assert.match(architecture, new RegExp(required, "i"));
  }

  assert.match(architecture, /sporades host/i);
  assert.match(architecture, /new top-level service\s+namespace/i);
  assert.match(architecture, /Portainer/i);
});

test("docs describe MinIO storage services and File reference boundaries", async () => {
  const [prd, userGuide, architecture, runtimeLayout, readme, uploadAdr, fileReferenceAdr, roadmap] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/architecture.md"),
    readProjectFile("docs/runtime-layout.md"),
    readProjectFile("README.md"),
    readProjectFile("docs/adr/0013-high-level-upload-call.md"),
    readProjectFile("docs/adr/0024-file-operations-accept-file-references.md"),
    readProjectFile("docs/ROADMAP.md"),
  ]);

  for (const contents of [prd, userGuide]) {
    assert.match(contents, /"storage":\s*\{\s*"kind": "storage",\s*"engine": "minio"\s*\}/);
    assert.match(contents, /Local filesystem (?:file )?storage remains the default/i);
    assert.match(contents, /files\.storagePath` configures only .*local filesystem/i);
    assert.match(contents, /server-only .*connection env/i);
    assert.match(contents, /must\s+not appear in client bundles or app\s+authoring APIs/i);
  }

  assert.match(userGuide, /path: "\/photos\/profile\.jpg"/);
  assert.match(userGuide, /const defaultBucketFile = await files\.upload\(selectedFile\)/);
  assert.match(userGuide, /Omitting `path`\s+uses the uploaded file name in the Default File bucket/i);
  assert.match(userGuide, /logical `\/default\/upload` File path when no file name exists/i);
  assert.match(userGuide, /Ownership and privacy come from runtime\s+File metadata and ACL behavior, not from the Default File bucket itself/i);
  assert.match(userGuide, /File reference: either\s+the stable File ID or the absolute File path/i);
  assert.match(userGuide, /not a\s+runtime URL, filesystem path, object key, or Object bucket location/i);
  assert.match(userGuide, /not presigned MinIO, S3, or\s+filesystem URLs/i);
  assert.match(userGuide, /File version for cache busting/i);
  assert.match(userGuide, /must not expose filesystem\s+locations, object keys, Object buckets, MinIO connection details, or generated\s+runtime read URLs/i);

  assert.match(prd, /Writing new bytes to an existing\s+live File path overwrites that file, preserves its File ID, and creates a new\s+File version/i);
  assert.match(prd, /Deleting a\s+file frees its File path; a later write to that path creates a new File ID/i);
  assert.match(prd, /Future AWS S3 support should be adapter and configuration wiring/i);
  assert.match(prd, /must not require changes to file runtime\s+call sites, the `files` client SDK, File metadata shape, or app\/client APIs/i);
  assert.match(prd, /Public and private file\s+URLs remain Sporades HTTP routes, not presigned MinIO or S3 URLs/i);
  assert.match(prd, /Local-only Docker Compose Capsule services for declared database and storage\s+service intent/i);
  assert.match(prd, /MinIO-backed\s+S3-compatible file byte storage/i);
  assert.match(prd, /managed\s+external storage backends such as AWS S3/i);
  assert.doesNotMatch(prd, /declared database service\s+intent, shared by Dev sessions/i);
  assert.doesNotMatch(prd, /external database support, and object-storage\s+backends/i);

  assert.match(runtimeLayout, /\.sporades\/services\/storage\//);
  assert.match(runtimeLayout, /bind mount from `\.sporades\/services\/storage\/` to\s+MinIO's `\/data`/);
  assert.match(runtimeLayout, /`files\.storagePath`\s+only changes that local adapter byte directory/i);

  assert.match(architecture, /Local filesystem storage is the default adapter/i);
  assert.match(architecture, /Declaring\s+`services\.storage` with `engine: "minio"`/i);
  assert.match(architecture, /not presigned MinIO or S3 URLs/i);
  assert.match(architecture, /Future AWS S3 support\s+should add adapter and configuration wiring only/i);

  assert.match(readme, /services\.storage\.engine: "minio"/);
  assert.match(readme, /not\s+filesystem paths or presigned MinIO\/S3 URLs/i);
  assert.match(readme, /logical `\/default\/upload` File path when no file name\s+exists/i);
  assert.match(readme, /Default File bucket is only a namespace fallback,\s+not a user bucket or policy boundary/i);
  assert.doesNotMatch(readme, /user in that user's `default` bucket/i);
  assert.doesNotMatch(readme, /\/default\/<generated-id>/i);

  assert.match(uploadAdr, /Status: Superseded in part by ADR-0024/i);
  assert.match(uploadAdr, /Default File bucket is only a\s+logical namespace fallback/i);
  assert.match(uploadAdr, /not a user bucket or policy\s+boundary/i);
  assert.match(uploadAdr, /files\.url\(fileReference\)/);
  assert.doesNotMatch(uploadAdr, /user-scoped `default` bucket/i);
  assert.match(fileReferenceAdr, /replaces the old user-scoped `default` bucket semantics/i);

  assert.match(roadmap, /Managed AWS S3 storage adapter expansion/i);
  assert.match(roadmap, /Local MinIO-backed S3-compatible file byte storage is implemented/i);
  assert.match(roadmap, /extend the existing internal Storage adapter\/config model beyond local MinIO/i);
  assert.doesNotMatch(roadmap, /S3-compatible storage plugin/i);
  assert.doesNotMatch(roadmap, /Allow uploaded bytes to live in S3-compatible object storage/i);
});

test("docs describe Host-generated Sealed Server env custody and lost-key recovery", async () => {
  const [userGuide, architecture, runtimeLayout] = await Promise.all([
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/architecture.md"),
    readProjectFile("docs/runtime-layout.md"),
  ]);

  assert.match(userGuide, /Host private keys never leave the Host server/);
  assert.match(userGuide, /plaintext values never cross the local-to-Host boundary/);
  assert.match(userGuide, /old Host-encrypted envelopes are\s+unrecoverable without that private key/);
  assert.match(userGuide, /sporades host rotate-key/);
  assert.doesNotMatch(userGuide, /sends\s+the matching private key/i);
  assert.doesNotMatch(userGuide, /Host-profile private keys are stored in local\s+Host profile configuration/i);

  assert.match(architecture, /CLI reads public keys and fingerprints, not Host private keys/);
  assert.match(architecture, /re-seal from source-of-truth values/);
  assert.match(runtimeLayout, /inspection reports key fingerprints and availability status without exposing\s+private key material/);
});

test("Host deploy smoke docs import legacy Server env before pushing", async () => {
  const [serverInstallation, hostProvisioning] = await Promise.all([
    readProjectFile("docs/server-installation.md"),
    readProjectFile("docs/agents/host-provisioning.md"),
  ]);

  for (const contents of [serverInstallation, hostProvisioning]) {
    assert.match(contents, /if \[ -f \.\/client_secret_google\.json \]; then\s+sporades auth set google --client-json \.\/client_secret_google\.json --json\s+fi/);
    assert.match(contents, /if \[ -f \.\/\.env\.sporades\.server \]; then\s+sporades env import --file \.env\.sporades\.server --json\s+fi/);
    assert.match(contents, /sporades auth set google --client-json \.\/client_secret_google\.json --json/);
    assert.match(contents, /sporades env import --file \.env\.sporades\.server --json/);
    assert.match(contents, /legacy Server env\s+files?\s+(?:are|is) not pushed directly/i);

    const importIndex = contents.indexOf("sporades env import --file .env.sporades.server --json");
    const pushIndex = contents.indexOf("sporades host push");
    assert(importIndex !== -1);
    assert(pushIndex !== -1);
    assert(importIndex < pushIndex);
  }
});
