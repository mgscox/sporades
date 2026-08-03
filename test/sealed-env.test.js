import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-sealed-env-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    }

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

test("sporades env set reads one value from stdin and preserves every existing sealed key", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "set-env-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "set-env-island");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "EXISTING_TOKEN=keep-me\nREPLACED_TOKEN=old-value\n");
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir })).code, 0);

    const setResult = await runCli(["env", "set", "REPLACED_TOKEN", "--stdin", "--json"], {
      cwd: projectDir,
      stdin: "new-value\n",
    });
    assert.equal(setResult.code, 0, setResult.stderr);
    assert.doesNotMatch(`${setResult.stdout}${setResult.stderr}`, /new-value|keep-me|old-value/);
    const output = JSON.parse(setResult.stdout).data;
    assert.equal(output.configured, true);
    assert.equal(output.keyCount, 2);
    assert.match(output.publicKeyFingerprint, /^[a-f0-9]{16}$/);
    assert.match(output.envelopePath, /\/sealed-server-env\/server-env\.sealed\.json$/);
    assert.match(output.privateKeyPath, /\/sealed-server-env\/server-env\.private\.pem$/);
    assert.equal(output.set, true);
    assert.equal(output.name, "REPLACED_TOKEN");
    assert.equal(output.privateKeyConfigured, true);

    const envelope = JSON.parse(await readFile(path.join(projectDir, ".sporades", "sealed-server-env", "server-env.sealed.json"), "utf8"));
    assert.deepEqual(Object.keys(envelope.entries).sort(), ["EXISTING_TOKEN", "REPLACED_TOKEN"]);
    assert.doesNotMatch(JSON.stringify(envelope), /new-value|keep-me|old-value/);

    await installFakeReact(projectDir);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "set-env-island",
  endpoints: {
    env: endpoint({ method: "GET", path: "/env" }, (ctx) => ({
      status: 200,
      body: { existing: ctx.env.EXISTING_TOKEN, replaced: ctx.env.REPLACED_TOKEN }
    }))
  }
});
`,
    );
    const docker = await installFakeDocker(dir);
    const deploy = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deploy.code, 0, `${deploy.stderr}\n${deploy.stdout}`);
    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
        SPORADES_SEALED_SERVER_ENV_PATH: path.join(projectDir, ".sporades", "sealed-server-env", "server-env.sealed.json"),
        SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH: path.join(projectDir, ".sporades", "sealed-server-env", "server-env.private.pem"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const response = await waitForHttp(`http://127.0.0.1:${port}/env`, child);
      assert.deepEqual(await response.json(), { existing: "keep-me", replaced: "new-value" });
    } finally {
      await stopChild(child);
    }
  });
});

test("sporades env has reports key presence through its exit status without printing values", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "has-env-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "has-env-island");
    const setResult = await runCli(["env", "set", "SECRET_TOKEN", "--stdin", "--json"], {
      cwd: projectDir,
      stdin: "swordfish\n",
    });
    assert.equal(setResult.code, 0, setResult.stderr);

    const present = await runCli(["env", "has", "SECRET_TOKEN", "--json"], { cwd: projectDir });
    assert.equal(present.code, 0, present.stderr);
    assert.deepEqual(JSON.parse(present.stdout).data, { name: "SECRET_TOKEN", defined: true });
    assert.doesNotMatch(`${present.stdout}${present.stderr}`, /swordfish/);

    const absent = await runCli(["env", "has", "MISSING_TOKEN", "--json"], { cwd: projectDir });
    assert.equal(absent.code, 1, absent.stderr);
    assert.deepEqual(JSON.parse(absent.stdout).data, { name: "MISSING_TOKEN", defined: false });
  });
});

test("sporades env set enforces the 64KB total Server env limit without changing existing values", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "bounded-env-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "bounded-env-island");
    await writeFile(path.join(projectDir, ".env.sporades.server"), `EXISTING_TOKEN=${"a".repeat(40 * 1024)}\n`);
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir })).code, 0);

    const rejected = await runCli(["env", "set", "NEW_TOKEN", "--stdin", "--json"], {
      cwd: projectDir,
      stdin: "b".repeat(30 * 1024),
    });
    assert.equal(rejected.code, 1);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /64KB total/);
    assert.equal((await runCli(["env", "has", "EXISTING_TOKEN"], { cwd: projectDir })).code, 0);
    assert.equal((await runCli(["env", "has", "NEW_TOKEN"], { cwd: projectDir })).code, 1);
  });
});

