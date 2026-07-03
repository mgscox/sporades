#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authStatus, createBundle, parseServerEnv, readServerEnvFile } from "../src/bundle-pipeline.js";
import {
  ensureSealedServerEnvKeyPair,
  envelopeSummary,
  exportedEnvelope,
  readKeyPair,
  readSealedServerEnv,
  sealServerEnv,
  sealedServerEnvPaths,
  unsealServerEnv,
  writeSealedServerEnv,
} from "../src/sealed-server-env.js";
import {
  createWebSocketHub,
  dumpDatabase,
  handleFileHttpRoute,
  listDatabaseTables,
  openDevDatabase,
  prepareHttpSecurity,
  readJsonRequest,
  routeEndpoint,
  routeSporadesAuth,
  runReadOnlyQuery,
  simulateLocalIdentitySession,
} from "../src/server-runtime-source.js";
import { scaffoldFiles } from "../src/templates/scaffold-template.js";

const SUPPORTED_FRAMEWORKS = new Set(["react", "preact"]);
const SUPPORTED_TEMPLATES = new Set(["blank", "todo", "guestbook", "photo-library"]);
const DEV_SESSION_FILE = path.join(".sporades", "dev-session.json");
const CONTAINER_BINDING_FILE = path.join(".sporades", "binding.json");
const REMOTE_BINDING_FILE = path.join(".sporades", "remote-binding.json");
const DEV_REBUILD_DEBOUNCE_MS = 100;
const DEFAULT_HOST_SCHEME = "https";
const DEFAULT_HOST_REMOTE_ROOT = "/srv/sporades";
const DEFAULT_HOST_TLS_MODE = "automatic";
const HOST_TLS_MODES = new Set(["automatic", "cloudflare-origin"]);
const SECURITY_SESSIONS = new Set(["dev", "public-dev", "container", "hosted"]);
const DEFAULT_CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "connect-src": ["'self'", "ws:", "wss:"],
  "font-src": ["'self'", "data:"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "frame-ancestors": ["'none'"],
};
const RESERVED_CAPSULE_SUBNAMES = new Set(["www", "api", "admin", "root", "host"]);
const MAX_HOST_LOG_LINES = 10000;
const HOST_LOG_SOURCES = new Set(["http", "stdout", "stderr"]);
const HOST_HEALTH_PATH = "/__sporades/health";
const CAPSULE_RUNTIME_HEALTH_PATH = "/__sporades/health/runtime";
const DEFAULT_GITHUB_AUTODEPLOY_WORKFLOW = ".github/workflows/sporades-autodeploy.yml";
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

  if (command === "--help" || command === "-h") {
    printHelp();
    return;
  }

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

  if (command === "security") {
    await inspectSecurity(parseSecurityArgs(args));
    return;
  }

  if (command === "env") {
    await manageEnv(parseEnvArgs(args));
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

function printHelp() {
  process.stdout.write(`Usage: sporades <command> [options]

Commands:
  create <name>  Scaffold a new Capsule
  dev            Start a local Dev session
  auth           Manage local auth configuration and simulation
  security       Inspect effective Capsule security policy
  env            Manage Sealed Server env
  deploy         Start a local Container session
  host           Manage Host profiles and Hosted Capsules
  logs           Print Dev session logs
  db             Inspect the Dev session database

Options:
  --help, -h     Show this help
  --json         Write JSON output when supported by the command
`);
}

function parseCreateArgs(args) {
  let name = null;
  let framework = null;
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
  if (framework !== null && !SUPPORTED_FRAMEWORKS.has(framework)) {
    throw commandError(`Unsupported framework: ${framework}`, "Use one of: react, preact.");
  }
  if (!SUPPORTED_TEMPLATES.has(template)) {
    throw commandError(`Unsupported template: ${template}`, "Use one of: blank, todo, guestbook, photo-library.");
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
  let publicDev = false;

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
    if (arg === "--public") {
      publicDev = true;
      continue;
    }
    throw commandError(`Unknown flag: ${arg}`, "Use `sporades dev --port <number> --public --json`.");
  }

  return {
    port,
    json,
    publicDev,
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

function parseSecurityArgs(args) {
  let session = "dev";
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--session") {
      session = readFlagValue(args, ++index, "--session");
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw commandError(
      `Unknown flag: ${arg}`,
      "Use `sporades security --session dev|public-dev|container|hosted --json`.",
    );
  }

  if (!SECURITY_SESSIONS.has(session)) {
    throw commandError(
      `Invalid security session: ${session}`,
      "Use one of: dev, public-dev, container, hosted.",
    );
  }

  return {
    session,
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

function parseEnvArgs(args) {
  const [subcommand, ...rest] = args;
  let json = false;
  let file = null;
  let hostAlias = null;
  let output = null;
  let sealed = false;
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--file") {
      file = readFlagValue(rest, ++index, "--file");
      continue;
    }
    if (arg === "--host") {
      hostAlias = readFlagValue(rest, ++index, "--host");
      continue;
    }
    if (arg === "--output") {
      output = readFlagValue(rest, ++index, "--output");
      continue;
    }
    if (arg === "--sealed") {
      sealed = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw commandError(
        `Unknown flag: ${arg}`,
        "Use `sporades env init`, `sporades env import`, `sporades env status`, `sporades env export`, or `sporades env reencrypt`.",
      );
    }
    positional.push(arg);
  }

  if (["init", "import", "status", "export", "reencrypt"].includes(subcommand)) {
    if (positional.length > 0) {
      throw commandError("Too many positional arguments.", `Use \`sporades env ${subcommand} --json\`.`);
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    return { subcommand, file, hostAlias, output, sealed, json, projectDir: process.cwd() };
  }

  throw commandError(
    `Unknown env command: ${subcommand ?? ""}`.trim(),
    "Use `sporades env init`, `sporades env import`, `sporades env status`, `sporades env export`, or `sporades env reencrypt`.",
  );
}

function parseHostArgs(args) {
  const [subcommand, ...rest] = args;
  let json = false;
  let hostAlias = null;
  let server = null;
  let domain = null;
  let remoteRoot = DEFAULT_HOST_REMOTE_ROOT;
  let tlsMode = DEFAULT_HOST_TLS_MODE;
  let subname = null;
  let lines = null;
  let restart = false;
  let verify = false;
  let branch = "main";
  let file = DEFAULT_GITHUB_AUTODEPLOY_WORKFLOW;
  let dryRun = false;
  let force = false;
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
    if (arg === "--tls") {
      tlsMode = readFlagValue(rest, ++index, "--tls");
      continue;
    }
    if (arg === "--subname") {
      subname = readFlagValue(rest, ++index, "--subname");
      continue;
    }
    if (arg === "--lines" || arg === "-n") {
      lines = readHostLogLineCount(readFlagValue(rest, ++index, arg));
      continue;
    }
    if (arg === "--restart") {
      restart = true;
      continue;
    }
    if (arg === "--verify") {
      verify = true;
      restart = true;
      continue;
    }
    if (arg === "--branch") {
      branch = readFlagValue(rest, ++index, "--branch");
      continue;
    }
    if (arg === "--file") {
      file = readFlagValue(rest, ++index, "--file");
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw commandError(
        `Unknown flag: ${arg}`,
        "Use `sporades host add`, `sporades host use`, `sporades host current`, `sporades host health`, `sporades host bind`, `sporades host register`, `sporades host unregister`, `sporades host delete`, `sporades host push`, `sporades host bootstrap`, `sporades host list`, `sporades host releases`, `sporades host rollback`, `sporades host stats`, `sporades host logs`, or `sporades host invoke`.",
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
    validateHostTlsMode(tlsMode);
    return { subcommand, alias, server, domain, remoteRoot, tlsMode, json, projectDir: process.cwd() };
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

  if (subcommand === "health") {
    const [positionalSubname, ...extra] = positional;
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host health [subname] --host <alias> --json`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    if (positionalSubname) {
      validateCapsuleSubname(positionalSubname);
    }
    return { subcommand, subname: positionalSubname ?? null, hostAlias, json, projectDir: process.cwd() };
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

  if (subcommand === "stats") {
    const [positionalSubname, ...extra] = positional;
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host stats [subname] --host <alias>`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    if (positionalSubname) {
      validateCapsuleSubname(positionalSubname);
    }
    return { subcommand, subname: positionalSubname ?? null, hostAlias, json, projectDir: process.cwd() };
  }

  if (subcommand === "start" || subcommand === "stop" || subcommand === "restart" || subcommand === "unregister" || subcommand === "delete") {
    const [positionalSubname, ...extra] = positional;
    if (!positionalSubname) {
      throw commandError("Missing Capsule subname.", `Use \`sporades host ${subcommand} <subname> --host <alias>\`.`);
    }
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", `Use \`sporades host ${subcommand} <subname> --host <alias>\`.`);
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    validateCapsuleSubname(positionalSubname);
    return { subcommand, subname: positionalSubname, hostAlias, json, projectDir: process.cwd() };
  }

  if (subcommand === "releases") {
    const [positionalSubname, ...extra] = positional;
    if (!positionalSubname) {
      throw commandError("Missing Capsule subname.", "Use `sporades host releases <subname> --host <alias>`.");
    }
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host releases <subname> --host <alias>`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    validateCapsuleSubname(positionalSubname);
    return { subcommand, subname: positionalSubname, hostAlias, json, projectDir: process.cwd() };
  }

  if (subcommand === "rollback") {
    const [positionalSubname, releaseId, ...extra] = positional;
    if (!positionalSubname) {
      throw commandError("Missing Capsule subname.", "Use `sporades host rollback <subname> <release-id> --host <alias>`.");
    }
    if (!releaseId) {
      throw commandError("Missing Hosted Capsule release ID.", "Use `sporades host rollback <subname> <release-id> --host <alias>`.");
    }
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host rollback <subname> <release-id> --host <alias>`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    validateCapsuleSubname(positionalSubname);
    validateHostReleaseId(releaseId);
    return { subcommand, subname: positionalSubname, releaseId, hostAlias, json, projectDir: process.cwd() };
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
    return { subcommand, hostAlias, subname, restart, verify, json, projectDir: process.cwd() };
  }

  if (subcommand === "github") {
    const [area, action, ...extra] = positional;
    if (area !== "workflow" || action !== "write") {
      throw commandError(
        "Unknown GitHub Host command.",
        "Use `sporades host github workflow write --host <alias> --subname <capsule-subname>`.",
      );
    }
    if (extra.length > 0) {
      throw commandError(
        "Too many positional arguments.",
        "Use `sporades host github workflow write --host <alias> --subname <capsule-subname>`.",
      );
    }
    if (!hostAlias) {
      throw commandError("Missing Host profile alias.", "Pass `--host <alias>`.");
    }
    if (!subname) {
      throw commandError("Missing Capsule subname.", "Pass `--subname <capsule-subname>`.");
    }
    validateHostAlias(hostAlias);
    validateCapsuleSubname(subname);
    validateGithubWorkflowBranch(branch);
    validateGithubWorkflowFile(file);
    return { subcommand, github: { area, action }, hostAlias, subname, branch, file, dryRun, force, json, projectDir: process.cwd() };
  }

  if (subcommand === "logs") {
    const [source = "http", ...extra] = positional;
    if (extra.length > 0) {
      throw commandError("Too many positional arguments.", "Use `sporades host logs [http|stdout|stderr] --host <alias> --subname <capsule-subname> -n <lines> --json`.");
    }
    if (hostAlias) {
      validateHostAlias(hostAlias);
    }
    validateHostLogSource(source);
    if (subname) {
      validateCapsuleSubname(subname);
    }
    return { subcommand, source, hostAlias, subname, lines, json, projectDir: process.cwd() };
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
    "Use `sporades host add`, `sporades host use`, `sporades host current`, `sporades host health`, `sporades host bind`, `sporades host register`, `sporades host unregister`, `sporades host delete`, `sporades host push`, `sporades host bootstrap`, `sporades host list`, `sporades host releases`, `sporades host rollback`, `sporades host stats`, `sporades host logs`, or `sporades host invoke`.",
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

function validateHostLogSource(source) {
  if (!HOST_LOG_SOURCES.has(source)) {
    throw commandError(
      "Invalid Host log source.",
      "Use `sporades host logs [http|stdout|stderr] --host <alias> --subname <capsule-subname> -n <lines>`.",
    );
  }
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

  const files = scaffoldFiles({
    ...options,
    sporadesDependency: `file:${CLI_ROOT}`,
  });
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
  let config = await readProjectConfig(options.projectDir);
  const session = options.publicDev ? "public-dev" : "dev";
  let security = resolveEffectiveSecurityPolicy(config, session);
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
    capsuleModuleSource: bundle.serverRuntime.capsuleModuleSource,
    config: withRuntimeSecuritySession(config, session),
  });
  const websocketHub = createWebSocketHub(() => runtime.database);

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://127.0.0.1");

      if (prepareHttpSecurity(runtime.database, request, response)) {
        return;
      }

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
      const nextConfig = await readProjectConfig(options.projectDir);
      const nextSecurity = resolveEffectiveSecurityPolicy(nextConfig, session);
      const rebuild = await createBundle(options.projectDir, nextConfig);
      const affectsServerRuntime =
        change.affectsServerRuntime || (change.configChanged && configChangeAffectsServerRuntime(config, nextConfig));
      if (affectsServerRuntime) {
        await runtime.restart(
          rebuild.serverRuntime.source,
          rebuild.serverRuntime.env,
          rebuild.serverRuntime.capsuleModuleSource,
          withRuntimeSecuritySession(nextConfig, session),
        );
        websocketHub.disconnectAll();
      }
      config = nextConfig;
      security = nextSecurity;
      emitDevEvent(options, {
        event: "rebuild",
        status: "success",
        url,
        port: actualPort,
        security,
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
  emitDevEvent(options, { event: "started", url, port: actualPort, security });

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
  let database = await openDevDatabase(
    options.databasePath,
    options.serverSource,
    options.serverEnv,
    options.config,
    await importCapsuleDefinition(options.capsuleModuleSource),
  );

  return {
    get database() {
      return database;
    },
    async restart(serverSource, serverEnv, capsuleModuleSource, config) {
      const nextDatabase = await openDevDatabase(
        options.databasePath,
        serverSource,
        serverEnv,
        config,
        await importCapsuleDefinition(capsuleModuleSource),
      );
      database.close();
      database = nextDatabase;
    },
    async shutdown() {
      database.close();
    },
  };
}

async function importCapsuleDefinition(moduleSource) {
  const encodedModule = Buffer.from(moduleSource, "utf8").toString("base64");
  const module = await import(`data:text/javascript;base64,${encodedModule}`);
  return module.default ?? null;
}

function watchDevInputs(projectDir, onChange) {
  const watchedPaths = [
    { path: path.join(projectDir, "server"), affectsServerRuntime: true },
    { path: path.join(projectDir, "client"), affectsServerRuntime: false },
    { path: path.join(projectDir, "shared"), affectsServerRuntime: true },
    { path: path.join(projectDir, "index.html"), affectsServerRuntime: false },
    { path: path.join(projectDir, "sporades.json"), affectsServerRuntime: false, configChanged: true },
  ];
  const watchers = [];
  let debounceTimer = null;
  let pendingChange = null;
  let rebuildInFlight = false;
  let lastHandledSignature = null;

  const schedule = (change) => {
    pendingChange = {
      affectsServerRuntime: Boolean(pendingChange?.affectsServerRuntime || change.affectsServerRuntime),
      configChanged: Boolean(pendingChange?.configChanged || change.configChanged),
    };
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runPendingChange, DEV_REBUILD_DEBOUNCE_MS);
  };

  const runPendingChange = async () => {
    if (rebuildInFlight) {
      return;
    }
    const currentChange = pendingChange ?? { affectsServerRuntime: true };
    pendingChange = null;
    const currentSignature = readDevInputSignature(watchedPaths);
    if (currentSignature === lastHandledSignature) {
      return;
    }

    rebuildInFlight = true;
    try {
      await onChange(currentChange);
      lastHandledSignature = currentSignature;
    } finally {
      rebuildInFlight = false;
      if (pendingChange) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runPendingChange, DEV_REBUILD_DEBOUNCE_MS);
      }
    }
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

function configChangeAffectsServerRuntime(currentConfig, nextConfig) {
  return JSON.stringify(serverRuntimeConfig(currentConfig)) !== JSON.stringify(serverRuntimeConfig(nextConfig));
}

function serverRuntimeConfig(config) {
  const { client: _client, ...serverConfig } = config ?? {};
  return serverConfig;
}

function readDevInputSignature(watchedPaths) {
  const entries = [];

  for (const watchedPath of watchedPaths) {
    collectPathSignature(watchedPath.path, entries);
  }

  return entries.sort().join("\n");
}

function collectPathSignature(filePath, entries) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      entries.push(`${filePath}:missing`);
      return;
    }
    throw error;
  }

  if (stats.isDirectory()) {
    const children = readdirSync(filePath);
    if (children.length === 0) {
      entries.push(`${filePath}:dir:empty`);
      return;
    }
    for (const child of children) {
      collectPathSignature(path.join(filePath, child), entries);
    }
    return;
  }

  entries.push(`${filePath}:file:${stats.size}:${stats.mtimeMs}`);
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

async function inspectSecurity(options) {
  const config = await readProjectConfig(options.projectDir);
  const security = resolveEffectiveSecurityPolicy(config, options.session);

  if (options.json) {
    writeResult({
      ok: true,
      data: {
        session: options.session,
        security,
      },
      error: null,
    });
    return;
  }

  process.stdout.write(`Session: ${options.session}\n`);
  process.stdout.write(`CORS: ${security.cors.publicDev ? "public-dev" : "same-origin"}\n`);
  process.stdout.write(`CSP: ${security.csp.mode}\n`);
}

async function manageEnv(options) {
  const paths = sealedServerEnvPaths(options.projectDir);

  if (options.subcommand === "init") {
    const keyPair = await ensureSealedServerEnvKeyPair(paths);
    const existing = await readSealedServerEnv(paths);
    if (!existing) {
      await writeSealedServerEnv(paths, sealServerEnv({}, keyPair.publicKey, { source: "init" }));
    }
    await writeEnvResult(options, {
      ...envelopeSummary(await readSealedServerEnv(paths), paths),
      privateKeyConfigured: true,
    });
    return;
  }

  if (options.subcommand === "import") {
    const envPath = path.resolve(options.projectDir, options.file ?? ".env.sporades.server");
    if (options.sealed) {
      const envelope = await readPortableSealedServerEnvEnvelope(envPath);
      await writeSealedServerEnv(paths, envelope);
      await writeEnvResult(options, {
        ...envelopeSummary(envelope, paths),
        imported: true,
        sealed: true,
        source: normalisePathForOutput(path.relative(options.projectDir, envPath) || envPath),
      });
      return;
    }
    const env = parseServerEnv(await readServerEnvFile(envPath));
    const keyPair = await ensureSealedServerEnvKeyPair(paths);
    const envelope = sealServerEnv(env, keyPair.publicKey, {
      source: normalisePathForOutput(path.relative(options.projectDir, envPath) || envPath),
    });
    await writeSealedServerEnv(paths, envelope);
    await writeEnvResult(options, {
      ...envelopeSummary(envelope, paths),
      imported: true,
      source: normalisePathForOutput(path.relative(options.projectDir, envPath) || envPath),
      privateKeyConfigured: true,
    });
    return;
  }

  if (options.subcommand === "status") {
    const envelope = await readSealedServerEnv(paths);
    const keyPair = await readKeyPair(paths);
    await writeEnvResult(options, {
      ...envelopeSummary(envelope, paths),
      privateKeyConfigured: Boolean(keyPair?.privateKey),
      legacyServerEnvFilePresent: (await readServerEnvFile(path.join(options.projectDir, ".env.sporades.server"))).exists,
    });
    return;
  }

  if (options.subcommand === "export") {
    const envelope = await readSealedServerEnv(paths);
    if (!envelope) {
      throw commandError("No Sealed Server env configured.", "Run `sporades env import --file .env.sporades.server` first.");
    }
    const exported = exportedEnvelope(envelope);
    if (options.output) {
      const outputPath = path.resolve(options.projectDir, options.output);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(exported, null, 2)}\n`, { mode: 0o600 });
    }
    await writeEnvResult(options, {
      ...envelopeSummary(envelope, paths),
      exported: true,
      outputPath: options.output ? path.resolve(options.projectDir, options.output) : null,
      envelope: options.output ? null : exported,
    });
    return;
  }

  if (options.subcommand === "reencrypt") {
    if (!options.hostAlias) {
      throw commandError("Missing Host profile alias.", "Pass `--host <alias>`.");
    }
    const envelope = await readSealedServerEnv(paths);
    const localKeyPair = await readKeyPair(paths);
    if (!envelope || !localKeyPair) {
      throw commandError("No local Sealed Server env configured.", "Run `sporades env import --file .env.sporades.server` first.");
    }
    const values = unsealServerEnv(envelope, localKeyPair.privateKey);
    const hostConfig = await readHostConfig();
    const profile = requireHostProfile(hostConfig, options.hostAlias);
    const hostKey = await ensureHostProfileEnvKey(hostConfig, options.hostAlias);
    const hostEnvelope = sealServerEnv(values, hostKey.publicKey, {
      source: "host-profile-reencrypt",
      hostAlias: options.hostAlias,
      hostDomain: profile.domain,
    });
    const hostEnvelopePath = path.join(paths.hosts, `${options.hostAlias}.server-env.sealed.json`);
    await mkdir(path.dirname(hostEnvelopePath), { recursive: true, mode: 0o700 });
    await writeFile(hostEnvelopePath, `${JSON.stringify(hostEnvelope, null, 2)}\n`, { mode: 0o600 });
    await writeHostConfig(hostConfig);
    await writeEnvResult(options, {
      reencrypted: true,
      hostAlias: options.hostAlias,
      hostDomain: profile.domain,
      keyCount: Object.keys(hostEnvelope.entries).length,
      publicKeyFingerprint: hostEnvelope.publicKeyFingerprint,
      envelopePath: hostEnvelopePath,
      privateKeyConfigured: true,
    });
  }
}

async function readPortableSealedServerEnvEnvelope(filePath) {
  let envelope;
  try {
    envelope = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw commandError(
        "Sealed Server env export file was not found.",
        "Pass `--file <path>` pointing at a `sporades env export` JSON file.",
      );
    }
    throw commandError(
      "Invalid Sealed Server env export file.",
      "Pass a JSON file created by `sporades env export`.",
    );
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.version !== 1 ||
    envelope.valueAlgorithm !== "aes-256-gcm" ||
    !envelope.entries ||
    typeof envelope.entries !== "object" ||
    Array.isArray(envelope.entries)
  ) {
    throw commandError(
      "Invalid Sealed Server env export file.",
      "Pass a JSON file created by `sporades env export`.",
    );
  }
  if (JSON.stringify(envelope).includes("PRIVATE KEY") || Object.hasOwn(envelope, "privateKey")) {
    throw commandError(
      "Invalid Sealed Server env export file.",
      "Sealed envelope imports must not contain private keys.",
    );
  }
  return envelope;
}

async function writeEnvResult(options, data) {
  if (options.json) {
    writeResult({ ok: true, data, error: null });
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function ensureHostProfileEnvKey(config, alias) {
  const current = config.profiles[alias].sealedServerEnv;
  if (current?.publicKey && current?.privateKey) {
    return current;
  }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const hostKey = {
    publicKey,
    privateKey,
    publicKeyFingerprint: createHash("sha256").update(publicKey).digest("hex").slice(0, 16),
  };
  config.profiles[alias].sealedServerEnv = hostKey;
  return hostKey;
}

async function manageHost(options) {
  if (options.subcommand === "add") {
    const config = await readHostConfig();
    const profile = {
      server: options.server,
      domain: options.domain,
      scheme: DEFAULT_HOST_SCHEME,
      remoteRoot: options.remoteRoot,
      tls: { mode: options.tlsMode },
    };
    config.profiles[options.alias] = profile;
    await writeHostConfig(config);

    if (options.json) {
      writeResult({ ok: true, data: { alias: options.alias, profile: publicHostProfile(profile) }, error: null });
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
      writeResult({ ok: true, data: { currentHostAlias: options.alias, profile: publicHostProfile(profile) }, error: null });
    } else {
      process.stdout.write(`Current Host profile: ${options.alias}\n`);
    }
    return;
  }

  if (options.subcommand === "current") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const binding = await readRemoteBinding(options.projectDir);
    const security = await readOptionalProjectSecurity(options.projectDir, "hosted");

    if (options.json) {
      writeResult({
        ok: true,
        data: { alias: resolved.alias, profile: publicHostProfile(resolved.profile), binding, security },
        error: null,
      });
    } else {
      process.stdout.write(`${resolved.alias}\t${resolved.profile.server}\t${resolved.profile.domain}\n`);
    }
    return;
  }

  if (options.subcommand === "health") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    if (options.subname) {
      const health = createHostRuntimeHealthRequest(resolved.profile, options.subname);
      const result = invokeRemoteHostHelper({
        alias: resolved.alias,
        profile: resolved.profile,
        action: "capsule.health",
        subname: options.subname,
        health,
        projectDir: options.projectDir,
      });

      if (options.json) {
        writeResult(result, !result.ok);
        return;
      }

      if (!result.ok) {
        throw commandError(result.error.message, result.error.hint);
      }
      process.stdout.write(`Hosted Capsule runtime healthy: ${health.runtimeHealthUrl}\n`);
      return;
    }

    const result = await checkHostServerHealth(resolved.alias, resolved.profile);

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }
    process.stdout.write(`Host server healthy: ${result.data.healthUrl}\n`);
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
      lifecycle: options.verify ? createHostLifecycleRequest(target.alias, target.profile, target.subname) : null,
      health: options.verify ? createHostRuntimeHealthRequest(target.profile, target.subname) : null,
      verification: options.verify ? { enabled: true, health: createHostRuntimeHealthRequest(target.profile, target.subname) } : null,
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

  if (options.subcommand === "github" && options.github?.area === "workflow" && options.github?.action === "write") {
    const result = await writeGithubAutodeployWorkflow(options);
    if (options.json) {
      writeResult(result, false);
      return;
    }
    process.stdout.write(`${options.dryRun ? "Generated" : "Wrote"} GitHub Actions workflow: ${result.data.file}\n`);
    process.stdout.write("Required GitHub secret: SPORADES_HOST_SSH_PRIVATE_KEY\n");
    process.stdout.write(`Required GitHub variables: ${result.data.github.variables.join(", ")}\n`);
    if (options.dryRun) {
      process.stdout.write("\n");
      process.stdout.write(result.data.workflow);
    }
    return;
  }

  if (options.subcommand === "start" || options.subcommand === "stop" || options.subcommand === "restart") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const lifecycle = createHostLifecycleRequest(resolved.alias, resolved.profile, options.subname);
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: `capsule.${options.subcommand}`,
      subname: options.subname,
      lifecycle,
      projectDir: options.projectDir,
    });

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }
    process.stdout.write(`Hosted Capsule ${options.subcommand} completed: ${lifecycle.hostedUrl}\n`);
    return;
  }

  if (options.subcommand === "rollback") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const lifecycle = createHostLifecycleRequest(resolved.alias, resolved.profile, options.subname);
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: "capsule.release.rollback",
      subname: options.subname,
      rollback: { releaseId: options.releaseId },
      lifecycle,
      projectDir: options.projectDir,
    });

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }
    process.stdout.write(`Hosted Capsule rolled back: ${lifecycle.hostedUrl}\n`);
    return;
  }

  if (options.subcommand === "unregister") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const unregister = createHostUnregisterRequest(resolved.profile, options.subname);
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: "capsule.unregister",
      subname: options.subname,
      unregister,
      projectDir: options.projectDir,
    });

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }
    process.stdout.write(`Hosted Capsule unregistered: ${unregister.hostedUrl}\n`);
    return;
  }

  if (options.subcommand === "delete") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const deletion = createHostDeleteRequest(resolved.profile, options.subname);
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: "capsule.delete",
      subname: options.subname,
      delete: deletion,
      projectDir: options.projectDir,
    });

    if (options.json) {
      writeResult(result, !result.ok);
      return;
    }

    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }
    process.stdout.write(`Hosted Capsule storage deleted: ${deletion.hostedUrl}\n`);
    return;
  }

  if (options.subcommand === "stats") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const stats = options.subname ? createHostStatsRequest(resolved.profile, options.subname) : null;
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: options.subname ? "capsule.stats" : "host.stats",
      subname: options.subname,
      stats,
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

  if (options.subcommand === "releases") {
    const config = await readHostConfig();
    const resolved = resolveHostProfile(config, options.hostAlias);
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: "capsule.release.list",
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

    process.stdout.write(formatHostedCapsuleReleases(result.data));
    return;
  }

  if (options.subcommand === "logs") {
    const config = await readHostConfig();
    const source = options.source ?? "http";
    const target =
      source === "http"
        ? { ...resolveHostProfile(config, options.hostAlias), subname: options.subname ?? null }
        : await resolveHostPushTarget(config, options);
    const resolved = source === "http" ? target : { alias: target.alias, profile: target.profile };
    const result = invokeRemoteHostHelper({
      alias: resolved.alias,
      profile: resolved.profile,
      action: "host.logs",
      subname: target.subname,
      logs: {
        source,
        ...(options.lines === null ? {} : { lines: options.lines }),
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
  const sealedEnvArgs = bundle.containerMounts.sealedServerEnv
    ? [
        "--volume",
        formatMount(bundle.containerMounts.sealedServerEnv.envelope),
        "--volume",
        formatMount(bundle.containerMounts.sealedServerEnv.privateKey),
        "--env",
        `SPORADES_SEALED_SERVER_ENV_PATH=${bundle.containerMounts.sealedServerEnv.envelope.container}`,
        "--env",
        `SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH=${bundle.containerMounts.sealedServerEnv.privateKey.container}`,
      ]
    : [];
  const bundleMountArgs = bundle.containerMounts.files.flatMap((mount) => ["--volume", formatMount(mount)]);
  const containerId = runDocker(
    [
      "run",
      "--detach",
      "--name",
      containerName,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--publish",
      `${port}:4000`,
      ...bundleMountArgs,
      ...envArgs,
      ...sealedEnvArgs,
      "--volume",
      `${dataDir}:/app/data:rw`,
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
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw commandError("Invalid project configuration: sporades.json", "Fix the JSON syntax in sporades.json.");
  }
  validateSecurityConfig(config.security);
  return config;
}

async function readOptionalProjectSecurity(projectDir, session) {
  try {
    return resolveEffectiveSecurityPolicy(await readProjectConfig(projectDir), session);
  } catch (error) {
    if (error?.message === "Missing project configuration: sporades.json") {
      return null;
    }
    throw error;
  }
}

function validateSecurityConfig(security) {
  if (security === undefined) {
    return;
  }
  if (!security || typeof security !== "object" || Array.isArray(security)) {
    throw commandError("Invalid security policy.", "Set `security` in sporades.json to an object.");
  }
  const cors = security.cors;
  if (cors !== undefined) {
    if (!cors || typeof cors !== "object" || Array.isArray(cors)) {
      throw commandError("Invalid CORS policy.", "Set `security.cors` to an object with `allowedOrigins`.");
    }
    if (cors.allowedOrigins !== undefined && (!Array.isArray(cors.allowedOrigins) || !cors.allowedOrigins.every((origin) => typeof origin === "string"))) {
      throw commandError("Invalid CORS allowed origins.", "Set `security.cors.allowedOrigins` to an array of origin strings.");
    }
  }
  const csp = security.csp;
  if (csp !== undefined) {
    if (!csp || typeof csp !== "object" || Array.isArray(csp)) {
      throw commandError("Invalid CSP policy.", "Set `security.csp` to an object with `mode`.");
    }
    if (csp.mode !== undefined && csp.mode !== "report-only" && csp.mode !== "enforce") {
      throw commandError("Invalid CSP mode.", "Use `security.csp.mode` of `report-only` or `enforce`.");
    }
  }
}

function resolveEffectiveSecurityPolicy(config, session) {
  const security = config.security ?? {};
  const cors = security.cors ?? {};
  const csp = security.csp ?? {};
  const publicDev = session === "public-dev";
  const dev = session === "dev" || publicDev;
  const configuredOrigins = [...(cors.allowedOrigins ?? [])];
  const devOrigins = dev && !publicDev ? ["http://localhost:*", "http://127.0.0.1:*"] : [];
  const allowedOrigins = publicDev ? ["*"] : configuredOrigins;

  return {
    cors: {
      sameOrigin: !publicDev,
      publicDev,
      allowedOrigins,
      allowedOriginPatterns: devOrigins,
      requireExplicitCrossOrigin: !dev && configuredOrigins.length === 0,
    },
    headers: {
      contentTypeOptions: "nosniff",
      referrerPolicy: "no-referrer",
      frameOptions: "DENY",
      permissionsPolicy: "camera=(), microphone=(), geolocation=()",
      crossOriginOpenerPolicy: "same-origin",
      suppressTechnologyHeaders: true,
    },
    csp: {
      mode: csp.mode ?? "report-only",
      header: (csp.mode ?? "report-only") === "enforce" ? "content-security-policy" : "content-security-policy-report-only",
      directives: {
        ...DEFAULT_CSP_DIRECTIVES,
        ...(csp.directives ?? {}),
      },
    },
  };
}

function withRuntimeSecuritySession(config, session) {
  return {
    ...config,
    __sporadesSession: session,
  };
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
    profiles: normaliseHostProfiles(value?.profiles),
    currentHostAlias: typeof value?.currentHostAlias === "string" ? value.currentHostAlias : null,
  };
}

function normaliseHostProfiles(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([alias, profile]) => [
      alias,
      {
        ...profile,
        tls: normaliseHostTls(profile?.tls),
      },
    ]),
  );
}

function normaliseHostTls(value) {
  const mode = typeof value?.mode === "string" && HOST_TLS_MODES.has(value.mode) ? value.mode : DEFAULT_HOST_TLS_MODE;
  return { mode };
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

function publicHostProfile(profile) {
  if (!profile?.sealedServerEnv) {
    return profile;
  }
  const { sealedServerEnv, ...rest } = profile;
  return {
    ...rest,
    sealedServerEnv: {
      configured: true,
      publicKeyFingerprint: sealedServerEnv.publicKeyFingerprint ?? null,
    },
  };
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
  if (options.stats) {
    request.stats = options.stats;
  }
  if (options.health) {
    request.health = options.health;
  }
  if (options.release) {
    request.release = options.release;
  }
  if (options.rollback) {
    request.rollback = options.rollback;
  }
  if (options.verification) {
    request.verification = options.verification;
  }
  if (options.lifecycle) {
    request.lifecycle = options.lifecycle;
  }
  if (options.unregister) {
    request.unregister = options.unregister;
  }
  if (options.delete) {
    request.delete = options.delete;
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
  const packageDir = path.join(hostPushDir, `${releaseId}-files`);
  const remoteArchive = posixJoin(options.profile.remoteRoot, "incoming", `${releaseId}.tar.gz`);
  const sealedServerEnv = await createHostReleaseSealedServerEnv(options, packageDir);
  const releaseRequest = createHostReleaseRequest({
    alias: options.alias,
    profile: options.profile,
    subname: options.subname,
    binding: options.binding,
    releaseId,
    remoteArchive,
    bundle: options.bundle,
    restart: options.restart,
    sealedServerEnv,
  });
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(path.join(packageDir, ".sporades", "sealed-server-env"), { recursive: true });
  await Promise.all([
    writeFile(path.join(packageDir, "server.mjs"), await readFile(path.join(options.bundle.buildDir, "server.mjs"), "utf8")),
    writeFile(path.join(packageDir, "client.js"), await readFile(path.join(options.bundle.buildDir, "client.js"), "utf8")),
    writeFile(path.join(packageDir, "index.html"), await readFile(path.join(options.projectDir, "index.html"), "utf8")),
    writeFile(path.join(packageDir, "sporades.json"), await readFile(path.join(options.projectDir, "sporades.json"), "utf8")),
  ]);
  if (options.bundle.containerMounts.serverEnv) {
    await writeFile(path.join(packageDir, ".env.sporades.server"), await readFile(options.bundle.containerMounts.serverEnv.host, "utf8"));
  }
  if (sealedServerEnv) {
    await writeFile(
      path.join(packageDir, ".sporades", "sealed-server-env", "server-env.sealed.json"),
      await readFile(sealedServerEnv.envelopePath, "utf8"),
    );
  }
  const tarArgs = [
    "-czf",
    localArchive,
    "server.mjs",
    "client.js",
    "index.html",
    "sporades.json",
  ];
  if (options.bundle.containerMounts.serverEnv) {
    tarArgs.push(".env.sporades.server");
  }
  if (sealedServerEnv) {
    tarArgs.push(".sporades/sealed-server-env/server-env.sealed.json");
  }
  const result = spawnSync("tar", tarArgs, { cwd: packageDir, encoding: "utf8" });
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

async function createHostReleaseSealedServerEnv(options, packageDir) {
  if (!options.bundle.containerMounts.sealedServerEnv) {
    return null;
  }
  const localPaths = sealedServerEnvPaths(options.projectDir);
  const hostEnvelopePath = path.join(localPaths.hosts, `${options.alias}.server-env.sealed.json`);
  let envelopePath = hostEnvelopePath;
  let privateKey = options.profile.sealedServerEnv?.privateKey ?? null;
  try {
    await readFile(envelopePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    envelopePath = options.bundle.containerMounts.sealedServerEnv.envelope.host;
    privateKey = await readFile(options.bundle.containerMounts.sealedServerEnv.privateKey.host, "utf8");
  }
  if (!privateKey) {
    throw commandError(
      "Host Sealed Server env private key is missing.",
      `Run \`sporades env reencrypt --host ${options.alias}\` before \`sporades host push\`.`,
    );
  }
  return {
    included: true,
    envelopePath,
    privateKey,
    releaseKeyPath: posixJoin(
      options.profile.remoteRoot,
      "hosts",
      options.profile.domain,
      "capsules",
      options.subname,
      "data",
      "sealed-server-env",
      "server-env.private.pem",
    ),
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
  if (options.sealedServerEnv) {
    files.push(".sporades/sealed-server-env/server-env.sealed.json");
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
    sealedServerEnvIncluded: Boolean(options.sealedServerEnv),
    sealedServerEnv: options.sealedServerEnv
      ? {
          privateKey: options.sealedServerEnv.privateKey,
          privateKeyPath: options.sealedServerEnv.releaseKeyPath,
        }
      : null,
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

function createHostLifecycleRequest(alias, profile, subname) {
  const registration = createHostRegistrationRequest(alias, profile, subname);
  const currentLink = posixJoin(registration.directories.capsule, "current");
  const containerName = createHostedContainerName(profile.domain, subname);
  const remoteCapsuleId = `${profile.domain}/${subname}`;
  return {
    domain: profile.domain,
    subname,
    hostedUrl: `${profile.scheme}://${subname}.${profile.domain}`,
    remoteCapsuleId,
    currentLink,
    directories: registration.directories,
    mounts: {
      files: [
        { host: posixJoin(currentLink, "server.mjs"), container: "/app/server.mjs", mode: "ro" },
        { host: posixJoin(currentLink, "client.js"), container: "/app/client.js", mode: "ro" },
        { host: posixJoin(currentLink, "index.html"), container: "/app/index.html", mode: "ro" },
        { host: posixJoin(currentLink, "sporades.json"), container: "/app/sporades.json", mode: "ro" },
        { host: posixJoin(currentLink, ".env.sporades.server"), container: "/app/.env.sporades.server", mode: "ro", optional: true },
        {
          host: posixJoin(currentLink, ".sporades/sealed-server-env/server-env.sealed.json"),
          container: "/app/.sporades/sealed-server-env/server-env.sealed.json",
          mode: "ro",
          optional: true,
        },
        {
          host: posixJoin(registration.directories.data, "sealed-server-env/server-env.private.pem"),
          container: "/app/.sporades/sealed-server-env/server-env.private.pem",
          mode: "ro",
          optional: true,
        },
      ],
      data: {
        host: registration.directories.data,
        container: "/app/data",
        mode: "rw",
      },
    },
    container: {
      name: containerName,
      labels: {
        "com.sporades.managed": "true",
        "com.sporades.hosted-domain": profile.domain,
        "com.sporades.capsule-subname": subname,
        "com.sporades.capsule-id": remoteCapsuleId,
      },
    },
    routes: {
      running: {
        hostname: `${subname}.${profile.domain}`,
        target: "container",
        containerName,
        port: 4000,
        routeFile: registration.route.routeFile,
        tls: registration.route.tls,
      },
      unavailable: registration.route,
    },
  };
}

function createHostStatsRequest(profile, subname) {
  return {
    domain: profile.domain,
    subname,
    hostedUrl: `${profile.scheme}://${subname}.${profile.domain}`,
    remoteCapsuleId: `${profile.domain}/${subname}`,
    container: {
      name: createHostedContainerName(profile.domain, subname),
    },
  };
}

function createHostRuntimeHealthRequest(profile, subname) {
  const hostedUrl = `${profile.scheme}://${subname}.${profile.domain}`;
  return {
    domain: profile.domain,
    subname,
    hostedUrl,
    remoteCapsuleId: `${profile.domain}/${subname}`,
    runtimeHealthUrl: `${hostedUrl}${CAPSULE_RUNTIME_HEALTH_PATH}`,
    container: {
      name: createHostedContainerName(profile.domain, subname),
    },
  };
}

function createHostedContainerName(domain, subname) {
  return `sporades-${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${subname}`;
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

function formatHostedCapsuleReleases(data) {
  const releases = Array.isArray(data?.releases) ? data.releases : [];
  const subname = data?.capsule?.subname ?? "Hosted Capsule";
  if (releases.length === 0) {
    return `No releases recorded for ${subname}.\n`;
  }

  const rows = releases.map((release) => ({
    id: String(release.id ?? ""),
    state: String(release.state ?? "uploaded"),
    current: release.current ? "yes" : "no",
    createdAt: String(release.createdAt ?? "unknown"),
  }));
  const headers = {
    id: "RELEASE",
    state: "STATE",
    current: "CURRENT",
    createdAt: "CREATED",
  };
  const widths = Object.fromEntries(
    Object.keys(headers).map((key) => [key, Math.max(headers[key].length, ...rows.map((row) => row[key].length))]),
  );
  const line = (row) =>
    [row.id, row.state, row.current, row.createdAt]
      .map((value, index) => {
        const key = ["id", "state", "current", "createdAt"][index];
        return index === 3 ? value : value.padEnd(widths[key] + 2);
      })
      .join("");

  return `${line(headers)}\n${rows.map(line).join("\n")}\n`;
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

function createHostHealthUrl(profile) {
  return `${profile.scheme ?? DEFAULT_HOST_SCHEME}://host.${profile.domain}${HOST_HEALTH_PATH}`;
}

async function checkHostServerHealth(alias, profile) {
  const healthUrl = createHostHealthUrl(profile);
  const failureData = (failure, extra = {}) => ({
    alias,
    healthUrl,
    failure,
    ...extra,
  });

  let response;
  try {
    response = await fetch(healthUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const failure = classifyHostHealthFetchFailure(error);
    if (failure === "unreachable") {
      return {
        ok: false,
        data: failureData("unreachable"),
        error: {
          message: "Host server is unreachable.",
          hint: "Check DNS for the Host server health name, network connectivity, and whether the Host server is running.",
        },
      };
    }
    return {
      ok: false,
      data: failureData("tls-http"),
      error: {
        message: "Host server health request failed during TLS or HTTP.",
        hint: "Check TLS mode, certificate configuration, Caddy, and the Host server health route.",
      },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      data: failureData("tls-http", { statusCode: response.status }),
      error: {
        message: "Host server health returned an HTTP failure.",
        hint: "Check TLS mode, certificate configuration, Caddy, and the Host server health route.",
      },
    };
  }

  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return unexpectedHostHealthResponse(alias, healthUrl, response.status);
  }

  if (!isExpectedHostHealthResponse(body)) {
    return unexpectedHostHealthResponse(alias, healthUrl, response.status);
  }

  return {
    ok: true,
    data: {
      alias,
      healthUrl,
      response: body,
    },
    error: null,
  };
}

function classifyHostHealthFetchFailure(error) {
  const code = error?.cause?.code ?? error?.code;
  if (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(code)
  ) {
    return "unreachable";
  }
  return "tls-http";
}

function isExpectedHostHealthResponse(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.ok === true &&
    Object.keys(value).length === 1
  );
}

function unexpectedHostHealthResponse(alias, healthUrl, statusCode) {
  return {
    ok: false,
    data: {
      alias,
      healthUrl,
      failure: "unexpected-response",
      statusCode,
    },
    error: {
      message: "Host server health response had an unexpected shape.",
      hint: `Run \`sporades host bootstrap --host ${alias}\` and check the generated Host server health route.`,
    },
  };
}

function remoteHostHelperPath(profile) {
  return `${profile.remoteRoot}/bin/sporades-host-helper`;
}

function createHostBootstrapRequest(profile) {
  const caddyDirectory = posixJoin(profile.remoteRoot, "caddy");
  const hostsDirectory = posixJoin(profile.remoteRoot, "hosts");
  const domainDirectory = posixJoin(profile.remoteRoot, "hosts", profile.domain);
  const tlsDirectory = posixJoin(domainDirectory, "tls");
  const tlsMode = normaliseHostTls(profile.tls).mode;
  return {
    substrate: {
      packages: ["docker", "caddy"],
      services: ["docker", "caddy"],
    },
    directories: {
      remoteRoot: profile.remoteRoot,
      bin: posixJoin(profile.remoteRoot, "bin"),
      incoming: posixJoin(profile.remoteRoot, "incoming"),
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
      mode: tlsMode,
      directory: tlsDirectory,
      certificate: tlsMode === "cloudflare-origin" ? posixJoin(tlsDirectory, "origin.crt") : null,
      key: tlsMode === "cloudflare-origin" ? posixJoin(tlsDirectory, "origin.key") : null,
    },
    caddy: {
      managedInclude: posixJoin(caddyDirectory, "sporades-hosted-domains.caddy"),
      domainInclude: posixJoin(caddyDirectory, "hosts", `${profile.domain}.caddy`),
    },
  };
}

function createHostRegistrationRequest(alias, profile, subname) {
  const bootstrap = createHostBootstrapRequest(profile);
  const capsuleDirectory = posixJoin(bootstrap.directories.capsules, subname);
  const capsuleLog = posixJoin(capsuleDirectory, "logs", "http.log");
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
      logs: posixJoin(capsuleDirectory, "logs"),
    },
    route: {
      hostname: `${subname}.${profile.domain}`,
      target: "hosted-capsule-unavailable",
      statusCode: 503,
      routeFile: posixJoin(bootstrap.directories.caddyHosts, profile.domain, `${subname}.caddy`),
      tls: bootstrap.tls,
      log: { file: capsuleLog },
    },
    bootstrap: {
      command: `sporades host bootstrap --host ${alias}`,
      tls: bootstrap.tls,
    },
  };
}

function createHostUnregisterRequest(profile, subname) {
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
    container: {
      name: createHostedContainerName(profile.domain, subname),
    },
    routes: {
      removed: {
        hostname: `${subname}.${profile.domain}`,
        target: "removed",
        routeFile: posixJoin(bootstrap.directories.caddyHosts, profile.domain, `${subname}.caddy`),
      },
    },
  };
}

function createHostDeleteRequest(profile, subname) {
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
    routes: {
      removed: {
        hostname: `${subname}.${profile.domain}`,
        target: "removed",
        routeFile: posixJoin(bootstrap.directories.caddyHosts, profile.domain, `${subname}.caddy`),
      },
    },
  };
}

async function writeGithubAutodeployWorkflow(options) {
  const workflow = createGithubAutodeployWorkflow({
    hostAlias: options.hostAlias,
    subname: options.subname,
    branch: options.branch,
  });
  const outputPath = path.resolve(options.projectDir, options.file);
  const relativeFile = path.relative(options.projectDir, outputPath) || options.file;
  if (relativeFile === ".." || relativeFile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFile)) {
    throw commandError(
      "Invalid GitHub workflow file path.",
      "Pass a relative path inside the project, such as `.github/workflows/sporades-autodeploy.yml`.",
    );
  }
  const github = {
    secrets: ["SPORADES_HOST_SSH_PRIVATE_KEY"],
    variables: [
      "SPORADES_HOST_SERVER",
      "SPORADES_HOST_DOMAIN",
      "SPORADES_HOST_REMOTE_ROOT",
    ],
  };

  if (options.dryRun) {
    return {
      ok: true,
      data: {
        file: normalisePathForOutput(relativeFile),
        written: false,
        workflow,
        github,
      },
      error: null,
    };
  }

  try {
    await readFile(outputPath, "utf8");
    if (!options.force) {
      throw commandError(
        "GitHub Actions workflow already exists.",
        "Pass `--force` to overwrite it, or choose another path with `--file <path>`.",
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, workflow);

  return {
    ok: true,
    data: {
      file: normalisePathForOutput(relativeFile),
      written: true,
      workflow,
      github,
    },
    error: null,
  };
}

function createGithubAutodeployWorkflow({ hostAlias, subname, branch }) {
  return `name: Sporades Autodeploy

on:
  push:
    branches: [${JSON.stringify(branch)}]
  pull_request:
    branches: [${JSON.stringify(branch)}]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

env:
  SPORADES_HOST_ALIAS: ${hostAlias}
  SPORADES_HOST_SUBNAME: ${subname}
  SPORADES_HOST_SERVER: \${{ vars.SPORADES_HOST_SERVER }}
  SPORADES_HOST_DOMAIN: \${{ vars.SPORADES_HOST_DOMAIN }}
  SPORADES_HOST_REMOTE_ROOT: \${{ vars.SPORADES_HOST_REMOTE_ROOT }}
  SPORADES_AUTODEPLOY_SUMMARY: \${{ runner.temp }}/sporades-autodeploy-summary.md

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then
            npm ci
          else
            npm install
          fi

      - name: Run project tests
        run: |
          if node -e "const p = require('./package.json'); process.exit(p.scripts && p.scripts.test ? 0 : 1)"; then
            npm test
          else
            echo "No npm test script declared; skipping project tests."
          fi

      - name: Configure Host SSH key
        run: |
          mkdir -p ~/.ssh
          printf '%s\\n' "\${{ secrets.SPORADES_HOST_SSH_PRIVATE_KEY }}" > ~/.ssh/sporades_host_key
          chmod 600 ~/.ssh/sporades_host_key
          cat >> ~/.ssh/config <<'SSH_CONFIG'
          Host *
            IdentityFile ~/.ssh/sporades_host_key
            IdentitiesOnly yes
            StrictHostKeyChecking accept-new
          SSH_CONFIG

      - name: Configure Sporades Host profile
        run: |
          npx sporades host add "$SPORADES_HOST_ALIAS" \\
            --server "$SPORADES_HOST_SERVER" \\
            --domain "$SPORADES_HOST_DOMAIN" \\
            --remote-root "$SPORADES_HOST_REMOTE_ROOT" \\
            --json

      - name: Sporades release preflight
        run: |
          npx sporades host current --host "$SPORADES_HOST_ALIAS" --json
          npx sporades host health --host "$SPORADES_HOST_ALIAS" --json

      - name: Push verified Hosted Capsule release
        id: sporades_deploy
        shell: bash
        run: |
          set +e
          npx sporades host push --host "$SPORADES_HOST_ALIAS" --subname "$SPORADES_HOST_SUBNAME" --verify --json > "$RUNNER_TEMP/sporades-host-push.json"
          deploy_exit=$?
          set -e
          node <<'NODE'
          const fs = require("node:fs");

          const outputPath = process.env.RUNNER_TEMP + "/sporades-host-push.json";
          const raw = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
          let envelope = null;
          try {
            envelope = JSON.parse(raw);
          } catch {
            envelope = null;
          }

          const data = envelope?.data ?? {};
          const verification = data.verification ?? {};
          const hostedUrl =
            data.capsule?.hostedUrl ??
            data.release?.hostedUrl ??
            "https://" + process.env.SPORADES_HOST_SUBNAME + "." + process.env.SPORADES_HOST_DOMAIN;
          const releaseId = data.release?.id ?? data.currentAttemptedRelease?.id ?? "unknown";
          const verificationState =
            verification?.state ??
            (data.verified === true ? "verified" : data.verified === false ? "failed" : envelope?.ok ? "not reported" : "command failed");
          const resultLabel = verificationState === "failed" ? "Verification failed" : envelope?.ok ? "Successful deploy" : "Command failed";
          const previousReleaseId = data.previousCurrentRelease?.id ?? data.rollbackGuidance?.previousReleaseId ?? null;
          const rollbackCommand =
            data.rollbackGuidance?.command ??
            (verificationState === "failed" && previousReleaseId
              ? "sporades host rollback " + process.env.SPORADES_HOST_SUBNAME + " " + previousReleaseId + " --host " + process.env.SPORADES_HOST_ALIAS
              : null);

          function escapeCell(value) {
            return String(value ?? "unknown").replace(/\\|/g, "\\\\|").replace(/\\r?\\n/g, " ");
          }

          function hostedCell(url) {
            if (/^https?:\\/\\//.test(url)) {
              return "[" + escapeCell(url) + "](" + url + ")";
            }
            return escapeCell(url);
          }

          const lines = [
            "## Sporades autodeploy result",
            "",
            "| Field | Value |",
            "| --- | --- |",
            "| Result | " + escapeCell(resultLabel) + " |",
            "| Hosted Capsule | " + hostedCell(hostedUrl) + " |",
            "| Release ID | " + escapeCell(releaseId) + " |",
            "| Verification | " + escapeCell(verificationState) + " |",
          ];

          if (!envelope) {
            lines.push("", "No structured Sporades deploy output was available.");
          } else if (!envelope.ok && envelope.error?.message) {
            lines.push("", "Failure: " + envelope.error.message);
          }

          if (rollbackCommand) {
            lines.push(
              "",
              "### Rollback guidance",
              "",
              "Sporades did not roll back automatically. To roll back manually, run:",
              "",
              "    " + rollbackCommand,
            );
          } else if (verificationState === "failed") {
            lines.push(
              "",
              "### Rollback guidance",
              "",
              "No previous release was reported, so no rollback command is available.",
            );
          }

          const summary = lines.join("\\n") + "\\n";
          fs.writeFileSync(process.env.SPORADES_AUTODEPLOY_SUMMARY, summary);
          fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
          NODE
          exit "$deploy_exit"

      - name: Publish pull request deploy result
        if: always() && github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('node:fs');
            const summaryPath = process.env.SPORADES_AUTODEPLOY_SUMMARY;
            const body = fs.existsSync(summaryPath)
              ? fs.readFileSync(summaryPath, 'utf8')
              : '## Sporades autodeploy result\\n\\nDeploy result summary was unavailable.\\n';
            await github.rest.pulls.createReview({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.payload.pull_request.number,
              event: 'COMMENT',
              body
            });
`;
}

function normalisePathForOutput(filePath) {
  return filePath.split(path.sep).join("/");
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

function validateHostTlsMode(tlsMode) {
  if (!HOST_TLS_MODES.has(tlsMode)) {
    throw commandError(
      "Invalid Host TLS mode.",
      "Use `--tls automatic` for Caddy-managed certificates or `--tls cloudflare-origin` for preinstalled Cloudflare origin certificates.",
    );
  }
}

function validateHostReleaseId(releaseId) {
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(releaseId)) {
    throw commandError(
      "Invalid Hosted Capsule release ID.",
      "Use a recorded release ID from `sporades host releases <subname> --json`.",
    );
  }
}

function validateGithubWorkflowBranch(branch) {
  if (
    !branch ||
    branch.length > 255 ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("\\") ||
    /[\0\s~^:?*[\\\]]/.test(branch)
  ) {
    throw commandError("Invalid GitHub workflow branch.", "Pass a branch name such as `main` or `release/stable`.");
  }
}

function validateGithubWorkflowFile(filePath) {
  if (!filePath || path.isAbsolute(filePath) || filePath.includes("\0")) {
    throw commandError("Invalid GitHub workflow file path.", "Pass a relative path such as `.github/workflows/sporades-autodeploy.yml`.");
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
