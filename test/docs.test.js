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
    readProjectFile("src/templates/scaffold-template.js"),
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

test("user guide documents Capsule service reset without blanket Runtime deletion", async () => {
  const userGuide = await readProjectFile("docs/user-guide.md");

  assert.match(userGuide, /sporades dev status --json/);
  assert.match(userGuide, /sporades deploy reset --json/);
  assert.match(userGuide, /does not remove\s+shared third-party service images/);
  assert.doesNotMatch(userGuide, /rm -rf \.sporades/);
});

test("canonical docs describe deferred Hosted Capsule service orchestration contract", async () => {
  const [prd, userGuide, architecture, roadmap] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/architecture.md"),
    readProjectFile("docs/ROADMAP.md"),
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
  assert.match(roadmap, /\.scratch\/docker-compose-capsule-services\/PRD\.md/);
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
