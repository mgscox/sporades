#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authStatus, createBundle, parseServerEnv, readServerEnvFile } from "../src/bundle-pipeline.js";
import {
  createWebSocketHub,
  dumpDatabase,
  listDatabaseTables,
  openDevDatabase,
  readJsonRequest,
  runReadOnlyQuery,
} from "../src/server-runtime-source.js";

const SUPPORTED_FRAMEWORKS = new Set(["react", "preact"]);
const SUPPORTED_TEMPLATES = new Set(["todo"]);
const DEV_SESSION_FILE = path.join(".sporades", "dev-session.json");
const CONTAINER_BINDING_FILE = path.join(".sporades", "binding.json");
const DEV_REBUILD_DEBOUNCE_MS = 100;
const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

main().catch((error) => {
  writeResult(
    {
      ok: false,
      data: null,
      error: {
        message: error.message,
        hint: error.hint ?? "Check the command arguments and try again.",
      },
    },
    true,
  );
});

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "create") {
    const options = parseCreateArgs(args);
    await createProject(options);

    writeResult({
      ok: true,
      data: { path: options.projectDir },
      error: null,
    });
    return;
  }

  if (command === "dev") {
    await startDevSession(parseDevArgs(args));
    return;
  }

  if (command === "auth") {
    await manageAuth(parseAuthArgs(args));
    return;
  }

  if (command === "deploy") {
    await startContainerSession(parseDeployArgs(args));
    return;
  }

  if (command === "logs") {
    await printLogs(parseLogsArgs(args));
    return;
  }

  if (command === "db") {
    await inspectDatabase(parseDbArgs(args));
    return;
  }

  {
    throw commandError(`Unknown command: ${command ?? ""}`.trim(), "Use `sporades create <name>`.");
  }
}

function parseCreateArgs(args) {
  let name = null;
  let framework = "react";
  let template = "todo";
  let install = true;
  let git = true;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--framework") {
      framework = readFlagValue(args, ++index, "--framework");
      continue;
    }
    if (arg === "--template") {
      template = readFlagValue(args, ++index, "--template");
      continue;
    }
    if (arg === "--no-install") {
      install = false;
      continue;
    }
    if (arg === "--no-git") {
      git = false;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw commandError(`Unknown flag: ${arg}`, "Use `sporades create <name> --help` for supported flags.");
    }
    if (name !== null) {
      throw commandError("Too many positional arguments.", "Use `sporades create <name>`.");
    }
    name = arg;
  }

  if (!name) {
    throw commandError("Missing scaffold name.", "Use `sporades create <name>`.");
  }
  if (!SUPPORTED_FRAMEWORKS.has(framework)) {
    throw commandError(`Unsupported framework: ${framework}`, "Use one of: react, preact.");
  }
  if (!SUPPORTED_TEMPLATES.has(template)) {
    throw commandError(`Unsupported template: ${template}`, "v0 only supports the todo template.");
  }

  return {
    name,
    framework,
    template,
    install,
    git,
    json,
    projectDir: path.resolve(process.cwd(), name),
  };
}

function parseDevArgs(args) {
  let port = null;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--port") {
      const value = Number.parseInt(readFlagValue(args, ++index, "--port"), 10);
      if (Number.isNaN(value) || value < 0) {
        throw commandError("Invalid dev port.", "Pass --port <number>.");
      }
      port = value;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw commandError(`Unknown flag: ${arg}`, "Use `sporades dev --port <number> --json`.");
  }

  return {
    port,
    json,
    projectDir: process.cwd(),
  };
}

function parseDeployArgs(args) {
  let port = null;
  let json = false;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--port") {
      port = readPort(readFlagValue(args, ++index, "--port"));
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    throw commandError(`Unknown flag: ${arg}`, "Use `sporades deploy --port <number> --force --json`.");
  }

  return {
    port,
    force,
    json,
    projectDir: process.cwd(),
  };
}

