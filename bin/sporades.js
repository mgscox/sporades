#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authStatus, createBundle, parseServerEnv, readServerEnvFile } from "../src/bundle-pipeline.js";
import {
  createWebSocketHub,
  dumpDatabase,
  handleFileHttpRoute,
  listDatabaseTables,
  openDevDatabase,
  readJsonRequest,
  routeEndpoint,
  routeSporadesAuth,
  runReadOnlyQuery,
  simulateLocalIdentitySession,
} from "../src/server-runtime-source.js";

const SUPPORTED_FRAMEWORKS = new Set(["react", "preact"]);
const SUPPORTED_TEMPLATES = new Set(["blank", "todo", "guestbook"]);
const DEV_SESSION_FILE = path.join(".sporades", "dev-session.json");
const CONTAINER_BINDING_FILE = path.join(".sporades", "binding.json");
const REMOTE_BINDING_FILE = path.join(".sporades", "remote-binding.json");
const DEV_REBUILD_DEBOUNCE_MS = 100;
const DEFAULT_HOST_SCHEME = "https";
const DEFAULT_HOST_REMOTE_ROOT = "/srv/sporades";
const RESERVED_CAPSULE_SUBNAMES = new Set(["www", "api", "admin", "root", "host"]);
const DEFAULT_HOST_LOG_LINES = 100;
const MAX_HOST_LOG_LINES = 10000;
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
      data: { path: options.projectDir, template: options.template },
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

  if (command === "host") {
    await manageHost(parseHostArgs(args));
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
  let template = "blank";
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
    throw commandError(`Unsupported template: ${template}`, "Use one of: blank, todo, guestbook.");
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
  const simulatedProvider = subcommand === "as" ? args[1] : null;
  const rest = subcommand === "set" ? args.slice(2) : subcommand === "as" ? args.slice(2) : args.slice(1);
  let json = false;
  let clientId = null;
  let clientSecret = null;
  let clientJson = null;
  let email = null;
  let displayName = null;
  let picture = null;
  let port = null;
  let client = null;

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
    if (arg === "--client-json") {
      clientJson = readFlagValue(rest, ++index, "--client-json");
      continue;
    }
    if (arg === "--email") {
      email = readFlagValue(rest, ++index, "--email");
      continue;
    }
    if (arg === "--display-name") {
      displayName = readFlagValue(rest, ++index, "--display-name");
      continue;
    }
    if (arg === "--picture") {
      picture = readFlagValue(rest, ++index, "--picture");
      continue;
    }
    if (arg === "--port") {
      port = readPort(readFlagValue(rest, ++index, "--port"));
      continue;
    }
    if (arg === "--client") {
      client = readFlagValue(rest, ++index, "--client");
      if (!isValidAuthClientTarget(client)) {
        throw commandError("Invalid auth client target.", "Use `--client current`, `--client all`, or a client id from `sporades auth clients`.");
      }
      continue;
    }
    throw commandError(`Unknown flag: ${arg}`, "Use `sporades auth status`, `sporades auth set google`, or `sporades auth as email`.");
  }

  if (subcommand === "status") {
    return { subcommand, json, projectDir: process.cwd() };
  }
  if (subcommand === "clients") {
    return { subcommand, json, port, projectDir: process.cwd() };
  }
  if (subcommand === "as") {
    if (!simulatedProvider) {
      throw commandError("Missing simulated auth provider.", "Use `sporades auth as email --email <address> --json`.");
    }
    return { subcommand, provider: simulatedProvider, email, displayName, picture, port, client, json, projectDir: process.cwd() };
  }
  if (subcommand === "set" && provider === "google") {
    if (clientJson) {
      const credentials = readProviderClientCredentials(provider, clientJson, process.cwd());
      clientId ??= credentials.clientId;
      clientSecret ??= credentials.clientSecret;
    }
    if (!clientId || !clientSecret) {
      throw commandError(
        "Missing Google OAuth credentials.",
        "Run `sporades auth set google --client-id <id> --client-secret <secret>` or `sporades auth set google --client-json <path>`.",
      );
    }
    return { subcommand, provider, clientId, clientSecret, json, projectDir: process.cwd() };
  }

  throw commandError(
    "Unknown auth command.",
    "Use `sporades auth status`, `sporades auth clients`, `sporades auth set google`, or `sporades auth as email`.",
  );
}

