import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { confirmAccessKeyOperatorAction, sanitizeAccessKeyOperatorEnvelope, validateAccessKeyOperatorActionInput } from "../dist/cli/access-key-operator-envelope.js";

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
const revokedEnvelope = {
  ok: true,
  data: {
    capsule: { name: "keys" },
    accessKey: { ...envelope.data.accessKeys[0], status: "revoked", revokedAt: "2026-08-20T12:05:00.000Z", revocationCause: "operator" },
  },
  error: null,
};
const inspectedEnvelope = { ok: true, data: { capsule: { name: "keys" }, accessKey: envelope.data.accessKeys[0] }, error: null };
const run = (args, cwd, env = {}) => spawnSync(process.execPath, [cli, ...args], {
  cwd, env: { ...process.env, ...env }, encoding: "utf8",
});
const confirmationIo = (answer) => {
  const input = new PassThrough(), output = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true });
  Object.defineProperty(output, "isTTY", { value: true });
  input.end(`${answer}\n`);
  return { input, output };
};

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
const input=JSON.parse(Buffer.from(args[3],"base64url"));if(input.userId!=="user-1"||"executionSource" in input||input.options.status!=="active")process.exit(9);
console.log(${JSON.stringify(JSON.stringify(envelope))});`);
    const result = run(["access-keys", "list", "--user-id", "user-1", "--status", "active", "--json"], dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Access-key CLI interactive confirmation accepts exact consent and cancels every other answer", async () => {
  await confirmAccessKeyOperatorAction({ subcommand: "revoke", keyId: "key-1" }, confirmationIo("yes"));
  await assert.rejects(confirmAccessKeyOperatorAction({ subcommand: "delete", keyId: "key-1" }, confirmationIo("no")), /operation cancelled/i);
  await assert.rejects(confirmAccessKeyOperatorAction({ subcommand: "revoke-all", userId: "user-1" }, confirmationIo("yes")), /operation cancelled/i);
  await confirmAccessKeyOperatorAction({ subcommand: "revoke-all", userId: "user-1" }, confirmationIo("user-1"));
});

test("Access-key operator schemas reject aliases, nesting, error extras, and mismatched selectors", () => {
  const invalid = () => { throw new Error("invalid envelope"); };
  const input = { userId: "user-1", options: {} };
  const bearer = `spk_1_${"A".repeat(22)}_${"B".repeat(43)}`;
  for (const hostile of [
    { ...envelope, data: { ...envelope.data, accessToken: "spk_1_secret" } },
    { ...envelope, data: { ...envelope.data, owner: { email: "private@example.com" } } },
    { ok: false, data: { retained: true }, error: { message: "failed", hint: "retry" } },
    { ok: false, data: null, error: { message: "failed", hint: "retry", detail: "adapter secret" } },
    { ...envelope, data: { ...envelope.data, accessKeys: [{ ...envelope.data.accessKeys[0], ownerUserId: "other-user" }] } },
  ]) assert.throws(() => sanitizeAccessKeyOperatorEnvelope(hostile, "access-keys.list", input, invalid), /invalid envelope/);
  assert.throws(() => validateAccessKeyOperatorActionInput("access-keys.list", { ...input, authorization: "Bearer secret" }, invalid), /invalid envelope/);
  const bearerNamedRevocation = {
    ...revokedEnvelope,
    data: { ...revokedEnvelope.data, accessKey: { ...revokedEnvelope.data.accessKey, name: bearer } },
  };
  assert.deepEqual(sanitizeAccessKeyOperatorEnvelope(
    bearerNamedRevocation, "access-keys.revoke", { keyId: "key-1" }, invalid,
  ), bearerNamedRevocation, "valid metadata must not be confused with a disclosed credential");
  assert.deepEqual(sanitizeAccessKeyOperatorEnvelope({
    ok: false, data: null, error: { code: "ACCESS_KEY_ACTION_FAILED", message: `remote adapter detail ${bearer}`, hint: "private@example.com" },
  }, "access-keys.list", input, invalid).error, {
    code: "ACCESS_KEY_ACTION_FAILED",
    message: "Access-key operator action failed.",
    hint: "Check the Privileged audit events and retry the operation.",
  });
});

test("Access-key CLI routes Container and Hosted actions through existing runtime seams", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-cli-routing-"));
  try {
    const bin = path.join(dir, "bin"), config = path.join(dir, "config"), requestLog = path.join(dir, "request.json"), dockerLog = path.join(dir, "docker.log");
    await mkdir(path.join(dir, ".sporades"), { recursive: true }); await mkdir(bin); await mkdir(config);
    await writeFile(path.join(dir, ".sporades", "binding.json"), JSON.stringify({ containerId: "capsule-1" }));
    await writeFile(path.join(config, "hosts.json"), JSON.stringify({ profiles: { live: { server: "host", domain: "example.test", scheme: "https", remoteRoot: "/srv/sporades" } } }));
    const docker = path.join(bin, "docker");
    await writeFile(docker, `#!/bin/sh\necho "$*" >> ${JSON.stringify(dockerLog)}\nif [ "$1" = inspect ]; then echo true; exit 0; fi\nif [ "$1" = exec ]; then\n  case "$*" in *access-keys.revoke*) echo '${JSON.stringify(revokedEnvelope)}' ;; *) echo '${JSON.stringify(inspectedEnvelope)}' ;; esac\n  exit 0\nfi\nexit 9\n`); await chmod(docker, 0o755);
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
    assert.equal("executionSource" in request.accessKeys, false);
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
    await writeFile(path.join(dir, ".sporades", "build", "server.mjs"), `console.log(JSON.stringify({ok:true,data:{capsule:{name:"keys"},accessKeys:[],declaredScopes:[],nextCursor:null,totalCount:0,secret:"spk_1_secret"},error:null}))`);
    const hostile = run(["access-keys", "list", "--user-id", "user-1", "--json"], dir);
    assert.equal(hostile.status, 1);
    assert.match(JSON.parse(hostile.stdout).error.message, /invalid response/);

    const bin = path.join(dir, "bin"), config = path.join(dir, "config");
    await mkdir(bin); await mkdir(config);
    await writeFile(path.join(dir, ".sporades", "binding.json"), JSON.stringify({ containerId: "stopped-capsule" }));
    const docker = path.join(bin, "docker");
    await writeFile(docker, "#!/bin/sh\nif [ \"$1\" = inspect ]; then echo false; exit 0; fi\nexit 9\n");
    await chmod(docker, 0o755);
    const stoppedContainer = run(["access-keys", "list", "--user-id", "user-1", "--session", "container", "--json"], dir, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    });
    assert.equal(stoppedContainer.status, 1);
    assert.match(JSON.parse(stoppedContainer.stdout).error.hint, /deploy restart/);

    await writeFile(path.join(config, "hosts.json"), JSON.stringify({ profiles: { live: { server: "host", domain: "example.test", scheme: "https", remoteRoot: "/srv/sporades" } } }));
    const ssh = path.join(bin, "ssh");
    await writeFile(ssh, `#!/bin/sh\nread input\nprintf '%s\\n' "$input" | ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "bin", "sporades-host-helper.js"))}\n`);
    await chmod(ssh, 0o755);
    const stoppedHosted = run(["access-keys", "list", "--user-id", "user-1", "--session", "hosted", "--host", "live", "--subname", "team-notes", "--json"], dir, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPORADES_CONFIG_DIR: config,
    });
    assert.equal(stoppedHosted.status, 1);
    assert.match(JSON.parse(stoppedHosted.stdout).error.hint, /Start the Hosted Capsule/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