test("concurrent sporades env set commands preserve and reseal every sibling value", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "concurrent-env-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "concurrent-env-island");
    assert.equal((await runCli(["env", "init", "--json"], { cwd: projectDir })).code, 0);

    const names = Array.from({ length: 8 }, (_, index) => `CONCURRENT_TOKEN_${index}`);
    const results = await Promise.all(names.map((name, index) => runCli(["env", "set", name, "--stdin", "--json"], {
      cwd: projectDir,
      stdin: `value-${index}\n`,
    })));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    for (const name of names) {
      const present = await runCli(["env", "has", name, "--json"], { cwd: projectDir });
      assert.equal(present.code, 0, `${name}: ${present.stderr}`);
      assert.equal(JSON.parse(present.stdout).data.defined, true);
    }
  });
});

test("sporades env rejects prototype-sensitive key names from stdin and legacy files", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "prototype-env-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "prototype-env-island");

    const setResult = await runCli(["env", "set", "__proto__", "--stdin", "--json"], {
      cwd: projectDir,
      stdin: "not-a-prototype\n",
    });
    assert.equal(setResult.code, 1);
    assert.match(`${setResult.stdout}${setResult.stderr}`, /Invalid Server env key name/);

    await writeFile(path.join(projectDir, ".env.sporades.server"), "__proto__=not-a-prototype\n");
    const importResult = await runCli(["env", "import", "--json"], { cwd: projectDir });
    assert.equal(importResult.code, 1);
    assert.match(`${importResult.stdout}${importResult.stderr}`, /invalid key __proto__/i);
  });
});

test("concurrent env setters recover one stale mutation lock without overlapping", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "stale-lock-env-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "stale-lock-env-island");
    assert.equal((await runCli(["env", "init", "--json"], { cwd: projectDir })).code, 0);
    const lockDir = path.join(projectDir, ".sporades", "sealed-server-env", ".mutation-lock");
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({ pid: 2_147_483_647, token: "abandoned" })}\n`);

    const names = Array.from({ length: 8 }, (_, index) => `RECOVERED_TOKEN_${index}`);
    const results = await Promise.all(names.map((name, index) => runCli(["env", "set", name, "--stdin", "--json"], {
      cwd: projectDir,
      stdin: `value-${index}`,
    })));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    for (const name of names) {
      assert.equal((await runCli(["env", "has", name], { cwd: projectDir })).code, 0, name);
    }
  });
});

async function installFakeReact(projectDir) {
  await writePackage(
    projectDir,
    "react",
    {
      ".": "./index.js",
      "./jsx-runtime": "./jsx-runtime.js",
    },
    {
      "index.js": "export function useEffect() {}\nexport function useState(value) { return [value, () => {}]; }\n",
      "jsx-runtime.js":
        "export const Fragment = Symbol.for('react.fragment');\nexport function jsx(type, props) { return { type, props }; }\nexport const jsxs = jsx;\n",
    },
  );
  await writePackage(
    projectDir,
    "react-dom",
    {
      "./client": "./client.js",
    },
    {
      "client.js": "export function createRoot() { return { render() {} }; }\n",
    },
  );
}

async function installFakeDocker(dir) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const dockerPath = path.join(fakeBinDir, "docker");
  const logPath = path.join(dir, "docker-calls.jsonl");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    dockerPath,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args }) + "\\n");
const calls = readFileSync(process.env.FAKE_DOCKER_LOG, "utf8").trim().split("\\n").map(JSON.parse);
if (args[0] === "run") {
  process.stdout.write("sealed-container\\n");
  process.exit(0);
}
if (args[0] === "inspect" && args.includes("{{json .}}")) {
  const run = calls.filter((call) => call.args[0] === "run").at(-1);
  const labels = {};
  for (let index = 0; index < (run?.args.length ?? 0); index += 1) {
    if (run.args[index] !== "--label") continue;
    const [key, ...value] = run.args[index + 1].split("=");
    labels[key] = value.join("=");
  }
  process.stdout.write(JSON.stringify({
    Id: args.at(-1),
    Name: "/" + run.args[run.args.indexOf("--name") + 1],
    State: { Running: true },
    Config: { User: "10001:10001", Labels: labels },
    NetworkSettings: { Ports: {} }
  }) + "\\n");
  process.exit(0);
}
`,
  );
  await chmod(dockerPath, 0o755);
  return {
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: logPath,
    },
  };
}

async function installContractFakeSsh(dir, scriptBody) {
  const fakeBinDir = path.join(dir, "fake-ssh-bin");
  const logPath = path.join(dir, "ssh-calls.jsonl");
  const sshPath = path.join(fakeBinDir, "ssh");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    sshPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
  ${scriptBody}
});
`,
  );
  await chmod(sshPath, 0o755);
  return {
    fakeBinDir,
    logPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SSH_LOG: logPath,
    },
  };
}

async function writePackage(projectDir, packageName, exports, files) {
  const packageDir = path.join(projectDir, "node_modules", packageName);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: packageName, version: "0.0.0", type: "module", exports }, null, 2)}\n`,
  );
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(path.join(packageDir, name), contents)),
  );
}