function parseAuthArgs(args) {
  const [subcommand] = args;
  const provider = subcommand === "set" ? args[1] : null;
  const rest = subcommand === "set" ? args.slice(2) : args.slice(1);
  let json = false;
  let clientId = null;
  let clientSecret = null;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--client-id") {
      clientId = readFlagValue(rest, ++index, "--client-id");
      continue;
    }
    if (arg === "--client-secret") {
      clientSecret = readFlagValue(rest, ++index, "--client-secret");
      continue;
    }
    throw commandError(`Unknown flag: ${arg}`, "Use `sporades auth status` or `sporades auth set google`.");
  }

  if (subcommand === "status") {
    return { subcommand, json, projectDir: process.cwd() };
  }
  if (subcommand === "set" && provider === "google") {
    if (!clientId || !clientSecret) {
      throw commandError(
        "Missing Google OAuth credentials.",
        "Run `sporades auth set google --client-id <id> --client-secret <secret>`.",
      );
    }
    return { subcommand, provider, clientId, clientSecret, json, projectDir: process.cwd() };
  }

  throw commandError("Unknown auth command.", "Use `sporades auth status` or `sporades auth set google`.");
}

function parseLogsArgs(args) {
  let json = false;
  let port = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      port = readPort(readFlagValue(args, ++index, "--port"));
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw commandError(`Unknown flag: ${arg}`, "Use `sporades logs --json`.");
  }

  return {
    json,
    port,
    projectDir: process.cwd(),
  };
}

function parseDbArgs(args) {
  const [subcommand, ...rest] = args;
  let json = false;
  let port = null;
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--port") {
      port = readPort(readFlagValue(rest, ++index, "--port"));
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    positional.push(arg);
  }

  if (subcommand === "list" || subcommand === "dump") {
    if (positional.length > 0) {
      throw commandError("Too many positional arguments.", `Use \`sporades db ${subcommand} --json\`.`);
    }
    return { subcommand, json, port, projectDir: process.cwd() };
  }

  if (subcommand === "query") {
    if (positional.length === 0) {
      throw commandError("Missing SQL query.", "Use `sporades db query <sql>`.");
    }
    return { subcommand, sql: positional.join(" "), json, port, projectDir: process.cwd() };
  }

  throw commandError(
    `Unknown db command: ${subcommand ?? ""}`.trim(),
    "Use `sporades db list`, `sporades db dump`, or `sporades db query <sql>`.",
  );
}

function readPort(value) {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port <= 0) {
    throw commandError("Invalid port.", "Pass --port <number>.");
  }
  return port;
}

function readFlagValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw commandError(`Missing value for ${flag}.`, `Pass ${flag} <value>.`);
  }
  return value;
}

async function createProject(options) {
  await mkdir(options.projectDir, { recursive: false });

  const files = scaffoldFiles(options);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const filePath = path.join(options.projectDir, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents);
    }),
  );

  if (options.install) {
    run("npm", ["install"], options.projectDir, "Dependency install failed.", "Run `npm install` inside the scaffold.");
  }
  if (options.git) {
    run("git", ["init"], options.projectDir, "Git initialization failed.", "Run `git init` inside the scaffold.");
  }
}