function parseHostArgs(args) {
  const [subcommand, ...rest] = args;
  let json = false;
  let hostAlias = null;
  let server = null;
  let domain = null;
  let remoteRoot = DEFAULT_HOST_REMOTE_ROOT;
  let subname = null;
  let lines = DEFAULT_HOST_LOG_LINES;
  let restart = false;
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--host") {
      hostAlias = readFlagValue(rest, ++index, "--host");
      continue;
    }
    if (arg === "--server") {
      server = readFlagValue(rest, ++index, "--server");
      continue;
    }
    if (arg === "--domain") {
      domain = readFlagValue(rest, ++index, "--domain");
      continue;
    }
    if (arg === "--remote-root") {
      remoteRoot = readFlagValue(rest, ++index, "--remote-root");
      continue;
    }
    if (arg === "--subname") {
      subname = readFlagValue(rest, ++index, "--subname");
      continue;
    }
    if (arg === "--lines") {
      lines = readHostLogLineCount(readFlagValue(rest, ++index, "--lines"));
      continue;
    }
    if (arg === "--restart") {
      restart = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw commandError(
        `Unknown flag: ${arg}`,
        "Use `sporades host add`, `sporades host use`, `sporades host current`, `sporades host bind`, `sporades host register`, `sporades host push`, `sporades host bootstrap`, `sporades host list`, `sporades host logs`, or `sporades host invoke`.",
      );
    }
    positional.push(arg);
  }

  if (subcommand === "add") {
    const [alias, ...extra] = positional;
    if (!alias) {
      throw commandError(
        "Missing Host profile alias.",
        "Use `sporades host add <alias> --server <ssh-target> --domain <hosted-domain>`.",
      );
    }
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host add <alias> --server <ssh-target> --domain <hosted-domain>`.");
    }
    validateHostAlias(alias);
    if (!server) {
      throw commandError("Missing Host server.", "Pass `--server <ssh-target>`.");
    }
    if (!domain) {
      throw commandError("Missing Hosted domain.", "Pass `--domain <hosted-domain>`.");
    }
    validateHostedDomain(domain);
    validateHostRemoteRoot(remoteRoot);
    return { subcommand, alias, server, domain, remoteRoot, json, projectDir: process.cwd() };
  }

  if (subcommand === "use") {
    const [alias, ...extra] = positional;
    if (!alias) {
      throw commandError("Missing Host profile alias.", "Use `sporades host use <alias>`.");
    }
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host use <alias>`.");
    }
    validateHostAlias(alias);
    return { subcommand, alias, json, projectDir: process.cwd() };
  }

  if (subcommand === "current") {
    if (positional.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host current --host <alias> --json`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    return { subcommand, hostAlias, json, projectDir: process.cwd() };
  }

  if (subcommand === "bind") {
    const [positionalSubname, ...extra] = positional;
    if (!positionalSubname) {
      throw commandError("Missing Capsule subname.", "Use `sporades host bind <subname> --host <alias>`.");
    }
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host bind <subname> --host <alias>`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    validateCapsuleSubname(positionalSubname);
    return { subcommand, subname: positionalSubname, hostAlias, json, projectDir: process.cwd() };
  }

  if (subcommand === "register") {
    const [positionalSubname, ...extra] = positional;
    if (!positionalSubname) {
      throw commandError("Missing Capsule subname.", "Use `sporades host register <subname> --host <alias>`.");
    }
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host register <subname> --host <alias>`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    validateCapsuleSubname(positionalSubname);
    return { subcommand, subname: positionalSubname, hostAlias, json, projectDir: process.cwd() };
  }

  if (subcommand === "bootstrap") {
    if (positional.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host bootstrap --host <alias> --json`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    return { subcommand, hostAlias, json, projectDir: process.cwd() };
  }

  if (subcommand === "list") {
    if (positional.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host list --host <alias> --json`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    return { subcommand, hostAlias, json, projectDir: process.cwd() };
  }

  if (subcommand === "push") {
    if (positional.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host push --host <alias> --subname <capsule-subname> --json`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    if (subname) {
      validateCapsuleSubname(subname);
    }
    return { subcommand, hostAlias, subname, restart, json, projectDir: process.cwd() };
  }

  if (subcommand === "logs") {
    if (positional.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host logs --host <alias> --lines <n> --json`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    return { subcommand, hostAlias, lines, json, projectDir: process.cwd() };
  }

  if (subcommand === "invoke") {
    const [action, ...extra] = positional;
    if (!action) {
      throw commandError("Missing remote Host helper action.", "Use `sporades host invoke <action> --host <alias> --json`.");
    }
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host invoke <action> --host <alias> --json`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    validateRemoteHelperAction(action);
    if (subname) {
      validateCapsuleSubname(subname);
    }
    return { subcommand, action, subname, hostAlias, json, projectDir: process.cwd() };
  }

  throw commandError(
    `Unknown host command: ${subcommand ?? ""}`.trim(),
    "Use `sporades host add`, `sporades host use`, `sporades host current`, `sporades host bind`, `sporades host register`, `sporades host push`, `sporades host bootstrap`, `sporades host list`, `sporades host logs`, or `sporades host invoke`.",
  );
}

function readProviderClientCredentials(provider, clientJsonPath, projectDir) {
  if (provider !== "google") {
    throw commandError(
      `Unsupported auth provider credentials file: ${provider}`,
      "Use explicit --client-id and --client-secret values for this provider.",
    );
  }
  const resolvedPath = path.resolve(projectDir, clientJsonPath);
  let raw;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch {
    throw commandError(
      `Unable to read OAuth client JSON: ${clientJsonPath}`,
      "Check the file path and retry `sporades auth set google --client-json <path>`.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw commandError(
      `Invalid OAuth client JSON: ${clientJsonPath}`,
      "Download a valid OAuth client credentials JSON file from the provider and retry.",
    );
  }

  const client = parsed.web;
  if (!client?.client_id || !client?.client_secret) {
    throw commandError(
      "OAuth client JSON is missing Google client credentials.",
      "Use a Google OAuth Web application JSON file containing `web.client_id` and `web.client_secret`.",
    );
  }

  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
  };
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

function readHostLogLineCount(value) {
  if (!/^\d+$/.test(value)) {
    throw commandError(
      "Invalid Host log line count.",
      `Pass \`--lines <n>\` with a whole number between 1 and ${MAX_HOST_LOG_LINES}.`,
    );
  }
  const lines = Number.parseInt(value, 10);
  if (lines < 1 || lines > MAX_HOST_LOG_LINES) {
    throw commandError(
      "Invalid Host log line count.",
      `Pass \`--lines <n>\` with a whole number between 1 and ${MAX_HOST_LOG_LINES}.`,
    );
  }
  return lines;
}

function readFlagValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw commandError(`Missing value for ${flag}.`, `Pass ${flag} <value>.`);
  }
  return value;
}

