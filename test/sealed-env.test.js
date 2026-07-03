import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    dockerPath,
    `#!/usr/bin/env node
if (process.argv[2] === "run") {
  process.stdout.write("sealed-container\\n");
}
`,
  );
  await chmod(dockerPath, 0o755);
  return {
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
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
    assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env })).code, 0);

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
    assert.equal(deploy.code, 0, deploy.stderr);

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