async function startDevSession(options) {
  const config = await readProjectConfig(options.projectDir);
  const port = options.port ?? config.dev?.port ?? config.deploy?.port ?? 4000;
  const bundle = await createBundle(options.projectDir, config);

  const logStore = createLogStore();
  const ctx = {
    log: createLogger(logStore),
  };
  ctx.log.info("Dev session started");
  const sessionFilePath = path.join(options.projectDir, DEV_SESSION_FILE);
  const databasePath = path.join(options.projectDir, ".sporades", "data.db");
  const runtime = await createDevRuntime({
    databasePath,
    serverSource: bundle.serverRuntime.source,
    serverEnv: bundle.serverRuntime.env,
    config,
  });
  const websocketHub = createWebSocketHub(() => runtime.database);

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://127.0.0.1");

      if (request.method === "POST" && requestUrl.pathname === "/__sporades/debug/ctx-log") {
        ctx.log.info("ctx.log is available");
        writeJsonResponse(response, 200, {
          ok: true,
          data: { log: ["info", "warn", "error"] },
          error: null,
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/__sporades/debug/logs") {
        writeJsonResponse(response, 200, {
          ok: true,
          data: { entries: logStore.entries },
          error: null,
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/__sporades/debug/db/list") {
        writeJsonResponse(response, 200, {
          ok: true,
          data: { tables: listDatabaseTables(runtime.database) },
          error: null,
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/__sporades/debug/db/dump") {
        writeJsonResponse(response, 200, {
          ok: true,
          data: { tables: dumpDatabase(runtime.database) },
          error: null,
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/__sporades/debug/db/query") {
        const body = await readJsonRequest(request);
        writeJsonResponse(response, 200, runReadOnlyQuery(runtime.database, body.sql));
        return;
      }

      if (request.url === "/" || request.url === "/index.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(await readFile(bundle.staticFiles.indexHtml, "utf8"));
        return;
      }

      if (request.url === "/client.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(await readFile(bundle.staticFiles.clientBundle, "utf8"));
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.message);
    }
  });
  server.on("upgrade", (request, socket) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (requestUrl.pathname !== "/__sporades/ws") {
      socket.destroy();
      return;
    }
    websocketHub.accept(request, socket);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://localhost:${actualPort}`;
  await writeFile(
    sessionFilePath,
    `${JSON.stringify(
      {
        url,
        port: actualPort,
        pid: process.pid,
      },
      null,
      2,
    )}\n`,
  );
  emitDevEvent(options, { event: "started", url, port: actualPort });

  const watchers = watchDevInputs(options.projectDir, async () => {
    try {
      const rebuild = await createBundle(options.projectDir, config);
      await runtime.restart(rebuild.serverRuntime.source, rebuild.serverRuntime.env, config);
      websocketHub.disconnectAll();
      emitDevEvent(options, {
        event: "rebuild",
        status: "success",
        url,
        port: actualPort,
      });
    } catch (error) {
      ctx.log.error("Dev rebuild failed", { message: error.message });
      emitDevEvent(
        options,
        {
          event: "rebuild",
          status: "failed",
          url,
          port: actualPort,
        },
        {
          message: error.message,
          hint: error.hint ?? "Fix the build error and save again.",
        },
      );
    }
  });

  const shutdown = () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    websocketHub.disconnectAll();
    server.close(async () => {
      await rm(sessionFilePath, { force: true });
      await runtime.shutdown();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function createDevRuntime(options) {
  let database = await openDevDatabase(options.databasePath, options.serverSource, options.serverEnv, options.config);

  return {
    get database() {
      return database;
    },
    async restart(serverSource, serverEnv, config) {
      const nextDatabase = await openDevDatabase(options.databasePath, serverSource, serverEnv, config);
      database.close();
      database = nextDatabase;
    },
    async shutdown() {
      database.close();
    },
  };
}

function watchDevInputs(projectDir, onChange) {
  const watchedPaths = [
    path.join(projectDir, "server"),
    path.join(projectDir, "client"),
    path.join(projectDir, "shared"),
    path.join(projectDir, "index.html"),
    path.join(projectDir, "sporades.json"),
  ];
  const watchers = [];
  let debounceTimer = null;

  const schedule = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onChange, DEV_REBUILD_DEBOUNCE_MS);
  };

  for (const watchedPath of watchedPaths) {
    try {
      watchers.push(watch(watchedPath, { recursive: true }, schedule));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return watchers;
}

function emitDevEvent(options, data, error = null) {
  if (options.json) {
    writeResult({
      ok: error === null,
      data,
      error,
    });
    return;
  }

  if (data.event === "started") {
    process.stdout.write(`Sporades dev session started at ${data.url}\n`);
    return;
  }
  if (data.status === "success") {
    process.stdout.write(`Sporades dev session rebuilt at ${data.url}\n`);
    return;
  }
  process.stdout.write(`Sporades dev rebuild failed: ${error.message}\n`);
}

async function manageAuth(options) {
  if (options.subcommand === "status") {
    const config = await readProjectConfig(options.projectDir);
    const envPath = path.join(options.projectDir, ".env.sporades.server");
    const serverEnv = parseServerEnv(await readServerEnvFile(envPath));
    const status = authStatus(config, serverEnv);
    if (options.json) {
      writeResult({ ok: true, data: status, error: null });
    } else {
      process.stdout.write(`Auth mode: ${status.mode}\n`);
      process.stdout.write(`Google OAuth: ${status.google.configured ? "configured" : "not configured"}\n`);
    }
    return;
  }

  const configPath = path.join(options.projectDir, "sporades.json");
  const config = await readProjectConfig(options.projectDir);
  config.auth = {
    mode: "google",
    google: {
      clientIdEnv: "GOOGLE_CLIENT_ID",
      clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await upsertServerEnvValues(path.join(options.projectDir, ".env.sporades.server"), {
    GOOGLE_CLIENT_ID: options.clientId,
    GOOGLE_CLIENT_SECRET: options.clientSecret,
  });

  const status = authStatus(config, {
    GOOGLE_CLIENT_ID: options.clientId,
    GOOGLE_CLIENT_SECRET: options.clientSecret,
  });
  if (options.json) {
    writeResult({ ok: true, data: status, error: null });
  } else {
    process.stdout.write("Google OAuth configured.\n");
  }
}

async function startContainerSession(options) {
  const config = await readProjectConfig(options.projectDir);
  const port = options.port ?? config.deploy?.port ?? 4000;
  const bundle = await createBundle(options.projectDir, config);
  const runtimeDir = path.join(options.projectDir, ".sporades");
  const dataDir = path.join(runtimeDir, "data");
  await mkdir(dataDir, { recursive: true });

  const containerName = `sporades-${config.name ?? path.basename(options.projectDir)}`;
  const bindingPath = path.join(options.projectDir, CONTAINER_BINDING_FILE);
  const existingBinding = await readContainerBinding(bindingPath);

  if (existingBinding?.containerId) {
    runDockerCleanup(
      ["stop", existingBinding.containerId],
      options.projectDir,
      "Failed to stop the existing container session.",
      "Check Docker is running. If the bound container was deleted manually, retry with `sporades deploy --force`.",
      options.force,
    );
    runDockerCleanup(
      ["rm", existingBinding.containerId],
      options.projectDir,
      "Failed to remove the existing container session.",
      "Remove the old container manually or retry with `sporades deploy --force`.",
      options.force,
    );
  }

  const envArgs = bundle.containerMounts.serverEnv
    ? [
        "--volume",
        formatMount(bundle.containerMounts.serverEnv),
        "--env-file",
        bundle.containerMounts.serverEnv.host,
      ]
    : [];
  const bundleMountArgs = bundle.containerMounts.files.flatMap((mount) => ["--volume", formatMount(mount)]);
  const containerId = runDocker(
    [
      "run",
      "--detach",
      "--name",
      containerName,
      "--publish",
      `${port}:4000`,
      ...bundleMountArgs,
      ...envArgs,
      "--volume",
      `${dataDir}:/app/data`,
      "--workdir",
      "/app",
      "--env",
      "PORT=4000",
      "node:22-alpine",
      "node",
      "/app/server.mjs",
    ],
    options.projectDir,
    "Failed to start the container session.",
    "Check Docker is running, then retry `sporades deploy`.",
  );

  const binding = {
    containerId,
    containerName,
  };
  await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);

  const url = `http://localhost:${port}`;
  if (options.json) {
    writeResult({ ok: true, data: { url, port, containerId }, error: null });
  } else {
    process.stdout.write(`Sporades container session started at ${url}\n`);
  }
}

async function inspectDatabase(options) {
  if (options.subcommand === "query" && !isReadOnlySql(options.sql)) {
    throw commandError(
      "Only read-only SQL is allowed.",
      "Use a SELECT, WITH, or PRAGMA query for `sporades db query`.",
    );
  }

  const session = options.port ? { url: `http://localhost:${options.port}` } : await readDevSession(options.projectDir);
  const result =
    options.subcommand === "query"
      ? await fetchDevSessionJson(session, "/__sporades/debug/db/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sql: options.sql }),
        })
      : await fetchDevSessionJson(session, `/__sporades/debug/db/${options.subcommand}`);

  if (options.json) {
    writeResult(result, !result.ok);
    return;
  }

  if (!result.ok) {
    throw commandError(result.error.message, result.error.hint);
  }

  if (options.subcommand === "list") {
    for (const table of result.data.tables) {
      process.stdout.write(`${table}\n`);
    }
    return;
  }

  if (options.subcommand === "dump") {
    process.stdout.write(`${JSON.stringify(result.data.tables, null, 2)}\n`);
    return;
  }

  if (options.subcommand === "query") {
    process.stdout.write(`${JSON.stringify(result.data.rows, null, 2)}\n`);
  }
}

async function printLogs(options) {
  const session = options.port ? { url: `http://localhost:${options.port}` } : await readDevSession(options.projectDir);
  const result = await fetchDevSessionJson(session, "/__sporades/debug/logs");

  if (options.json) {
    writeResult(result, !result.ok);
    return;
  }

  if (!result.ok) {
    throw commandError(result.error.message, result.error.hint);
  }

  for (const entry of result.data.entries) {
    process.stdout.write(`[${entry.level}] ${entry.message}\n`);
  }
}

async function readDevSession(projectDir) {
  const sessionPath = path.join(projectDir, DEV_SESSION_FILE);
  const raw = await readRequiredFile(
    sessionPath,
    "No running Sporades dev session found.",
    "Start one with `sporades dev` from this project, then retry the command.",
  );
  try {
    return JSON.parse(raw);
  } catch {
    throw commandError(
      "Invalid Sporades dev session metadata.",
      "Restart the dev session with `sporades dev`, then retry the command.",
    );
  }
}

async function fetchDevSessionJson(session, pathname, fetchOptions = {}) {
  try {
    const response = await fetch(new URL(pathname, session.url), fetchOptions);
    return await response.json();
  } catch {
    throw commandError(
      "Unable to reach the running Sporades dev session.",
      "Check that `sporades dev` is still running in this project, then retry the command.",
    );
  }
}

async function upsertServerEnvValues(envPath, values) {
  const existing = await readServerEnvFile(envPath);
  const lines = existing.raw ? existing.raw.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));
  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0 || trimmed.startsWith("#")) {
      return line;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    if (!pending.has(key)) {
      return line;
    }
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of pending) {
    nextLines.push(`${key}=${value}`);
  }
  await writeFile(envPath, `${nextLines.filter((line, index) => line || index < nextLines.length - 1).join("\n")}\n`);
  parseServerEnv(await readServerEnvFile(envPath));
}

function isReadOnlySql(sql) {
  return /^\s*(select|with|pragma)\b/i.test(sql);
}

async function readProjectConfig(projectDir) {
  const configPath = path.join(projectDir, "sporades.json");
  const raw = await readRequiredFile(
    configPath,
    "Missing project configuration: sporades.json",
    "Run `sporades create` to scaffold a new project.",
  );
  try {
    return JSON.parse(raw);
  } catch {
    throw commandError("Invalid project configuration: sporades.json", "Fix the JSON syntax in sporades.json.");
  }
}

async function readRequiredFile(filePath, message, hint) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw commandError(message, hint);
    }
    throw error;
  }
}

async function readContainerBinding(bindingPath) {
  try {
    return JSON.parse(await readFile(bindingPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw commandError(
        "Invalid container binding metadata.",
        "Delete .sporades/binding.json or fix its JSON, then retry `sporades deploy`.",
      );
    }
    throw error;
  }
}

function scaffoldFiles(options) {
  const packageName = options.name;
  const sporadesDependency = scaffoldSporadesDependency();
  const frameworkDependencies =
    options.framework === "react"
      ? {
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        }
      : {
          preact: "^10.25.0",
        };

  return {
    "sporades.json": `${JSON.stringify(
      {
        name: options.name,
        client: { framework: options.framework },
        auth: { mode: "anonymous" },
        deploy: { port: 4000 },
        dev: { port: null },
      },
      null,
      2,
    )}\n`,
    "package.json": `${JSON.stringify(
      {
        name: packageName,
        private: true,
        type: "module",
        scripts: {
          dev: "sporades dev",
          deploy: "sporades deploy",
        },
        dependencies: frameworkDependencies,
        devDependencies: {
          sporades: sporadesDependency,
          typescript: "^5.8.0",
        },
      },
      null,
      2,
    )}\n`,
    "AGENTS.md": agentsTemplate(),
    "CLAUDE.md": agentsTemplate(),
    "README.md": `# ${options.name}\n\nA Sporades todo capsule.\n`,
    ".gitignore": "node_modules/\n.sporades/\n.env*.local\n",
    ".env.sporades.server": "# Server-only environment variables for Sporades.\n",
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(options.name)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/client.js"></script>
  </body>
</html>
`,
    "server/index.ts": `import { Boolean, capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: ${JSON.stringify(options.name)},

  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all(),
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });
    }),
  },
});
`,
    "client/index.tsx": clientTemplate(options.framework),
    "shared/types.ts": `export type Todo = {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
};
`,
  };
}

function scaffoldSporadesDependency() {
  return `file:${CLI_ROOT}`;
}

function clientTemplate(framework) {
  if (framework === "preact") {
    return `import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { createHooks } from "sporades/client";

