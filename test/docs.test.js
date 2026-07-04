import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readProjectFile(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
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