function isValidAuthClientTarget(value) {
  return value === "current" || value === "all" || /^client-[a-z0-9]+$/.test(value);
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

      if (request.method === "POST" && requestUrl.pathname === "/__sporades/debug/auth/as") {
        const body = await readJsonRequest(request);
        const result = simulateLocalIdentitySession(runtime.database, body);
        if (result.ok && body.client) {
          result.data.delivery = websocketHub.deliverAuthSession(body.client, result.data);
        }
        writeJsonResponse(response, result.ok ? 200 : 400, result);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/__sporades/debug/auth/clients") {
        writeJsonResponse(response, 200, {
          ok: true,
          data: { clients: websocketHub.listAuthClients() },
          error: null,
        });
        return;
      }

      if (await routeSporadesAuth(runtime.database, request, response)) {
        return;
      }

      if (await handleFileHttpRoute(runtime.database, request, response, websocketHub)) {
        return;
      }

      if (await routeEndpoint(runtime.database, request, response)) {
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
  const watchers = watchDevInputs(options.projectDir, async (change) => {
    try {
      const rebuild = await createBundle(options.projectDir, config);
      if (change.affectsServerRuntime) {
        await runtime.restart(rebuild.serverRuntime.source, rebuild.serverRuntime.env, config);
        websocketHub.disconnectAll();
      }
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
  emitDevEvent(options, { event: "started", url, port: actualPort });

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
    { path: path.join(projectDir, "server"), affectsServerRuntime: true },
    { path: path.join(projectDir, "client"), affectsServerRuntime: false },
    { path: path.join(projectDir, "shared"), affectsServerRuntime: true },
    { path: path.join(projectDir, "index.html"), affectsServerRuntime: false },
    { path: path.join(projectDir, "sporades.json"), affectsServerRuntime: true },
  ];
  const watchers = [];
  let debounceTimer = null;
  let pendingChange = null;

  const schedule = (change) => {
    pendingChange = {
      affectsServerRuntime: Boolean(pendingChange?.affectsServerRuntime || change.affectsServerRuntime),
    };
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const currentChange = pendingChange ?? { affectsServerRuntime: true };
      pendingChange = null;
      onChange(currentChange);
    }, DEV_REBUILD_DEBOUNCE_MS);
  };

  for (const watchedPath of watchedPaths) {
    try {
      watchers.push(watch(watchedPath.path, { recursive: true }, () => schedule(watchedPath)));
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

  if (options.subcommand === "as") {
    const session = options.port ? { url: `http://localhost:${options.port}` } : await readDevSession(options.projectDir);
    const result = await fetchLocalIdentitySimulation(session, {
      provider: options.provider,
      email: options.email,
      displayName: options.displayName,
      picture: options.picture,
      client: options.client,
    });

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }

    process.stdout.write(`Simulated ${result.data.auth.provider} identity: ${result.data.auth.email}\n`);
    if (result.data.delivery) {
      const noun = result.data.delivery.clients === 1 ? "client" : "clients";
      process.stdout.write(
        `Delivered to ${result.data.delivery.clients} ${noun} for --client ${result.data.delivery.target}\n`,
      );
    }
    process.stdout.write(`localStorage.${result.data.localStorage.key}=${result.data.localStorage.value}\n`);
    return;
  }

  if (options.subcommand === "clients") {
    const session = options.port ? { url: `http://localhost:${options.port}` } : await readDevSession(options.projectDir);
    const result = await fetchAuthClients(session);

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }

    for (const client of result.data.clients) {
      process.stdout.write(`${client.id}\t${client.auth.provider}\t${client.auth.email ?? ""}\n`);
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
    process.stdout.write("Restart any running Sporades dev session so the server reloads auth configuration.\n");
  }
}

async function manageHost(options) {
  if (options.subcommand === "add") {
    const config = await readHostConfig();
    const profile = {
      server: options.server,
      domain: options.domain,
      scheme: DEFAULT_HOST_SCHEME,
      remoteRoot: options.remoteRoot,
    };
    config.profiles[options.alias] = profile;
    await writeHostConfig(config);

    if (options.json) {
      writeResult({ ok: true, data: { alias: options.alias, profile }, error: null });
    } else {
      process.stdout.write(`Host profile added: ${options.alias}\n`);
    }
    return;
  }

  if (options.subcommand === "use") {
    const config = await readHostConfig();
    const profile = requireHostProfile(config, options.alias);
    config.currentHostAlias = options.alias;
    await writeHostConfig(config);

    if (options.json) {
      writeResult({ ok: true, data: { currentHostAlias: options.alias, profile }, error: null });
    } else {
      process.stdout.write(`Current Host profile: ${options.alias}\n`);
    }
    return;
  }

  if (options.subcommand === "current") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const binding = await readRemoteBinding(options.projectDir);

    if (options.json) {
      writeResult({ ok: true, data: { alias: resolved.alias, profile: resolved.profile, binding }, error: null });
    } else {
      process.stdout.write(`${resolved.alias}\t${resolved.profile.server}\t${resolved.profile.domain}\n`);
    }
    return;
  }

  if (options.subcommand === "bind") {
    await readProjectConfig(options.projectDir);
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const binding = createRemoteBinding(resolved.alias, resolved.profile, options.subname);
    const bindingPath = path.join(options.projectDir, REMOTE_BINDING_FILE);
    await mkdir(path.dirname(bindingPath), { recursive: true });
    await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);

    if (options.json) {
      writeResult({ ok: true, data: { bindingPath, binding, localOnly: true, authoritative: false }, error: null });
    } else {
      process.stdout.write(`Local remote binding written for ${binding.subname}: ${binding.hostedUrl}\n`);
      process.stdout.write("This does not register or create a Hosted Capsule on the Host server.\n");
    }
    return;
  }

  if (options.subcommand === "register") {
    await readProjectConfig(options.projectDir);
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const binding = createRemoteBinding(resolved.alias, resolved.profile, options.subname);
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: "capsule.register",
      subname: options.subname,
      registration: createHostRegistrationRequest(resolved.alias, resolved.profile, options.subname),
      projectDir: options.projectDir,
    });

    if (!result.ok) {
      if (options.json) {
        writeResult(result, true);
        return;
      }
      throw commandError(result.error.message, result.error.hint);
    }

    const bindingPath = path.join(options.projectDir, REMOTE_BINDING_FILE);
    await mkdir(path.dirname(bindingPath), { recursive: true });
    await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);

    const data = {
      ...result.data,
      bindingPath,
      binding,
      localBinding: true,
      authoritative: result.data?.authoritative ?? true,
    };
    if (options.json) {
      writeResult({ ok: true, data, error: null });
    } else {
      process.stdout.write(`Hosted Capsule registered: ${binding.hostedUrl}\n`);
      process.stdout.write(`Local remote binding written for ${binding.subname}.\n`);
    }
    return;
  }

  if (options.subcommand === "push") {
    const config = await readHostConfig();
    const target = await resolveHostPushTarget(config, options);
    const projectConfig = await readProjectConfig(options.projectDir);
    const bundle = await createBundle(options.projectDir, projectConfig);
    const release = await createHostReleaseArchive({
      projectDir: options.projectDir,
      alias: target.alias,
      profile: target.profile,
      subname: target.subname,
      binding: target.binding,
      bundle,
      restart: options.restart,
    });
    uploadHostReleaseArchive({
      profile: target.profile,
      projectDir: options.projectDir,
      archivePath: release.localArchive,
      remoteArchive: release.remoteArchive,
    });
    const result = invokeRemoteHostHelper({
      alias: target.alias,
      profile: target.profile,
      action: "capsule.release.install",
      subname: target.subname,
      release: release.request,
      projectDir: options.projectDir,
    });

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }
    process.stdout.write(`Hosted Capsule release pushed: ${target.binding.hostedUrl}\n`);
    if (!options.restart) {
      process.stdout.write("The Hosted Capsule was not restarted.\n");
    }
    return;
  }

  if (options.subcommand === "invoke") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: options.action,
      subname: options.subname,
      projectDir: options.projectDir,
    });

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
    return;
  }

  if (options.subcommand === "bootstrap") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: "host.bootstrap",
      bootstrap: createHostBootstrapRequest(resolved.profile),
      projectDir: options.projectDir,
    });

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }
    process.stdout.write(`Host server bootstrapped for ${resolved.profile.domain}\n`);
  }

  if (options.subcommand === "list") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: "capsule.list",
      projectDir: options.projectDir,
    });

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }

    process.stdout.write(formatHostedCapsuleList(result.data, resolved.profile));
    return;
  }

  if (options.subcommand === "logs") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: "host.logs",
      logs: {
        source: "caddy-combined",
        lines: options.lines,
      },
      projectDir: options.projectDir,
    });

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }

    for (const entry of normaliseHostLogEntries(result.data)) {
      process.stdout.write(`${entry}\n`);
    }
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

