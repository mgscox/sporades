import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

test("sporades create writes a runnable React blank scaffold by default", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "blank-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "blank-island")), template: "blank" },
      error: null,
    });

    const projectDir = path.join(dir, "blank-island");
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
    assert.equal(config.name, "blank-island");
    assert.equal(config.template, "blank");
    assert.equal(config.client.framework, "react");
    assert.equal(config.auth.mode, "anonymous");

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /capsule\(/);
    assert.match(serverEntry, /schema: \{\}/);
    assert.match(serverEntry, /queries: \{\}/);
    assert.match(serverEntry, /mutations: \{\}/);
    assert.doesNotMatch(serverEntry, /todos|auth|files|messages/);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /createRoot/);
    assert.match(clientEntry, /Blank Sporades Capsule/);
    assert.doesNotMatch(clientEntry, /createHooks|useQuery|useMutation|useAuth|files|messages|todo/i);

    const agents = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
    assert.match(agents, /Template: blank/);
    const readme = await readFile(path.join(projectDir, "README.md"), "utf8");
    assert.match(readme, /A blank Sporades capsule\./);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.react, "^19.0.0");
    assert.equal(packageJson.dependencies["react-dom"], "^19.0.0");
    assert.equal(packageJson.devDependencies.sporades, `file:${repoRoot}`);
  });
});

test("sporades create writes a runnable React todo scaffold when requested", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "todo-island")), template: "todo" },
      error: null,
    });

    const projectDir = path.join(dir, "todo-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.name, "todo-island");
    assert.equal(config.template, "todo");

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /todos: table\(/);
    assert.match(serverEntry, /String\(\)/);
    assert.match(serverEntry, /Boolean\(\)\.default\(false\)/);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /createHooks/);
    assert.match(clientEntry, /useQuery\("todos"\)/);
    assert.match(clientEntry, /useMutation\("addTodo"\)/);

    const agents = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
    assert.match(agents, /Template: todo/);
    const readme = await readFile(path.join(projectDir, "README.md"), "utf8");
    assert.match(readme, /A Sporades todo capsule\./);
  });
});

test("sporades create writes a runnable React guestbook scaffold when requested", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "guest-island", "--template", "guestbook", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "guest-island")), template: "guestbook" },
      error: null,
    });

    const projectDir = path.join(dir, "guest-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.name, "guest-island");
    assert.equal(config.template, "guestbook");

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /entries: table\(/);
    assert.match(serverEntry, /body: String\(\)/);
    assert.match(serverEntry, /authorId: String\(\)/);
    assert.match(serverEntry, /authorName: String\(\)/);
    assert.match(serverEntry, /authorPicture: String\(\)/);
    assert.match(serverEntry, /entries: query/);
    assert.match(serverEntry, /orderBy\("createdAt", "desc"\)/);
    assert.match(serverEntry, /\.limit\(50\)/);
    assert.match(serverEntry, /sign: mutation/);
    assert.match(serverEntry, /body\.trim\(\)/);
    assert.match(serverEntry, /throw new Error\("Write a message before signing\."\)/);
    assert.match(serverEntry, /throw new Error\("Guestbook messages must be 280 characters or fewer\."\)/);
    assert.match(serverEntry, /authorId: ctx\.auth\.userId/);
    assert.match(serverEntry, /authorName: ctx\.auth\.displayName/);
    assert.match(serverEntry, /authorPicture: ctx\.auth\.picture/);
    assert.doesNotMatch(serverEntry, /avatar|upload/i);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /createHooks/);
    assert.match(clientEntry, /useAuth/);
    assert.match(clientEntry, /useQuery\("entries"\)/);
    assert.match(clientEntry, /useMutation\("sign"\)/);
    assert.match(clientEntry, /auth\.signIn\("google"\)/);
    assert.match(clientEntry, /Sign in with Google/);
    assert.doesNotMatch(clientEntry, /providers\.google\?\.configured/);
    assert.match(clientEntry, /authorPicture/);
    assert.doesNotMatch(clientEntry, /better-auth|googleapis|gapi|oauth|accounts\.google|avatar|upload/i);

    const agents = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
    assert.match(agents, /Template: guestbook/);
    const readme = await readFile(path.join(projectDir, "README.md"), "utf8");
    assert.match(readme, /A Sporades guestbook capsule\./);
    assert.match(readme, /Trusted author fields come from `ctx\.auth`/);
  });
});

test("sporades create --template blank writes the blank scaffold", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "blank-island", "--template", "blank", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "blank-island")), template: "blank" },
      error: null,
    });

    const projectDir = path.join(dir, "blank-island");
    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));

    assert.equal(config.template, "blank");
    assert.match(serverEntry, /schema: \{\}/);
    assert.doesNotMatch(serverEntry, /todos|auth|files|messages/);
    assert.match(clientEntry, /Blank Sporades Capsule/);
    assert.doesNotMatch(clientEntry, /useQuery|useMutation|useAuth|files|messages|todo/i);
  });
});

