import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "sporades.js");
const envelope = {
  ok: true,
  data: {
    capsule: { name: "keys" },
    accessKeys: [{
      id: "key-1", ownerUserId: "user-1", name: "automation", grants: ["*"], effectiveScopes: ["requests:read"],
      status: "active", createdAt: "2026-08-20T12:00:00.000Z", expiresAt: null, rotatedAt: null,
      revokedAt: null, revocationCause: null, lastUsedAt: null, lifecycleRevision: 1,
    }],
    declaredScopes: ["requests:read"], nextCursor: null, totalCount: 1,
  },
  error: null,
};
const run = (args, cwd, env = {}) => spawnSync(process.execPath, [cli, ...args], {
  cwd, env: { ...process.env, ...env }, encoding: "utf8",
});

test("Access-key CLI exposes only the five operator commands and JSON does not imply consent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-cli-contract-"));
  try {
    const help = run(["access-keys", "--help"], dir);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /list --user-id/);
    assert.match(help.stdout, /inspect <key-id>/);
    assert.match(help.stdout, /revoke-all --user-id/);
    assert.doesNotMatch(help.stdout, /issue|rotate/);

    for (const unsupported of ["issue", "rotate"]) {
      const result = run(["access-keys", unsupported], dir);
      assert.equal(result.status, 1);
      assert.match(JSON.parse(result.stdout).error.message, /Unknown Access-key operator command/);
    }
    const unconfirmed = run(["access-keys", "revoke", "key-1", "--json"], dir);
    assert.equal(unconfirmed.status, 1);
    assert.match(JSON.parse(unconfirmed.stdout).error.hint, /--yes/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Access-key CLI invokes the generated Bundle for a running Dev session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-cli-dev-"));
  try {
    await mkdir(path.join(dir, ".sporades", "build"), { recursive: true });
    await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ name: "keys" }));
    await writeFile(path.join(dir, ".sporades", "dev-session.json"), JSON.stringify({ pid: process.pid }));
    await writeFile(path.join(dir, ".sporades", "build", "server.mjs"), `
const args=process.argv.slice(2);if(args[0]!=="--sporades-action"||args[1]!=="access-keys.list"||args[2]!=="--sporades-action-input")process.exit(8);
const input=JSON.parse(Buffer.from(args[3],"base64url"));if(input.userId!=="user-1"||input.executionSource!=="operator-cli-dev"||input.options.status!=="active")process.exit(9);
console.log(${JSON.stringify(JSON.stringify(envelope))});`);
    const result = run(["access-keys", "list", "--user-id", "user-1", "--status", "active", "--json"], dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Access-key CLI routes Container and Hosted actions through existing runtime seams", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-cli-routing-"));
  try {
    const bin = path.join(dir, "bin"), config = path.join(dir, "config"), requestLog = path.join(dir, "request.json"), dockerLog = path.join(dir, "docker.log");
    await mkdir(path.join(dir, ".sporades"), { recursive: true }); await mkdir(bin); await mkdir(config);
    await writeFile(path.join(dir, ".sporades", "binding.json"), JSON.stringify({ containerId: "capsule-1" }));
    await writeFile(path.join(config, "hosts.json"), JSON.stringify({ profiles: { live: { server: "host", domain: "example.test", scheme: "https", remoteRoot: "/srv/sporades" } } }));
    const docker = path.join(bin, "docker");
    await writeFile(docker, `#!/bin/sh\necho "$*" >> ${JSON.stringify(dockerLog)}\nif [ "$1" = inspect ]; then echo true; exit 0; fi\nif [ "$1" = exec ]; then echo '${JSON.stringify(envelope)}'; exit 0; fi\nexit 9\n`); await chmod(docker, 0o755);
    const container = run(["access-keys", "revoke", "key-1", "--session", "container", "--yes", "--json"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(container.status, 0, container.stderr || container.stdout);
    assert.match(await readFile(dockerLog, "utf8"), /--sporades-action access-keys\.revoke --sporades-action-input/);

    const ssh = path.join(bin, "ssh");
    await writeFile(ssh, `#!/bin/sh\nread input\necho "$input" > ${JSON.stringify(requestLog)}\nprintf '%s\\n' "$input" | ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "bin", "sporades-host-helper.js"))}\n`); await chmod(ssh, 0o755);
    const hosted = run(["access-keys", "inspect", "key-1", "--session", "hosted", "--host", "live", "--subname", "team-notes", "--json"], dir, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPORADES_CONFIG_DIR: config,
    });
    assert.equal(hosted.status, 0, hosted.stderr || hosted.stdout);
    const request = JSON.parse(await readFile(requestLog, "utf8"));
    assert.equal(request.action, "access-keys.inspect");
    assert.equal(request.accessKeys.keyId, "key-1");
    assert.equal(request.accessKeys.executionSource, "operator-cli-hosted");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Access-key CLI rejects stopped targets and hostile runtime envelopes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-cli-errors-"));
  try {
    const stoppedDev = run(["access-keys", "list", "--user-id", "user-1", "--json"], dir);
    assert.equal(stoppedDev.status, 1);
    assert.match(JSON.parse(stoppedDev.stdout).error.hint, /sporades dev/);

    await mkdir(path.join(dir, ".sporades", "build"), { recursive: true });
    await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ name: "keys" }));
    await writeFile(path.join(dir, ".sporades", "dev-session.json"), JSON.stringify({ pid: process.pid }));
    await writeFile(path.join(dir, ".sporades", "build", "server.mjs"), `console.log(JSON.stringify({ok:true,data:{token:"spk_1_secret"},error:null}))`);
    const hostile = run(["access-keys", "list", "--user-id", "user-1", "--json"], dir);
    assert.equal(hostile.status, 1);
    assert.match(JSON.parse(hostile.stdout).error.message, /invalid response/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