async function fetchLocalIdentitySimulation(session, body) {
  let response;
  try {
    response = await fetch(new URL("/__sporades/debug/auth/as", session.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw commandError(
      "Unable to reach the running Sporades dev session.",
      "Check that `sporades dev` is still running in this project, then retry the command.",
    );
  }

  try {
    const result = await response.json();
    if (result && typeof result.ok === "boolean") {
      return result;
    }
  } catch {
    // Fall through to the unsupported-session error below.
  }

  return {
    ok: false,
    data: null,
    error: {
      message: "Dev session does not support local identity simulation.",
      hint: "Start a current `sporades dev` session for this project, then retry `sporades auth as email`.",
    },
  };
}

async function fetchAuthClients(session) {
  let response;
  try {
    response = await fetch(new URL("/__sporades/debug/auth/clients", session.url));
  } catch {
    throw commandError(
      "Unable to reach the running Sporades dev session.",
      "Check that `sporades dev` is still running in this project, then retry the command.",
    );
  }

  try {
    const result = await response.json();
    if (result && typeof result.ok === "boolean") {
      return result;
    }
  } catch {
    // Fall through to the unsupported-session error below.
  }

  return {
    ok: false,
    data: null,
    error: {
      message: "Dev session does not support auth client listing.",
      hint: "Start a current `sporades dev` session for this project, then retry `sporades auth clients`.",
    },
  };
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

async function readRemoteBinding(projectDir) {
  try {
    return JSON.parse(await readFile(path.join(projectDir, REMOTE_BINDING_FILE), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw commandError(
        "Invalid project remote binding metadata.",
        "Delete .sporades/remote-binding.json or fix its JSON, then retry the command.",
      );
    }
    throw error;
  }
}

async function resolveHostPushTarget(config, options) {
  const localBinding = await readRemoteBinding(options.projectDir);
  const resolved = resolveHostProfile(config, options.hostAlias ?? localBinding?.hostAlias ?? null);
  const subname = options.subname ?? localBinding?.subname;
  if (!subname) {
    throw commandError(
      "No Hosted Capsule binding found.",
      "Run `sporades host register <subname> --host <alias>` or pass `--host <alias> --subname <subname>`.",
    );
  }
  validateCapsuleSubname(subname);
  const binding = createRemoteBinding(resolved.alias, resolved.profile, subname);
  return { alias: resolved.alias, profile: resolved.profile, subname, binding };
}

async function readHostConfig() {
  try {
    const parsed = JSON.parse(await readFile(hostConfigPath(), "utf8"));
    return normaliseHostConfig(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { profiles: {}, currentHostAlias: null };
    }
    if (error instanceof SyntaxError) {
      throw commandError(
        "Invalid Host profile configuration.",
        "Fix or delete the Sporades Host profile config, then retry the command.",
      );
    }
    throw error;
  }
}

async function writeHostConfig(config) {
  const filePath = hostConfigPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normaliseHostConfig(config), null, 2)}\n`);
}

function hostConfigPath() {
  const configDir =
    process.env.SPORADES_CONFIG_DIR ??
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? process.cwd(), ".config"), "sporades");
  return path.join(configDir, "hosts.json");
}

function normaliseHostConfig(value) {
  return {
    profiles: value && typeof value.profiles === "object" && value.profiles !== null ? value.profiles : {},
    currentHostAlias: typeof value?.currentHostAlias === "string" ? value.currentHostAlias : null,
  };
}

function resolveHostProfile(config, explicitAlias) {
  const alias = explicitAlias ?? config.currentHostAlias;
  if (!alias) {
    throw commandError(
      "No current Host profile selected.",
      "Run `sporades host use <alias>` or pass `--host <alias>`.",
    );
  }
  return { alias, profile: requireHostProfile(config, alias) };
}

function requireHostProfile(config, alias) {
  const profile = config.profiles[alias];
  if (!profile) {
    throw commandError(
      `Unknown Host profile alias: ${alias}`,
      `Add it with \`sporades host add ${alias} --server <ssh-target> --domain <hosted-domain>\`.`,
    );
  }
  return profile;
}

function createRemoteBinding(hostAlias, profile, subname) {
  return {
    hostAlias,
    domain: profile.domain,
    scheme: profile.scheme,
    subname,
    hostedUrl: `${profile.scheme}://${subname}.${profile.domain}`,
    remoteCapsuleId: `${profile.domain}/${subname}`,
  };
}