const { useQuery, useMutation } = createHooks({ useState, useEffect });

function App() {
  const todos = useQuery("todos");
  const addTodo = useMutation("addTodo");
  const [text, setText] = useState("");

  return (
    <main>
      <h1>Sporades Todos</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) {
            addTodo.run(text.trim());
            setText("");
          }
        }}
      >
        <input value={text} onInput={(event) => setText(event.currentTarget.value)} />
        <button type="submit">Add todo</button>
      </form>
      <ul>
        {(todos.data ?? []).map((todo) => (
          <li key={todo.id}>{todo.text}</li>
        ))}
      </ul>
    </main>
  );
}

render(<App />, document.getElementById("app")!);
`;
  }

  return `import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createHooks } from "sporades/client";

const { useQuery, useMutation } = createHooks({ useState, useEffect });

function App() {
  const todos = useQuery("todos");
  const addTodo = useMutation("addTodo");
  const [text, setText] = useState("");

  return (
    <main>
      <h1>Sporades Todos</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) {
            addTodo.run(text.trim());
            setText("");
          }
        }}
      >
        <input value={text} onChange={(event) => setText(event.currentTarget.value)} />
        <button type="submit">Add todo</button>
      </form>
      <ul>
        {(todos.data ?? []).map((todo) => (
          <li key={todo.id}>{todo.text}</li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
`;
}

function agentsTemplate() {
  return `# Sporades App Instructions

This directory is for a Sporades app. Sporades is a CLI-first tool for building and running full-stack web apps.

## Rules

- Server code goes in \`server/\`, client code in \`client/\`, shared code in \`shared/\`.
- Use \`sporades/server\` only from \`server/*.ts\`.
- Use \`sporades/client\` only from \`client/*.tsx\`.
- Data is accessed through queries. Changes go through mutations.
- No endpoints in v0 - WebSocket only.
- No file-based routing. Use the router included in the scaffold template.
- All imports must be from Sporades, the configured framework, or relative paths.
- Do not use Node built-ins in client code.
- Auth is available via \`ctx.auth\` on the server, \`useAuth()\` on the client.
- Server env vars: define in \`.env.sporades.server\`, access via \`ctx.env\`.
- Keep \`shared/\` free of DOM, Node, env, and Sporades runtime imports.

## Commands

\`\`\`sh
sporades dev
sporades deploy
sporades logs
sporades db list
sporades db dump
\`\`\`

## Structure

- \`server/index.ts\` - schema, queries, mutations
- \`client/index.tsx\` - UI entrypoint
- \`shared/\` - pure TypeScript shared by client and server
- \`index.html\` - HTML shell (user-owned)
- \`sporades.json\` - project configuration
`;
}

function run(command, args, cwd, message, hint) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw commandError(message, hint);
  }
}

function runDocker(args, cwd, message, hint) {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw commandError(message, hint);
  }
  return result.stdout.trim();
}

function runDockerCleanup(args, cwd, message, hint, force = false) {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  if (force && isMissingDockerContainerError(result)) {
    return "";
  }
  throw commandError(message, hint);
}

function formatMount(mount) {
  return `${mount.host}:${mount.container}${mount.mode ? `:${mount.mode}` : ""}`;
}

function isMissingDockerContainerError(result) {
  return /No such container/i.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
}

function commandError(message, hint) {
  const error = new Error(message);
  error.hint = hint;
  return error;
}

function createLogStore() {
  return {
    entries: [],
  };
}

function createLogger(logStore) {
  const write = (level, message, data = null) => {
    logStore.entries.push({
      level,
      message: String(message),
      data,
      timestamp: new Date().toISOString(),
    });
  };

  return {
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
  };
}

function writeJsonResponse(response, status, result) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(result)}\n`);
}

function writeResult(result, failed = false) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (failed) {
    process.exitCode = 1;
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char];
  });
}
