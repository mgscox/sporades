import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-create-"));
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

test("sporades create writes a runnable React todo scaffold", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "todo-island")) },
      error: null,
    });

    const projectDir = path.join(dir, "todo-island");
    const entries = await readdir(projectDir);
    assert.deepEqual(
      entries.toSorted(),
      [
        ".env.sporades.server",
        ".gitignore",
        "AGENTS.md",
        "CLAUDE.md",
        "README.md",
        "client",
        "index.html",
        "package.json",
        "server",
        "shared",
        "sporades.json",
      ].toSorted(),
    );

    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.name, "todo-island");
    assert.equal(config.client.framework, "react");
    assert.equal(config.auth.mode, "anonymous");

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /capsule\(/);
    assert.match(serverEntry, /todos: table\(/);
    assert.match(serverEntry, /String\(\)/);
    assert.match(serverEntry, /Boolean\(\)\.default\(false\)/);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /createHooks/);
    assert.match(clientEntry, /useQuery\("todos"\)/);
    assert.match(clientEntry, /useMutation\("addTodo"\)/);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.react, "^19.0.0");
    assert.equal(packageJson.dependencies["react-dom"], "^19.0.0");
    assert.equal(packageJson.devDependencies.sporades, `file:${repoRoot}`);
  });
});

test("sporades/server exports the endpoint builder", async () => {
  const runtime = await import("sporades/server");
  const handler = () => "pong";

  assert.equal(typeof runtime.endpoint, "function");
  assert.deepEqual(runtime.endpoint({ method: "POST", path: "/integrations/ping" }, handler), {
    kind: "endpoint",
    options: { method: "POST", path: "/integrations/ping" },
    handler,
  });
});

test("sporades/server exports the Json field builder", async () => {
  const runtime = await import("sporades/server");
  const field = runtime.Json();

  assert.equal(typeof runtime.Json, "function");
  assert.equal(field.kind, "Json");
  assert.equal(typeof field.default, "function");
  assert.deepEqual(field.default({ tags: ["json"] }), {
    kind: "Json",
    defaultValue: { tags: ["json"] },
  });
});

test("sporades create writes a runnable Preact todo scaffold", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "todo-island", "--framework", "preact", "--no-install", "--no-git", "--json"],
      {
        cwd: dir,
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "todo-island")) },
      error: null,
    });

    const projectDir = path.join(dir, "todo-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.client.framework, "preact");

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /todos: table\(/);
    assert.match(serverEntry, /addTodo: mutation/);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /from "preact"/);
    assert.match(clientEntry, /from "preact\/hooks"/);
    assert.match(clientEntry, /createHooks\(\{ useState, useEffect \}\)/);
    assert.match(clientEntry, /useQuery\("todos"\)/);
    assert.match(clientEntry, /useMutation\("addTodo"\)/);
    assert.match(clientEntry, /onInput=/);
    assert.doesNotMatch(clientEntry, /react-dom/);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.preact, "^10.25.0");
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies["react-dom"], undefined);
    assert.equal(packageJson.devDependencies.sporades, `file:${repoRoot}`);
  });
});

test("sporades create rejects unsupported framework values with structured JSON", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "bad-framework", "--framework", "angular", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unsupported framework: angular",
        hint: "Use one of: react, preact.",
      },
    });
  });
});

test("sporades create rejects unsupported template values with structured JSON", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "bad-template", "--template", "blog", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unsupported template: blog",
        hint: "v0 only supports the todo template.",
      },
    });
  });
});

test("sporades auth status reports anonymous and Google OAuth configuration state", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const anonymousStatus = await runCli(["auth", "status", "--json"], { cwd: projectDir });
    assert.equal(anonymousStatus.code, 0, anonymousStatus.stderr);
    assert.deepEqual(JSON.parse(anonymousStatus.stdout), {
      ok: true,
      data: {
        mode: "anonymous",
        google: {
          configured: false,
          clientIdEnv: null,
          clientSecretEnv: null,
        },
      },
      error: null,
    });

    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "google-client-id", "--client-secret", "super-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);
    assert.doesNotMatch(setResult.stdout, /super-secret/);
    assert.deepEqual(JSON.parse(setResult.stdout), {
      ok: true,
      data: {
        mode: "google",
        google: {
          configured: true,
          clientIdEnv: "GOOGLE_CLIENT_ID",
          clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        },
      },
      error: null,
    });

    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.deepEqual(config.auth, {
      mode: "google",
      google: {
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      },
    });
    assert.doesNotMatch(JSON.stringify(config), /super-secret/);
    const envFile = await readFile(path.join(projectDir, ".env.sporades.server"), "utf8");
    assert.match(envFile, /^GOOGLE_CLIENT_ID=google-client-id$/m);
    assert.match(envFile, /^GOOGLE_CLIENT_SECRET=super-secret$/m);

    const googleStatus = await runCli(["auth", "status", "--json"], { cwd: projectDir });
    assert.equal(googleStatus.code, 0, googleStatus.stderr);
    assert.deepEqual(JSON.parse(googleStatus.stdout).data.google.configured, true);
  });
});