function invokeRemoteHostHelper(options) {
  const helperPath = remoteHostHelperPath(options.profile);
  const request = {
    action: options.action,
    host: {
      alias: options.alias,
      domain: options.profile.domain,
      scheme: options.profile.scheme,
      remoteRoot: options.profile.remoteRoot,
    },
    capsule: options.subname ? { subname: options.subname } : null,
  };
  if (options.bootstrap) {
    request.bootstrap = options.bootstrap;
  }
  if (options.registration) {
    request.registration = options.registration;
  }
  if (options.logs) {
    request.logs = options.logs;
  }
  if (options.release) {
    request.release = options.release;
  }
  const result = spawnSync("ssh", [options.profile.server, helperPath], {
    cwd: options.projectDir,
    encoding: "utf8",
    input: `${JSON.stringify(request)}\n`,
  });

  return parseRemoteHostHelperResult(result);
}

async function createHostReleaseArchive(options) {
  const releaseId = createHostReleaseId();
  const hostPushDir = path.join(options.projectDir, ".sporades", "host-push");
  await mkdir(hostPushDir, { recursive: true });
  const localArchive = path.join(hostPushDir, `${releaseId}.tar.gz`);
  const remoteArchive = posixJoin(options.profile.remoteRoot, "incoming", `${releaseId}.tar.gz`);
  const releaseRequest = createHostReleaseRequest({
    alias: options.alias,
    profile: options.profile,
    subname: options.subname,
    binding: options.binding,
    releaseId,
    remoteArchive,
    bundle: options.bundle,
    restart: options.restart,
  });
  const tarArgs = [
    "-czf",
    localArchive,
    "-C",
    options.bundle.buildDir,
    "server.mjs",
    "client.js",
    "-C",
    options.projectDir,
    "index.html",
    "sporades.json",
  ];
  if (options.bundle.containerMounts.serverEnv) {
    tarArgs.push("-C", options.projectDir, ".env.sporades.server");
  }
  const result = spawnSync("tar", tarArgs, { cwd: options.projectDir, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw commandError(
      "Failed to package Hosted Capsule release.",
      "Check that tar is available and the Capsule runtime files are readable, then retry `sporades host push`.",
    );
  }
  return {
    id: releaseId,
    localArchive,
    remoteArchive,
    request: releaseRequest,
  };
}

function uploadHostReleaseArchive(options) {
  const result = spawnSync("scp", [options.archivePath, `${options.profile.server}:${options.remoteArchive}`], {
    cwd: options.projectDir,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw commandError(
      "Failed to upload Hosted Capsule release archive.",
      "Check the Host profile SSH target, network connectivity, SSH key access, and remote incoming directory.",
    );
  }
}

function createHostReleaseRequest(options) {
  const registration = createHostRegistrationRequest(options.alias, options.profile, options.subname);
  const releaseDirectory = posixJoin(registration.directories.releases, options.releaseId);
  const files = ["server.mjs", "client.js", "index.html", "sporades.json"];
  if (options.bundle.containerMounts.serverEnv) {
    files.push(".env.sporades.server");
  }
  return {
    id: options.releaseId,
    domain: options.profile.domain,
    subname: options.subname,
    hostedUrl: options.binding.hostedUrl,
    remoteCapsuleId: options.binding.remoteCapsuleId,
    remoteArchive: options.remoteArchive,
    restart: options.restart,
    serverEnvIncluded: Boolean(options.bundle.containerMounts.serverEnv),
    files,
    directories: {
      capsule: registration.directories.capsule,
      releases: registration.directories.releases,
      release: releaseDirectory,
      data: registration.directories.data,
    },
    currentLink: posixJoin(registration.directories.capsule, "current"),
  };
}

function createHostReleaseId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

function normaliseHostLogEntries(data) {
  if (!Array.isArray(data?.entries)) {
    return [];
  }
  return data.entries.map((entry) => String(entry));
}

function formatHostedCapsuleList(data, profile) {
  const capsules = normaliseHostedCapsules(data);
  const domain = data?.host?.domain ?? profile.domain;
  if (capsules.length === 0) {
    return `No Hosted Capsules registered for ${domain}.\n`;
  }

  const rows = capsules.map((capsule) => ({
    subname: capsule.subname,
    hostedUrl: capsule.hostedUrl,
    registry: formatCapsuleRegistryStatus(capsule.registry),
    release: formatCapsuleRelease(capsule.currentRelease),
    docker: formatCapsuleDockerStatus(capsule.docker),
  }));
  const headers = {
    subname: "SUBNAME",
    hostedUrl: "URL",
    registry: "REGISTRY",
    release: "RELEASE",
    docker: "DOCKER",
  };
  const widths = Object.fromEntries(
    Object.keys(headers).map((key) => [key, Math.max(headers[key].length, ...rows.map((row) => row[key].length))]),
  );
  const line = (row) =>
    [row.subname, row.hostedUrl, row.registry, row.release, row.docker]
      .map((value, index) => {
        const key = ["subname", "hostedUrl", "registry", "release", "docker"][index];
        return index === 4 ? value : value.padEnd(widths[key] + 2);
      })
      .join("");

  return `${line(headers)}\n${rows.map(line).join("\n")}\n`;
}

function normaliseHostedCapsules(data) {
  if (!Array.isArray(data?.capsules)) {
    return [];
  }
  return data.capsules.map((capsule) => ({
    subname: String(capsule?.subname ?? ""),
    hostedUrl: String(capsule?.hostedUrl ?? ""),
    registry: capsule?.registry ?? null,
    currentRelease: capsule?.currentRelease ?? null,
    docker: capsule?.docker ?? null,
  }));
}

function formatCapsuleRegistryStatus(registry) {
  return String(registry?.status ?? registry?.state ?? registry?.lifecycleStatus ?? "registered");
}

function formatCapsuleRelease(release) {
  return String(release?.id ?? release?.releaseId ?? release?.version ?? "none");
}

function formatCapsuleDockerStatus(docker) {
  if (!docker) {
    return "unavailable";
  }
  const state = String(docker.state ?? docker.status ?? "unknown").toLowerCase();
  let label = state;
  if (docker.running === true || state === "running") {
    label = "running";
  } else if (docker.running === false || state === "exited" || state === "stopped") {
    label = "stopped";
  }
  const detail = typeof docker.status === "string" && docker.status.trim() ? docker.status.trim() : "";
  return detail ? `${label} (${detail})` : label;
}

function remoteHostHelperPath(profile) {
  return `${profile.remoteRoot}/bin/sporades-host-helper`;
}

function createHostBootstrapRequest(profile) {
  const caddyDirectory = posixJoin(profile.remoteRoot, "caddy");
  const hostsDirectory = posixJoin(profile.remoteRoot, "hosts");
  const domainDirectory = posixJoin(profile.remoteRoot, "hosts", profile.domain);
  const tlsDirectory = posixJoin(domainDirectory, "tls");
  return {
    substrate: {
      packages: ["docker", "caddy"],
      services: ["docker", "caddy"],
    },
    directories: {
      remoteRoot: profile.remoteRoot,
      bin: posixJoin(profile.remoteRoot, "bin"),
      caddy: caddyDirectory,
      caddyHosts: posixJoin(caddyDirectory, "hosts"),
      hosts: hostsDirectory,
      domain: domainDirectory,
      tls: tlsDirectory,
      registry: posixJoin(domainDirectory, "registry"),
      capsules: posixJoin(domainDirectory, "capsules"),
    },
    domainDirectory,
    tls: {
      directory: tlsDirectory,
      certificate: posixJoin(tlsDirectory, "origin.crt"),
      key: posixJoin(tlsDirectory, "origin.key"),
    },
    network: "sporades-hosted-capsules",
    caddy: {
      managedInclude: posixJoin(caddyDirectory, "sporades-hosted-domains.caddy"),
      domainInclude: posixJoin(caddyDirectory, "hosts", `${profile.domain}.caddy`),
    },
  };
}

function createHostRegistrationRequest(alias, profile, subname) {
  const bootstrap = createHostBootstrapRequest(profile);
  const capsuleDirectory = posixJoin(bootstrap.directories.capsules, subname);
  return {
    subname,
    domain: profile.domain,
    hostedUrl: `${profile.scheme}://${subname}.${profile.domain}`,
    remoteCapsuleId: `${profile.domain}/${subname}`,
    registryRecord: posixJoin(bootstrap.directories.registry, "capsules", `${subname}.json`),
    directories: {
      capsule: capsuleDirectory,
      releases: posixJoin(capsuleDirectory, "releases"),
      data: posixJoin(capsuleDirectory, "data"),
    },
    route: {
      hostname: `${subname}.${profile.domain}`,
      target: "hosted-capsule-unavailable",
      statusCode: 503,
      routeFile: posixJoin(bootstrap.directories.caddyHosts, profile.domain, `${subname}.caddy`),
    },
    bootstrap: {
      command: `sporades host bootstrap --host ${alias}`,
      tls: bootstrap.tls,
    },
  };
}

function posixJoin(...segments) {
  return segments
    .map((segment, index) => {
      const value = String(segment);
      if (index === 0) {
        return value.replace(/\/+$/g, "");
      }
      return value.replace(/^\/+|\/+$/g, "");
    })
    .filter(Boolean)
    .join("/");
}

function parseRemoteHostHelperResult(result) {
  const parsed = parseSporadesJsonEnvelope(result.stdout);

  if (result.error || result.status === 255 || result.signal) {
    return {
      ok: false,
      data: null,
      error: {
        message: "SSH transport failed.",
        hint: "Check the Host profile SSH target, network connectivity, and SSH key access.",
      },
    };
  }

  if (parsed) {
    return parsed.ok ? parsed : { ...parsed, ok: false };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      data: null,
      error: {
        message: "Remote Host helper command failed.",
        hint: "Check the Host server helper installation and retry the command.",
      },
    };
  }

  return {
    ok: false,
    data: null,
    error: {
      message: "Remote Host helper returned invalid JSON.",
      hint: "Update or reinstall the Sporades Host helper on the Host server.",
    },
  };
}

function parseSporadesJsonEnvelope(raw) {
  try {
    const value = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      typeof value.ok === "boolean" &&
      Object.hasOwn(value, "data") &&
      Object.hasOwn(value, "error")
    ) {
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

function validateHostAlias(alias) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) {
    throw commandError(
      "Invalid Host profile alias.",
      "Use letters, numbers, dots, underscores, or dashes, starting with a letter or number.",
    );
  }
}

function validateHostedDomain(domain) {
  const labels = domain.split(".");
  const valid =
    domain.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
  if (!valid) {
    throw commandError(
      "Invalid Hosted domain.",
      "Pass a DNS domain such as `example.com` without a scheme, path, or wildcard.",
    );
  }
}

function validateHostRemoteRoot(remoteRoot) {
  const segments = remoteRoot.split("/").filter(Boolean);
  const valid =
    remoteRoot.startsWith("/") &&
    remoteRoot !== "/" &&
    !remoteRoot.includes("\0") &&
    !remoteRoot.includes("\n") &&
    segments.every((segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment));
  if (!valid) {
    throw commandError("Invalid Host remote root.", "Pass an absolute POSIX path such as `/srv/sporades`.");
  }
}

function validateCapsuleSubname(subname) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subname)) {
    throw commandError(
      "Invalid Capsule subname.",
      "Use a lowercase DNS-safe label such as `notes` or `team-notes`.",
    );
  }
  if (RESERVED_CAPSULE_SUBNAMES.has(subname)) {
    throw commandError(
      "Reserved Capsule subname.",
      "Choose a Capsule subname other than www, api, admin, root, or host.",
    );
  }
}