async function getAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server bundle exited before serving ${url}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`Unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError;
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await closed;
}

test("sporades env imports legacy Server env into sealed Runtime state without printing values", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "sealed-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "sealed-island");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\nPUBLIC_LABEL=not-client\n");

    const imported = await runCli(["env", "import", "--json"], { cwd: projectDir });
    assert.equal(imported.code, 0, imported.stderr);
    assert.doesNotMatch(imported.stdout, /swordfish|not-client/);
    const output = JSON.parse(imported.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.imported, true);
    assert.equal(output.data.keyCount, 2);
    assert.match(output.data.publicKeyFingerprint, /^[a-f0-9]{16}$/);

    const envelope = JSON.parse(await readFile(path.join(projectDir, ".sporades", "sealed-server-env", "server-env.sealed.json"), "utf8"));
    assert.deepEqual(Object.keys(envelope.entries).sort(), ["PUBLIC_LABEL", "SECRET_TOKEN"]);
    assert.doesNotMatch(JSON.stringify(envelope), /swordfish|not-client|PRIVATE KEY/);
    assert.match(await readFile(path.join(projectDir, ".sporades", "sealed-server-env", "server-env.private.pem"), "utf8"), /PRIVATE KEY/);

    const status = await runCli(["env", "status", "--json"], { cwd: projectDir });
    assert.equal(status.code, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /swordfish|not-client|PRIVATE KEY/);
    assert.equal(JSON.parse(status.stdout).data.configured, true);
  });
});

test("sporades env exports sealed envelopes without private keys or secret values", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "portable-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "portable-island");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir })).code, 0);

    const exported = await runCli(["env", "export", "--output", "sealed-export.json", "--json"], { cwd: projectDir });
    assert.equal(exported.code, 0, exported.stderr);
    assert.doesNotMatch(exported.stdout, /swordfish|PRIVATE KEY/);
    const exportedFile = await readFile(path.join(projectDir, "sealed-export.json"), "utf8");
    assert.doesNotMatch(exportedFile, /swordfish|PRIVATE KEY/);
    assert.equal(JSON.parse(exportedFile).entries.SECRET_TOKEN.ciphertext.length > 0, true);
  });
});

test("sporades env imports exported sealed envelopes without printing private keys or values", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "roundtrip-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "roundtrip-island");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir })).code, 0);
    assert.equal((await runCli(["env", "export", "--output", "sealed-export.json", "--json"], { cwd: projectDir })).code, 0);
    await rm(path.join(projectDir, ".sporades", "sealed-server-env", "server-env.sealed.json"));

    const imported = await runCli(["env", "import", "--sealed", "--file", "sealed-export.json", "--json"], { cwd: projectDir });
    assert.equal(imported.code, 0, imported.stderr);
    assert.doesNotMatch(imported.stdout, /swordfish|PRIVATE KEY/);
    const output = JSON.parse(imported.stdout);
    assert.equal(output.data.imported, true);
    assert.equal(output.data.sealed, true);
    assert.equal(output.data.keyCount, 1);

    await installFakeReact(projectDir);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "roundtrip-island",
  endpoints: {
    env: endpoint({ method: "GET", path: "/env" }, (ctx) => ({
      status: 200,
      body: { token: ctx.env.SECRET_TOKEN }
    }))
  }
});
`,
    );
    const docker = await installFakeDocker(dir);
    const deploy = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deploy.code, 0, `${deploy.stderr}\n${deploy.stdout}`);

    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
        SPORADES_SEALED_SERVER_ENV_PATH: path.join(projectDir, ".sporades", "sealed-server-env", "server-env.sealed.json"),
        SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH: path.join(projectDir, ".sporades", "sealed-server-env", "server-env.private.pem"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const response = await waitForHttp(`http://127.0.0.1:${port}/env`, child);
      assert.deepEqual(await response.json(), { token: "swordfish" });
    } finally {
      await stopChild(child);
    }
  });
});