test("sporades create --template blank preserves framework selection", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "blank-island", "--template", "blank", "--framework", "preact", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "blank-island")), template: "blank" },
      error: null,
    });

    const projectDir = path.join(dir, "blank-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.template, "blank");
    assert.equal(config.client.framework, "preact");

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /from "preact"/);
    assert.doesNotMatch(clientEntry, /react-dom|createHooks|useAuth|files|messages|todo/i);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.preact, "^10.25.0");
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies["react-dom"], undefined);
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

test("sporades/server exports the message builder", async () => {
  const runtime = await import("sporades/server");
  const handler = () => ({ ok: true });

  assert.equal(typeof runtime.message, "function");
  assert.deepEqual(runtime.message(handler), {
    kind: "message",
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

test("sporades/server exports the Reference field builder", async () => {
  const runtime = await import("sporades/server");

  assert.equal(typeof runtime.Reference, "function");
  const reference = runtime.Reference("users");
  assert.equal(typeof reference.default, "function");
  assert.deepEqual({ kind: reference.kind, targetTable: reference.targetTable }, {
    kind: "Reference",
    targetTable: "users",
  });
  assert.deepEqual(reference.default("user-1"), {
    kind: "Reference",
    targetTable: "users",
    defaultValue: "user-1",
  });
});

test("sporades create writes a runnable Preact todo scaffold", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "todo-island", "--template", "todo", "--framework", "preact", "--no-install", "--no-git", "--json"],
      {
        cwd: dir,
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "todo-island")), template: "todo" },
      error: null,
    });

    const projectDir = path.join(dir, "todo-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.template, "todo");
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

test("sporades create writes a runnable Preact guestbook scaffold", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "guest-island", "--template", "guestbook", "--framework", "preact", "--no-install", "--no-git", "--json"],
      {
        cwd: dir,
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "guest-island")), template: "guestbook" },
      error: null,
    });

    const projectDir = path.join(dir, "guest-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.template, "guestbook");
    assert.equal(config.client.framework, "preact");

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /from "preact"/);
    assert.match(clientEntry, /from "preact\/hooks"/);
    assert.match(clientEntry, /createHooks\(\{ useState, useEffect \}\)/);
    assert.match(clientEntry, /useQuery\("entries"\)/);
    assert.match(clientEntry, /useMutation\("sign"\)/);
    assert.match(clientEntry, /auth\.signIn\("google"\)/);
    assert.match(clientEntry, /Sign in with Google/);
    assert.doesNotMatch(clientEntry, /providers\.google\?\.configured/);
    assert.match(clientEntry, /onInput=/);
    assert.doesNotMatch(clientEntry, /react-dom|better-auth|googleapis|gapi|oauth|accounts\.google|avatar|upload/i);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.preact, "^10.25.0");
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies["react-dom"], undefined);
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
        hint: "Use one of: blank, todo, guestbook.",
      },
    });
  });
});

test("sporades auth status reports anonymous and Google OAuth configuration state", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
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

test("sporades auth set google can read a Google OAuth client JSON file", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    await writeFile(
      path.join(projectDir, "client_secret_google.json"),
      `${JSON.stringify({
        web: {
          client_id: "json-client-id.apps.googleusercontent.com",
          client_secret: "json-client-secret",
          redirect_uris: ["http://localhost:4000/__sporades/auth/google/callback"],
        },
      })}\n`,
    );

    const setResult = await runCli(["auth", "set", "google", "--client-json", "client_secret_google.json", "--json"], {
      cwd: projectDir,
    });
    assert.equal(setResult.code, 0, setResult.stderr);
    assert.doesNotMatch(setResult.stdout, /json-client-secret/);
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

    const envFile = await readFile(path.join(projectDir, ".env.sporades.server"), "utf8");
    assert.match(envFile, /^GOOGLE_CLIENT_ID=json-client-id\.apps\.googleusercontent\.com$/m);
    assert.match(envFile, /^GOOGLE_CLIENT_SECRET=json-client-secret$/m);
  });
});

test("sporades auth set google rejects invalid OAuth client JSON files", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    await writeFile(path.join(projectDir, "client_secret_google.json"), `${JSON.stringify({ web: { client_id: "only-id" } })}\n`);

    const result = await runCli(["auth", "set", "google", "--client-json", "client_secret_google.json", "--json"], {
      cwd: projectDir,
    });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "OAuth client JSON is missing Google client credentials.",
        hint: "Use a Google OAuth Web application JSON file containing `web.client_id` and `web.client_secret`.",
      },
    });
  });
});