function validateRemoteHelperAction(action) {
  if (!/^[a-z][a-z0-9.-]*$/.test(action)) {
    throw commandError(
      "Invalid remote Host helper action.",
      "Use a lowercase action name such as `contract.echo`.",
    );
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
  const templateFiles =
    options.template === "todo"
      ? todoTemplateFiles(options)
      : options.template === "guestbook"
        ? guestbookTemplateFiles(options)
        : blankTemplateFiles(options);

  return {
    "sporades.json": `${JSON.stringify(
      {
        name: options.name,
        template: options.template,
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
    "AGENTS.md": agentsTemplate(options.template),
    "CLAUDE.md": agentsTemplate(options.template),
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
    ...templateFiles,
  };
}

function blankTemplateFiles(options) {
  return {
    "README.md": `# ${options.name}\n\nA blank Sporades capsule.\n`,
    "server/index.ts": `import { capsule } from "sporades/server";

export default capsule({
  name: ${JSON.stringify(options.name)},
  schema: {},
  queries: {},
  mutations: {},
});
`,
    "client/index.tsx": blankClientTemplate(options.framework),
    "shared/types.ts": `export {};
`,
  };
}

function todoTemplateFiles(options) {
  return {
    "README.md": `# ${options.name}\n\nA Sporades todo capsule.\n`,
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
    "client/index.tsx": todoClientTemplate(options.framework),
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

function guestbookTemplateFiles(options) {
  return {
    "README.md": `# ${options.name}

A Sporades guestbook capsule.

Trusted author fields come from \`ctx.auth\` on the server, not from client-submitted input. Anonymous sessions can sign the guestbook, and Google-linked sessions display richer author metadata when configured with \`sporades auth set google\`.
`,
    "server/index.ts": `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: ${JSON.stringify(options.name)},

  schema: {
    entries: table({
      body: String(),
      authorId: String(),
      authorName: String(),
      authorPicture: String(),
    }),
  },

  queries: {
    entries: query((ctx) =>
      ctx.db.entries
        .orderBy("createdAt", "desc")
        .limit(50)
        .all(),
    ),
  },

  mutations: {
    sign: mutation((ctx, body) => {
      const trimmed = body.trim();
      if (!trimmed) {
        throw new Error("Write a message before signing.");
      }
      if (trimmed.length > 280) {
        throw new Error("Guestbook messages must be 280 characters or fewer.");
      }

      ctx.db.entries.insert({
        body: trimmed,
        authorId: ctx.auth.userId,
        authorName: ctx.auth.displayName,
        authorPicture: ctx.auth.picture ?? "",
      });
    }),
  },
});
`,
    "client/index.tsx": guestbookClientTemplate(options.framework),
    "shared/types.ts": `export type GuestbookEntry = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  authorPicture: string;
  createdAt: string;
  updatedAt: string;
};
`,
  };
}

function scaffoldSporadesDependency() {
  return `file:${CLI_ROOT}`;
}

function blankClientTemplate(framework) {
  if (framework === "preact") {
    return `import { render } from "preact";

function App() {
  return (
    <main>
      <h1>Blank Sporades Capsule</h1>
      <p>Start building in server/index.ts and client/index.tsx.</p>
    </main>
  );
}

render(<App />, document.getElementById("app")!);
`;
  }

  return `import { createRoot } from "react-dom/client";

function App() {
  return (
    <main>
      <h1>Blank Sporades Capsule</h1>
      <p>Start building in server/index.ts and client/index.tsx.</p>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
`;
}

function todoClientTemplate(framework) {
  if (framework === "preact") {
    return `import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { auth, createHooks } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });

function App() {
  const session = useAuth();
  const todos = useQuery("todos");
  const addTodo = useMutation("addTodo");
  const [text, setText] = useState("");

  return (
    <main>
      <h1>Sporades Todos</h1>
      {session.providers.google?.enabled && session.providers.google?.configured && !session.isAuthenticated() ? (
        <button type="button" onClick={() => auth.signIn("google")}>
          Sign in with Google
        </button>
      ) : null}
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
import { auth, createHooks } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });

function App() {
  const session = useAuth();
  const todos = useQuery("todos");
  const addTodo = useMutation("addTodo");
  const [text, setText] = useState("");

  return (
    <main>
      <h1>Sporades Todos</h1>
      {session.providers.google?.enabled && session.providers.google?.configured && !session.isAuthenticated() ? (
        <button type="button" onClick={() => auth.signIn("google")}>
          Sign in with Google
        </button>
      ) : null}
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

function guestbookClientTemplate(framework) {
  if (framework === "preact") {
    return `import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { auth, createHooks } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });
const maxLength = 280;

function App() {
  const session = useAuth();
  const entries = useQuery("entries");
  const sign = useMutation("sign");
  const [body, setBody] = useState("");
  const [authError, setAuthError] = useState("");
  const remaining = maxLength - body.length;

  async function signInWithGoogle() {
    setAuthError("");
    const result = await auth.signIn("google");
    if (result.error) {
      setAuthError(result.error.message);
    }
  }

  async function signOut() {
    setAuthError("");
    const result = await auth.signOut();
    if (result.error) {
      setAuthError(result.error.message);
    }
  }

  async function submit(event: Event) {
    event.preventDefault();
    const message = body.trim();
    if (!message || message.length > maxLength) return;
    const result = await sign.run(message);
    if (!result.error) setBody("");
  }

  return (
    <main class="shell">
      <style>{styles}</style>
      <section class="intro">
        <div>
          <p class="eyebrow">Sporades guestbook</p>
          <h1>Leave a note from this island.</h1>
        </div>
        <div class="auth-panel">
          <span>{session.auth?.displayName ?? "Anonymous"}</span>
          {!session.isAuthenticated() ? (
            <button type="button" onClick={signInWithGoogle}>
              Sign in with Google
            </button>
          ) : (
            <button class="secondary-button" type="button" onClick={signOut}>
              Sign out
            </button>
          )}
          {authError ? <p class="error">{authError}</p> : null}
        </div>
      </section>

      <form class="composer" onSubmit={submit}>
        <textarea
          value={body}
          maxLength={maxLength}
          placeholder="Write something kind, sharp, or strangely memorable."
          onInput={(event) => setBody(event.currentTarget.value)}
        />
        <div class="composer-row">
          <span class={remaining < 0 ? "over" : ""}>{remaining} characters left</span>
          <button type="submit" disabled={!body.trim() || sign.loading}>
            Sign guestbook
          </button>
        </div>
        {sign.error ? <p class="error">{sign.error.message}</p> : null}
      </form>

      <section class="entries">
        {(entries.data ?? []).map((entry) => (
          <article class="entry" key={entry.id}>
            {entry.authorPicture ? <img src={entry.authorPicture} alt="" /> : <span class="author-badge">{initials(entry.authorName)}</span>}
            <div>
              <div class="entry-meta">
                <strong>{entry.authorName}</strong>
                <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
              </div>
              <p>{entry.body}</p>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";
}

render(<App />, document.getElementById("app")!);

const styles = \`
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; background: #f6f3ed; color: #25211b; }
  .shell { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
  .intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
  .eyebrow { margin: 0 0 8px; color: #7a4b28; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; }
  h1 { margin: 0; max-width: 620px; font-size: clamp(2rem, 6vw, 4.8rem); line-height: 0.95; }
  .auth-panel { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; min-width: 220px; }
  button { border: 0; border-radius: 8px; background: #176b61; color: white; cursor: pointer; font: inherit; font-weight: 700; min-height: 42px; padding: 0 16px; }
  .secondary-button { background: #51483d; }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  .composer { background: white; border: 1px solid #ded6ca; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  textarea { width: 100%; min-height: 116px; box-sizing: border-box; resize: vertical; border: 1px solid #cfc6b8; border-radius: 8px; padding: 12px; font: inherit; }
  .composer-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 12px; }
  .over, .error { color: #a33b28; }
  .entries { display: grid; gap: 12px; }
  .entry { display: grid; grid-template-columns: 48px 1fr; gap: 14px; background: white; border: 1px solid #ded6ca; border-radius: 8px; padding: 14px; }
  .entry img, .author-badge { width: 48px; height: 48px; border-radius: 50%; }
  .author-badge { display: grid; place-items: center; background: #25211b; color: white; font-weight: 800; }
  .entry-meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
  time { color: #73695b; font-size: 0.88rem; }
  .entry p { margin: 8px 0 0; white-space: pre-wrap; }
  @media (max-width: 680px) { .intro, .composer-row { display: grid; } .auth-panel { justify-content: flex-start; } }
\`;
`;
  }

  return `import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { auth, createHooks } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });
const maxLength = 280;

function App() {
  const session = useAuth();
  const entries = useQuery("entries");
  const sign = useMutation("sign");
  const [body, setBody] = useState("");
  const [authError, setAuthError] = useState("");
  const remaining = maxLength - body.length;

  async function signInWithGoogle() {
    setAuthError("");
    const result = await auth.signIn("google");
    if (result.error) {
      setAuthError(result.error.message);
    }
  }

  async function signOut() {
    setAuthError("");
    const result = await auth.signOut();
    if (result.error) {
      setAuthError(result.error.message);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = body.trim();
    if (!message || message.length > maxLength) return;
    const result = await sign.run(message);
    if (!result.error) setBody("");
  }

  return (
    <main className="shell">
      <style>{styles}</style>
      <section className="intro">
        <div>
          <p className="eyebrow">Sporades guestbook</p>
          <h1>Leave a note from this island.</h1>
        </div>
        <div className="auth-panel">
          <span>{session.auth?.displayName ?? "Anonymous"}</span>
          {!session.isAuthenticated() ? (
            <button type="button" onClick={signInWithGoogle}>
              Sign in with Google
            </button>
          ) : (
            <button className="secondary-button" type="button" onClick={signOut}>
              Sign out
            </button>
          )}
          {authError ? <p className="error">{authError}</p> : null}
        </div>
      </section>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={body}
          maxLength={maxLength}
          placeholder="Write something kind, sharp, or strangely memorable."
          onChange={(event) => setBody(event.currentTarget.value)}
        />
        <div className="composer-row">
          <span className={remaining < 0 ? "over" : ""}>{remaining} characters left</span>
          <button type="submit" disabled={!body.trim() || sign.loading}>
            Sign guestbook
          </button>
        </div>
        {sign.error ? <p className="error">{sign.error.message}</p> : null}
      </form>

      <section className="entries">
        {(entries.data ?? []).map((entry) => (
          <article className="entry" key={entry.id}>
            {entry.authorPicture ? <img src={entry.authorPicture} alt="" /> : <span className="author-badge">{initials(entry.authorName)}</span>}
            <div>
              <div className="entry-meta">
                <strong>{entry.authorName}</strong>
                <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
              </div>
              <p>{entry.body}</p>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";
}

createRoot(document.getElementById("app")!).render(<App />);

const styles = \`
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; background: #f6f3ed; color: #25211b; }
  .shell { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
  .intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
  .eyebrow { margin: 0 0 8px; color: #7a4b28; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; }
  h1 { margin: 0; max-width: 620px; font-size: clamp(2rem, 6vw, 4.8rem); line-height: 0.95; }
  .auth-panel { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; min-width: 220px; }
  button { border: 0; border-radius: 8px; background: #176b61; color: white; cursor: pointer; font: inherit; font-weight: 700; min-height: 42px; padding: 0 16px; }
  .secondary-button { background: #51483d; }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  .composer { background: white; border: 1px solid #ded6ca; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  textarea { width: 100%; min-height: 116px; box-sizing: border-box; resize: vertical; border: 1px solid #cfc6b8; border-radius: 8px; padding: 12px; font: inherit; }
  .composer-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 12px; }
  .over, .error { color: #a33b28; }
  .entries { display: grid; gap: 12px; }
  .entry { display: grid; grid-template-columns: 48px 1fr; gap: 14px; background: white; border: 1px solid #ded6ca; border-radius: 8px; padding: 14px; }
  .entry img, .author-badge { width: 48px; height: 48px; border-radius: 50%; }
  .author-badge { display: grid; place-items: center; background: #25211b; color: white; font-weight: 800; }
  .entry-meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
  time { color: #73695b; font-size: 0.88rem; }
  .entry p { margin: 8px 0 0; white-space: pre-wrap; }
  @media (max-width: 680px) { .intro, .composer-row { display: grid; } .auth-panel { justify-content: flex-start; } }
\`;
`;
}

function agentsTemplate(template) {
  return `# Sporades App Instructions

This directory is for a Sporades app. Sporades is a CLI-first tool for building and running full-stack web apps.

Template: ${template}

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
