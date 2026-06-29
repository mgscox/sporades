#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_FRAMEWORKS = new Set(["react", "preact"]);
const SUPPORTED_TEMPLATES = new Set(["todo"]);
const DEV_SESSION_FILE = path.join(".sporades", "dev-session.json");
const CONTAINER_BINDING_FILE = path.join(".sporades", "binding.json");
const DEV_REBUILD_DEBOUNCE_MS = 100;
const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRAMEWORK_BUNDLE_CONFIG = {
  react: {
    jsxImportSource: "react",
    jsxRuntimeImport: "react/jsx-runtime",
  },
  preact: {
    jsxImportSource: "preact",
    jsxRuntimeImport: "preact/jsx-runtime",
  },
};

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
  const bundle = await writeBundles(options.projectDir, config);
  const buildDir = bundle.buildDir;
  const indexHtmlPath = bundle.indexHtmlPath;
  const serverSource = bundle.serverSource;
  const serverEnv = bundle.serverEnv;

  const logStore = createLogStore();
  const ctx = {
    log: createLogger(logStore),
  };
  ctx.log.info("Dev session started");
  const sessionFilePath = path.join(options.projectDir, DEV_SESSION_FILE);
  const databasePath = path.join(options.projectDir, ".sporades", "data.db");
  const runtime = await createDevRuntime({ databasePath, serverSource, serverEnv, config });
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
        response.end(await readFile(indexHtmlPath, "utf8"));
        return;
      }

      if (request.url === "/client.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(await readFile(path.join(buildDir, "client.js"), "utf8"));
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
      const rebuild = await writeBundles(options.projectDir, config);
      await runtime.restart(rebuild.serverSource, rebuild.serverEnv, config);
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
  const bundle = await writeBundles(options.projectDir, config);
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

  const envArgs = bundle.envExists
    ? [
        "--volume",
        `${bundle.envPath}:/app/.env.sporades.server:ro`,
        "--env-file",
        bundle.envPath,
      ]
    : [];
  const containerId = runDocker(
    [
      "run",
      "--detach",
      "--name",
      containerName,
      "--publish",
      `${port}:4000`,
      "--volume",
      `${bundle.serverBundlePath}:/app/server.mjs:ro`,
      "--volume",
      `${bundle.clientBundlePath}:/app/client.js:ro`,
      "--volume",
      `${bundle.indexHtmlPath}:/app/index.html:ro`,
      "--volume",
      `${bundle.configPath}:/app/sporades.json:ro`,
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

async function writeBundles(projectDir, config) {
  const frameworkBundleConfig = readFrameworkBundleConfig(config.client?.framework ?? "react");
  const buildDir = path.join(projectDir, ".sporades", "build");
  await mkdir(buildDir, { recursive: true });

  const configPath = path.join(projectDir, "sporades.json");
  const serverSourcePath = path.join(projectDir, "server", "index.ts");
  const clientSourcePath = path.join(projectDir, "client", "index.tsx");
  const indexHtmlPath = path.join(projectDir, "index.html");
  const envPath = path.join(projectDir, ".env.sporades.server");
  const serverBundlePath = path.join(buildDir, "server.mjs");
  const clientBundlePath = path.join(buildDir, "client.js");
  const serverEnvFile = await readServerEnvFile(envPath);
  const serverEnv = parseServerEnv(serverEnvFile);
  validateAuthConfig(config, serverEnv);

  const [serverSource, clientSource] = await Promise.all([
    readRequiredFile(serverSourcePath, "Missing capsule entry: server/index.ts", "Run `sporades create` to scaffold a new project."),
    readRequiredFile(clientSourcePath, "Missing client entry: client/index.tsx", "Run `sporades create` to scaffold a new project."),
    readRequiredFile(indexHtmlPath, "Missing HTML shell: index.html", "Restore index.html or run `sporades create`."),
  ]);

  const clientBundle = await bundleClientSource(clientSource, {
    projectDir,
    clientSourcePath,
    frameworkBundleConfig,
  });

  await Promise.all([
    writeFile(
      serverBundlePath,
      createServerBundleSource({ config, serverEnv, serverSource }),
    ),
    writeFile(clientBundlePath, clientBundle),
  ]);

  return {
    buildDir,
    serverSource,
    serverEnv,
    configPath,
    indexHtmlPath,
    envPath,
    envExists: serverEnvFile.exists,
    serverBundlePath,
    clientBundlePath,
  };
}

function createServerBundleSource({ config, serverEnv, serverSource }) {
  const runtimeFunctions = [
    readJsonRequest,
    openDevDatabase,
    extractSchema,
    extractFields,
    parseFieldDefault,
    toSqlLiteral,
    authStatus,
    createAnonymousAuthTables,
    resolveAnonymousSession,
    sessionFromRow,
    createWebSocketAccept,
    createWebSocketHub,
    drainWebSocketFrames,
    sendJson,
    runQuery,
    runMutation,
    formatMutationResult,
    quoteIdentifier,
  ]
    .map((fn) => fn.toString())
    .join("\n\n");

  return `// Sporades server bundle
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

export const sporadesConfig = ${JSON.stringify(config, null, 2)};
export const sporadesServerEnv = ${JSON.stringify(serverEnv, null, 2)};
export const sporadesServerSource = ${JSON.stringify(serverSource)};

${runtimeFunctions}

const port = Number(process.env.PORT ?? sporadesConfig.deploy?.port ?? 4000);
const databasePath = process.env.SPORADES_DATABASE_PATH ?? path.join(process.cwd(), "data", "data.db");
const database = await openDevDatabase(databasePath, sporadesServerSource, sporadesServerEnv, sporadesConfig);
const websocketHub = createWebSocketHub(() => database);

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/" || request.url === "/index.html") {
      const html = await readRuntimeFile("index.html", path.join(process.cwd(), "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (request.url === "/client.js") {
      const client = await readRuntimeFile("client.js", path.join(process.cwd(), ".sporades", "build", "client.js"));
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(client);
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
  server.listen(port, "0.0.0.0", resolve);
});

const shutdown = () => {
  websocketHub.disconnectAll();
  server.close(() => {
    database.close();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function readRuntimeFile(containerFileName, fallbackPath) {
  try {
    return await readFile(path.join(process.cwd(), containerFileName), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return readFile(fallbackPath, "utf8");
  }
}
`;
}

async function readServerEnvFile(envPath) {
  try {
    const raw = await readFile(envPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
      throw commandError("Invalid server env file.", ".env.sporades.server must be 64KB or smaller.");
    }
    return { exists: true, raw };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, raw: "" };
    }
    throw error;
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

function parseServerEnv(envFile) {
  const values = {};
  for (const [index, line] of envFile.raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      throw commandError("Invalid server env file.", `Fix line ${index + 1} in .env.sporades.server to use KEY=value.`);
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw commandError("Invalid server env file.", `Fix invalid key ${key} in .env.sporades.server.`);
    }
    if (key.startsWith("SPORADES_")) {
      throw commandError("Invalid server env file.", "Remove reserved SPORADES_ keys from .env.sporades.server.");
    }
    values[key] = parseEnvValue(trimmed.slice(equalsIndex + 1).trim());
  }
  if (Object.keys(values).length > 64) {
    throw commandError("Invalid server env file.", ".env.sporades.server can contain at most 64 keys.");
  }
  return values;
}

function parseEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function authStatus(config, serverEnv) {
  const authConfig = config.auth ?? { mode: "anonymous" };
  const google = authConfig.google ?? {};
  const clientIdEnv = google.clientIdEnv ?? null;
  const clientSecretEnv = google.clientSecretEnv ?? null;
  return {
    mode: authConfig.mode ?? "anonymous",
    google: {
      configured: Boolean(clientIdEnv && clientSecretEnv && serverEnv[clientIdEnv] && serverEnv[clientSecretEnv]),
      clientIdEnv,
      clientSecretEnv,
    },
  };
}

function validateAuthConfig(config, serverEnv) {
  const status = authStatus(config, serverEnv);
  if (status.mode !== "google") {
    return;
  }
  if (!status.google.configured) {
    throw commandError(
      "Google OAuth is not fully configured.",
      "Run `sporades auth set google --client-id <id> --client-secret <secret>`.",
    );
  }
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function openDevDatabase(databasePath, serverSource, serverEnv = {}, config = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(databasePath);
  const schema = extractSchema(serverSource);
  const rowCache = new Map();
  const database = {
    sqlite,
    schema,
    rowCache,
    serverEnv,
    authConfig: authStatus(config, serverEnv),
    close: () => sqlite.close(),
  };
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("CREATE TABLE IF NOT EXISTS sporades (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO sporades (key, value) VALUES (?, ?)").run("schemaVersion", "v0");
  createAnonymousAuthTables(sqlite);

  for (const table of schema.tables) {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (` +
        [
          "id TEXT PRIMARY KEY",
          "createdAt TEXT NOT NULL",
          "updatedAt TEXT NOT NULL",
          ...table.fields.map((field) => {
            const defaultSql = field.defaultValue === undefined ? "" : ` DEFAULT ${toSqlLiteral(field.defaultValue)}`;
            return `${quoteIdentifier(field.name)} ${field.sqliteType} NOT NULL${defaultSql}`;
          }),
        ].join(", ") +
        ")",
    );
  }

  return database;
}

function extractSchema(serverSource) {
  return {
    tables: [...serverSource.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*table\s*\(\s*\{([\s\S]*?)\}\s*\)/g)].map(
      (match) => ({
        name: match[1],
        fields: extractFields(match[2]),
      }),
    ),
  };
}

function extractFields(tableSource) {
  return [...tableSource.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(String|Boolean)\(\)(?:\.default\(([^)]*)\))?/g)].map(
    (match) => {
      const kind = match[2];
      return {
        name: match[1],
        kind,
        sqliteType: kind === "Boolean" ? "INTEGER" : "TEXT",
        defaultValue: parseFieldDefault(kind, match[3]),
      };
    },
  );
}

function parseFieldDefault(kind, rawDefault) {
  if (rawDefault === undefined) {
    return undefined;
  }
  if (kind === "Boolean") {
    return rawDefault.trim() === "true";
  }
  return rawDefault.trim().replace(/^["']|["']$/g, "");
}

function toSqlLiteral(value) {
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function extractSchemaTableNames(serverSource) {
  return extractSchema(serverSource).tables.map((table) => table.name);
}

function listDatabaseTables(database) {
  return database.sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function dumpDatabase(database) {
  return listDatabaseTables(database).map((tableName) => ({
    name: tableName,
    columns: database.sqlite
      .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
      .all()
      .map((column) => column.name),
    rows: database.sqlite.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all(),
  }));
}

function runReadOnlyQuery(database, sql) {
  try {
    const statement = database.sqlite.prepare(sql);
    const columns = statement.columns().map((column) => column.name);
    const rows = statement.all();
    return {
      ok: true,
      data: {
        columns,
        rows,
      },
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: {
        message: error.message,
        hint: "Check the SQL syntax and table names, then retry the query.",
      },
    };
  }
}

function createWebSocketHub(getDatabase) {
  const clients = new Set();

  return {
    accept(request, socket) {
      const key = request.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }

      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
          "",
          "",
        ].join("\r\n"),
      );

      const sessionToken = new URL(request.url, "http://127.0.0.1").searchParams.get("sessionToken");
      const database = getDatabase();
      const session = resolveAnonymousSession(database, sessionToken);
      const client = { socket, buffer: Buffer.alloc(0), subscriptions: new Map(), session };
      clients.add(client);
      socket.on("data", (chunk) => {
        client.buffer = Buffer.concat([client.buffer, chunk]);
        drainWebSocketFrames(client, (message) => handleClientMessage(client, message));
      });
      socket.on("close", () => clients.delete(client));
      socket.on("error", () => clients.delete(client));
    },
    disconnectAll() {
      for (const client of clients) {
        client.socket.end();
      }
      clients.clear();
    },
  };

  function handleClientMessage(client, rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      sendJson(client, {
        id: null,
        type: "error",
        error: {
          message: "Invalid WebSocket message.",
          hint: "Send a JSON object with a supported Sporades message type.",
        },
      });
      return;
    }

    const database = getDatabase();
    if (message.type === "auth.get") {
      sendAuthResult(client, message.id ?? null);
      return;
    }

    if (message.type === "auth.signInWithGoogle") {
      const google = database.authConfig.google;
      if (!google.configured) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          error: {
            message: "Google OAuth is not configured.",
            hint: "Run `sporades auth set google --client-id <id> --client-secret <secret>`.",
          },
        });
        return;
      }
      const clientId = database.serverEnv[google.clientIdEnv];
      sendJson(client, {
        id: message.id ?? null,
        type: "auth.redirect",
        data: {
          url:
            "https://accounts.google.com/o/oauth2/v2/auth?" +
            new URLSearchParams({
              client_id: clientId,
              response_type: "code",
              scope: "openid email profile",
              state: client.session.token,
            }).toString(),
        },
        error: null,
      });
      return;
    }

    if (message.type === "auth.completeGoogleSignIn") {
      const result = linkGoogleAccount(database, client.session, message.profile ?? {});
      if (!result.ok) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          error: result.error,
        });
        return;
      }
      client.session.auth = result.auth;
      sendAuthResult(client, message.id ?? null);
      return;
    }

    if (message.type === "query.subscribe") {
      const queryName = message.query ?? message.name;
      client.subscriptions.set(message.id, { id: message.id, name: queryName, style: message.query ? "direct" : "rows" });
      sendQueryResult(client, client.subscriptions.get(message.id));
      return;
    }

    if (message.type === "mutation.run") {
      const mutationName = message.mutation ?? message.name;
      const result = runMutation(database, client.session.auth, mutationName, message.args ?? []);
      sendJson(client, formatMutationResult(message, mutationName, result));
      if (result.ok) {
        for (const subscribedClient of clients) {
          if (subscribedClient.session.auth.userId !== client.session.auth.userId) {
            continue;
          }
          for (const subscription of subscribedClient.subscriptions.values()) {
            sendQueryResult(subscribedClient, subscription);
          }
        }
      }
      return;
    }

    sendJson(client, {
      id: message.id ?? null,
      type: "error",
      error: {
        message: `Unsupported WebSocket message: ${message.type ?? ""}`.trim(),
        hint: "Use auth.get, auth.signInWithGoogle, query.subscribe, or mutation.run.",
      },
    });
  }

  function sendQueryResult(client, subscription) {
    const database = getDatabase();
    const result = runQuery(database, client.session.auth, subscription.name);
    const data =
      result.data !== undefined
        ? result.data
        : subscription.style === "direct"
          ? result.rows
          : { rows: result.rows };
    sendJson(client, {
      id: subscription.id,
      type: "query.result",
      query: subscription.name,
      data,
      error: result.error,
    });
  }

  function sendAuthResult(client, id) {
    const database = getDatabase();
    sendJson(client, {
      id,
      type: "auth.result",
      data: {
        sessionToken: client.session.token,
        auth: client.session.auth,
        providers: {
          google: {
            configured: database.authConfig.google.configured,
          },
        },
      },
      error: null,
    });
  }
}

function linkGoogleAccount(database, session, profile) {
  if (!database.authConfig.google.configured) {
    return {
      ok: false,
      error: {
        message: "Google OAuth is not configured.",
        hint: "Run `sporades auth set google --client-id <id> --client-secret <secret>`.",
      },
    };
  }
  if (!profile.email) {
    return {
      ok: false,
      error: {
        message: "Google profile is missing an email address.",
        hint: "Retry Google sign-in with an email-bearing account.",
      },
    };
  }

  const auth = {
    userId: session.auth.userId,
    displayName: profile.displayName ?? profile.email,
    email: profile.email,
    picture: profile.picture ?? null,
    isAuthenticated: true,
    isGuest: false,
    provider: "google",
  };
  database.sqlite
    .prepare(
      "UPDATE sporades_auth_users SET displayName = ?, email = ?, picture = ?, isAuthenticated = ?, isGuest = ?, provider = ? WHERE id = ?",
    )
    .run(auth.displayName, auth.email, auth.picture, 1, 0, "google", auth.userId);
  return { ok: true, auth };
}

function createAnonymousAuthTables(sqlite) {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_auth_users (" +
      "id TEXT PRIMARY KEY, " +
      "createdAt TEXT NOT NULL, " +
      "displayName TEXT NOT NULL, " +
      "email TEXT, " +
      "picture TEXT, " +
      "isAuthenticated INTEGER NOT NULL, " +
      "isGuest INTEGER NOT NULL, " +
      "provider TEXT NOT NULL" +
      ")",
  );
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_auth_sessions (" +
      "token TEXT PRIMARY KEY, " +
      "userId TEXT NOT NULL, " +
      "createdAt TEXT NOT NULL" +
      ")",
  );
}

function resolveAnonymousSession(database, sessionToken) {
  if (sessionToken) {
    const existing = database.sqlite
      .prepare(
        "SELECT s.token, u.id AS userId, u.displayName, u.email, u.picture, u.isAuthenticated, u.isGuest, u.provider " +
          "FROM sporades_auth_sessions s " +
          "JOIN sporades_auth_users u ON u.id = s.userId " +
          "WHERE s.token = ?",
      )
      .get(sessionToken);
    if (existing) {
      return sessionFromRow(existing);
    }
  }

  const now = new Date().toISOString();
  const userId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  database.sqlite
    .prepare(
      "INSERT INTO sporades_auth_users " +
        "(id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(userId, now, "Anonymous", null, null, 0, 1, "anonymous");
  database.sqlite
    .prepare("INSERT INTO sporades_auth_sessions (token, userId, createdAt) VALUES (?, ?, ?)")
    .run(token, userId, now);
  return {
    token,
    auth: {
      userId,
      displayName: "Anonymous",
      email: null,
      picture: null,
      isAuthenticated: false,
      isGuest: true,
      provider: "anonymous",
    },
  };
}

function sessionFromRow(row) {
  return {
    token: row.token,
    auth: {
      userId: row.userId,
      displayName: row.displayName,
      email: row.email,
      picture: row.picture,
      isAuthenticated: Boolean(row.isAuthenticated),
      isGuest: Boolean(row.isGuest),
      provider: row.provider,
    },
  };
}

function createWebSocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function drainWebSocketFrames(client, onMessage) {
  while (client.buffer.length >= 2) {
    const firstByte = client.buffer[0];
    const secondByte = client.buffer[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let length = secondByte & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      length = Number(client.buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + length) return;

    const mask = masked ? client.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = client.buffer.subarray(offset, offset + length);
    client.buffer = client.buffer.subarray(offset + length);

    if (opcode === 8) {
      client.socket.end();
      return;
    }
    if (opcode !== 1) {
      continue;
    }

    const decoded = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      decoded[index] = mask ? payload[index] ^ mask[index % 4] : payload[index];
    }
    onMessage(decoded.toString("utf8"));
  }
}

function sendJson(client, message) {
  const payload = Buffer.from(JSON.stringify(message));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  client.socket.write(Buffer.concat([header, payload]));
}

function runQuery(database, auth, queryName) {
  if (queryName === "ctx.env") {
    return { data: database.serverEnv, error: null };
  }

  if (queryName !== "todos") {
    return {
      rows: null,
      error: {
        message: `Unknown query: ${queryName}`,
        hint: "Use a query defined by the capsule.",
      },
    };
  }

  const cacheKey = `todos:${auth.userId}`;
  if (!database.rowCache.has(cacheKey)) {
    const rows = database.sqlite
      .prepare("SELECT id, createdAt, updatedAt, text, done, ownerId FROM todos WHERE ownerId = ? ORDER BY createdAt DESC")
      .all(auth.userId)
      .map((row) => ({ ...row, done: Boolean(row.done) }));
    database.rowCache.set(cacheKey, rows);
  }

  return { rows: database.rowCache.get(cacheKey), error: null };
}

function runMutation(database, auth, mutationName, args) {
  if (mutationName !== "addTodo") {
    return {
      ok: false,
      error: {
        message: `Unknown mutation: ${mutationName}`,
        hint: "Use a mutation defined by the capsule.",
      },
    };
  }

  const now = new Date().toISOString();
  database.sqlite
    .prepare("INSERT INTO todos (id, createdAt, updatedAt, text, done, ownerId) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), now, now, String(args[0] ?? ""), 0, auth.userId);
  database.rowCache.clear();
  return { ok: true, error: null };
}

function formatMutationResult(message, mutationName, result) {
  const formatted = {
    id: message.id,
    type: "mutation.result",
    data: null,
    error: result.error,
  };
  if (message.mutation) {
    formatted.mutation = mutationName;
  } else if (message.name) {
    formatted.ok = result.ok;
  }
  return formatted;
}

function isReadOnlySql(sql) {
  return /^\s*(select|with|pragma)\b/i.test(sql);
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
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

function readFrameworkBundleConfig(framework) {
  const frameworkBundleConfig = FRAMEWORK_BUNDLE_CONFIG[framework];
  if (!frameworkBundleConfig) {
    throw commandError(`Unsupported framework: ${framework}`, "Use one of: react, preact.");
  }
  return frameworkBundleConfig;
}

async function bundleClientSource(clientSource, options) {
  const { build } = await import("esbuild");

  try {
    const result = await build({
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      logLevel: "silent",
      sourcemap: "inline",
      jsx: "automatic",
      jsxImportSource: options.frameworkBundleConfig.jsxImportSource,
      stdin: {
        contents: clientSource,
        sourcefile: options.clientSourcePath,
        resolveDir: path.dirname(options.clientSourcePath),
        loader: "tsx",
      },
      plugins: [sporadesClientPlugin()],
    });

    return [
      "// Sporades client bundle",
      `// JSX import source: ${options.frameworkBundleConfig.jsxImportSource}`,
      `// JSX runtime import: ${options.frameworkBundleConfig.jsxRuntimeImport}`,
      'console.log("Sporades client bundle loaded");',
      "",
      result.outputFiles[0].text,
    ].join("\n");
  } catch (error) {
    const message = error.errors?.[0]?.text ?? error.message;
    throw commandError(`Client bundle failed: ${message}`, "Fix client/index.tsx and save again.");
  }
}

function sporadesClientPlugin() {
  return {
    name: "sporades-client",
    setup(build) {
      build.onResolve({ filter: /^sporades\/client$/ }, () => ({
        path: "sporades/client",
        namespace: "sporades-runtime",
      }));
      build.onLoad({ filter: /^sporades\/client$/, namespace: "sporades-runtime" }, () => ({
        loader: "js",
        contents: sporadesClientRuntimeSource(),
      }));
    },
  };
}

function sporadesClientRuntimeSource() {
  return `
const websocketPath = "/__sporades/ws";

export function createHooks(primitives) {
  const { useEffect, useState } = primitives;

  function useQuery(name) {
    const [state, setState] = useState({ data: null, error: null, loading: true });

    useEffect(() => {
      const subscription = connect().subscribe(name, (message) => {
        setState({
          data: message.data ?? null,
          error: message.error ?? null,
          loading: false,
        });
      });
      return () => subscription.unsubscribe();
    }, [name]);

    return state;
  }

  function useMutation(name) {
    const [state, setState] = useState({ error: null, loading: false });

    return {
      ...state,
      async run(...args) {
        setState({ error: null, loading: true });
        const result = await connect().mutate(name, args);
        setState({ error: result.error ?? null, loading: false });
        return result;
      },
    };
  }

  function useAuth() {
    const [state, setState] = useState({ auth: null, providers: {}, loading: true, error: null });

    useEffect(() => {
      let active = true;
      connect()
        .auth()
        .then((result) => {
          if (!active) return;
          setState({
            auth: result.data?.auth ?? null,
            providers: result.data?.providers ?? {},
            loading: false,
            error: result.error ?? null,
          });
        });
      return () => {
        active = false;
      };
    }, []);

    return state;
  }

  return { useQuery, useMutation, useAuth };
}

let connection;

function connect() {
  if (!connection) {
    connection = createConnection();
  }
  return connection;
}

function createConnection() {
  let socket = null;
  let nextId = 1;
  let sessionToken = localStorage.getItem("sporades.sessionToken");
  const pending = new Map();
  const subscriptions = new Map();

  function open() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return socket;
    }

    const url = new URL(websocketPath, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (sessionToken) {
      url.searchParams.set("sessionToken", sessionToken);
    }
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      request("auth.get").then(storeAuthSession);
      for (const subscription of subscriptions.values()) {
        send({
          id: subscription.id,
          type: "query.subscribe",
          query: subscription.name,
        });
      }
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "auth.result") {
        storeAuthSession(message);
      }
      if (message.type === "query.result" && subscriptions.has(message.id)) {
        subscriptions.get(message.id).listener(message);
        return;
      }
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    socket.addEventListener("close", () => {
      setTimeout(open, 500);
    });
    return socket;
  }

  function send(message) {
    const activeSocket = open();
    if (activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(JSON.stringify(message));
      return;
    }
    activeSocket.addEventListener(
      "open",
      () => {
        activeSocket.send(JSON.stringify(message));
      },
      { once: true },
    );
  }

  function request(type, fields = {}) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ id, type, ...fields });
    });
  }

  function storeAuthSession(message) {
    const token = message.data?.sessionToken;
    if (token) {
      sessionToken = token;
      localStorage.setItem("sporades.sessionToken", token);
    }
    return message;
  }

  open();

  return {
    auth() {
      return request("auth.get").then(storeAuthSession);
    },
    subscribe(name, listener) {
      const id = nextId++;
      const subscription = { id, name, listener };
      subscriptions.set(id, subscription);
      send({ id, type: "query.subscribe", query: name });
      return {
        unsubscribe() {
          subscriptions.delete(id);
        },
      };
    },
    mutate(name, args) {
      return request("mutation.run", { mutation: name, args });
    },
  };
}
`;
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