test("sporades env reencrypt creates Host-profile sealed material without printing values", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "config");
    const createResult = await runCli(["create", "host-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "host-island");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir })).code, 0);
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env: { SPORADES_CONFIG_DIR: configDir } },
        )
      ).code,
      0,
    );

    const reencrypted = await runCli(["env", "reencrypt", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { SPORADES_CONFIG_DIR: configDir },
    });
    assert.equal(reencrypted.code, 0, reencrypted.stderr);
    assert.doesNotMatch(reencrypted.stdout, /swordfish|PRIVATE KEY/);
    const output = JSON.parse(reencrypted.stdout);
    assert.equal(output.data.reencrypted, true);
    assert.equal(output.data.keyCount, 1);

    const hostEnvelope = await readFile(path.join(projectDir, ".sporades", "sealed-server-env", "hosts", "personal.server-env.sealed.json"), "utf8");
    assert.doesNotMatch(hostEnvelope, /swordfish|PRIVATE KEY/);
    const hostConfig = await readFile(path.join(configDir, "hosts.json"), "utf8");
    assert.match(hostConfig, /PRIVATE KEY/);
    assert.doesNotMatch(hostConfig, /swordfish/);

    const current = await runCli(["host", "current", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { SPORADES_CONFIG_DIR: configDir },
    });
    assert.equal(current.code, 0, current.stderr);
    assert.doesNotMatch(current.stdout, /swordfish|PRIVATE KEY/);
    assert.equal(JSON.parse(current.stdout).data.profile.sealedServerEnv.configured, true);
  });
});

test("sporades env reencrypt can target a Hosted Capsule public key for inspection", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "config");
    const hostKeyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const hostPublicKeyFingerprint = createHash("sha256").update(hostKeyPair.publicKey).digest("hex").slice(0, 16);
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.list") {
  process.stdout.write(JSON.stringify({ ok: false, data: null, error: { message: "Unexpected action.", hint: "Use capsule.list." } }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsules: [{
      subname: "team-notes",
      domain: request.host.domain,
      hostedUrl: "https://team-notes." + request.host.domain,
      sealedServerEnv: {
        publicKey: process.env.FAKE_HOST_PUBLIC_KEY,
        publicKeyFingerprint: process.env.FAKE_HOST_PUBLIC_KEY_FINGERPRINT,
        publicKeyPath: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/keys/" + process.env.FAKE_HOST_PUBLIC_KEY_FINGERPRINT + ".public.pem"
      }
    }]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const createResult = await runCli(["create", "hosted-key-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "hosted-key-island");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir })).code, 0);
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env: { SPORADES_CONFIG_DIR: configDir } },
        )
      ).code,
      0,
    );

    const reencrypted = await runCli(["env", "reencrypt", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: {
        SPORADES_CONFIG_DIR: configDir,
        ...fakeSsh.env,
        FAKE_HOST_PUBLIC_KEY: hostKeyPair.publicKey,
        FAKE_HOST_PUBLIC_KEY_FINGERPRINT: hostPublicKeyFingerprint,
      },
    });
    assert.equal(reencrypted.code, 0, reencrypted.stderr);
    assert.doesNotMatch(reencrypted.stdout, /swordfish|PRIVATE KEY/);
    const output = JSON.parse(reencrypted.stdout);
    assert.equal(output.data.reencrypted, true);
    assert.equal(output.data.hostAlias, "personal");
    assert.equal(output.data.subname, "team-notes");
    assert.equal(output.data.publicKeyFingerprint, hostPublicKeyFingerprint);

    const hostEnvelope = await readFile(path.join(projectDir, ".sporades", "sealed-server-env", "hosts", "personal.team-notes.server-env.sealed.json"), "utf8");
    assert.doesNotMatch(hostEnvelope, /swordfish|PRIVATE KEY/);
    assert.equal(JSON.parse(hostEnvelope).publicKeyFingerprint, hostPublicKeyFingerprint);
  });
});

test("sealed Server env remains available to Capsule code through ctx.env", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "runtime-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "runtime-island");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "runtime-island",
  endpoints: {
    env: endpoint({ method: "GET", path: "/env" }, (ctx) => ({
      status: 200,
      body: { token: ctx.env.SECRET_TOKEN }
    }))
  }
});
`,
    );
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir })).code, 0);
    const docker = await installFakeDocker(dir);
    const deploy = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deploy.code, 0, `${deploy.stderr}\n${deploy.stdout}`);

    const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
    assert.doesNotMatch(serverBundle, /swordfish/);

    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
        SPORADES_SEALED_SERVER_ENV_PATH: path.join(projectDir, ".sporades", "sealed-server-env", "server-env.sealed.json"),
        SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH: path.join(projectDir, ".sporades", "sealed-server-env", "server-env.private.pem"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const response = await waitForHttp(`http://127.0.0.1:${port}/env`, child);
      assert.deepEqual(await response.json(), { token: "swordfish" });
    } finally {
      await stopChild(child);
    }
  });
});
