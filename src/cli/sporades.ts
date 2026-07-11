#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { appendFile, chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authStatus, createBundle, parseServerEnv, readServerEnvFile } from "../bundle-pipeline.js";
import {
  discardPublicTree,
  getProcessStartIdentity,
  readPublicAsset,
  readPublicTreeConsumer,
  removePublicTreeConsumer,
  restorePublicTreeConsumer,
  summarizePublicTree,
  writePublicTreeConsumer,
} from "../public-tree.js";
import {
  SPORADES_BASE_IMAGE,
  baseImageLabels,
  baseImageRuntimeUser,
} from "../base-image.js";
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
} from "../sealed-server-env.js";
import { DockerRestartPolcy, restartPolicyForMode, restartPolicyStatus } from "../runtime-restart-policy.js";
import {
  createSqliteDatabaseAdapter,
  createLogEnvelope,
  createPrivilegedAuditLogInput,
  createPostgresConnection,
  createWebSocketHub,
  dumpDatabase,
  handleFileHttpRoute,
  injectPageConnectionToken,
  listDatabaseTables,
  openDevDatabase,
  prepareHttpSecurity,
  readJsonRequest,
  routeEndpoint,
  routeSporadesAuth,
  runReadOnlyQuery,
  simulateLocalIdentitySession,
  readJsonlLogEvents,
  validateReadOnlyInspectionSql,
  writeUnhandledHttpError,
} from "../server-runtime-source.js";
import { scaffoldFiles } from "../templates/scaffold-template.js";
import {
  CAPSULE_SERVICES_COMPOSE_FILE,
  CAPSULE_SERVICES_STATE_DIR,
  capsuleServicesComposeModel,
  validateCapsuleServicesConfig,
  writeCapsuleServicesCompose,
} from "../capsule-services.js";
import {
  createHostBootstrapRequest,
  createHostDeleteRequest,
  createHostLifecycleRequest,
  createHostRegistrationRequest,
  createHostReleaseRequest,
  createHostRuntimeHealthRequest,
  createHostStatsRequest,
  createHostUnregisterRequest,
} from "./host-request-builders.js";
import { renderCliHelp } from "./cli-help.js";
import { sanitizeScheduleInspectionEnvelope } from "./schedule-inspection-envelope.js";
import {
  DOCTOR_SESSIONS,
  createDoctorEnvelope,
  doctorShouldExitNonZero,
  renderDoctorHumanOutput,
  runDoctorChecks,
} from "./doctor.js";
import { createGithubAutodeployWorkflow } from "./github-autodeploy-workflow.js";
import {
  SECURITY_SESSIONS,
  authorizedKeyFingerprint,
  readBaseImageUpdatePolicy,
  readOptionalProjectSecurity,
  readProjectConfig,
  resolveAuthorizedKeyLines,
  resolveEffectiveSecurityPolicy,
  resolveLocalContainerSshAccess,
  withRuntimeSecuritySession,
} from "./project-config.js";
import { WithImplicitCoercion } from "buffer";
import { PathLike } from "fs";
import { FileHandle } from "fs/promises";
import { SpawnSyncReturns } from "child_process";
import { ServerResponse, IncomingMessage } from "http";
import type {
  HostHelperEnvelope,
} from "./host-helper-contract.js";
import { commandError, errorDetails, writeResult, type CommandError, type LooseRecord } from "./cli-support.js";
import { CLI_VERSION } from "./cli-version.js";

type HostProfile = LooseRecord;
type CapsuleService = LooseRecord;
type CapsuleServicesModel = LooseRecord & {
  networks: { services: string };
  path: string;
  projectSlug: string;
  relativePath: string;
  services: Record<string, CapsuleService>;
};
type ServiceEnv = Record<string, string>;
type CapsuleServiceConnection = { host: string; port: number; url?: string };
type StartCapsuleServicesOptions = {
  connection?: string;
  emit?: (data: LooseRecord, error?: unknown) => void;
  wait?: boolean;
};

const SUPPORTED_FRAMEWORKS = new Set(["react", "preact", "vanilla"]);
const SUPPORTED_TEMPLATES = new Set(["blank", "todo", "guestbook", "photo-library", "campfire"]);
const DEV_SESSION_FILE = path.join(".sporades", "dev-session.json");
const DEV_DATABASE_ENV_FILE = path.join(".sporades", "dev-database-env.json");
const DEV_INSPECTION_TOKEN_HEADER = "x-sporades-inspection-token";
const CONTAINER_BINDING_FILE = path.join(".sporades", "binding.json");
const REMOTE_BINDING_FILE = path.join(".sporades", "remote-binding.json");
const DEV_REBUILD_DEBOUNCE_MS = 100;
const DEFAULT_HOST_SCHEME = "https";
const DEFAULT_HOST_REMOTE_ROOT = "/srv/sporades";
const DEFAULT_HOST_TLS_MODE = "automatic";
const HOST_TLS_MODES = new Set(["automatic", "cloudflare-origin"]);
const RESERVED_CAPSULE_SUBNAMES = new Set(["www", "api", "admin", "root", "host"]);
const MAX_HOST_LOG_LINES = 10000;
const HOST_LOG_SOURCES = new Set(["http", "stdout", "stderr"]);
const HOST_HEALTH_PATH = "/__sporades/health";
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
        ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
      },
    },
    true,
  );
});

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    await printVersion(parseVersionArgs(rawArgs));
    return;
  }

  const [command = '-h', ...args] = rawArgs;
  const isHelp = args.includes('-h') || args.includes('--help');

  switch (command) {
    case "--help":
    case "-h":
      printHelp();
      return;

    case "create": {
      if (isHelp) {
        printHelp('create');
        return;
      }
      const options = parseCreateArgs(args);
      await createProject(options);

      writeResult({
        ok: true,
        data: { path: options.projectDir, template: options.template },
        error: null,
      });
      return;
    }

    case "dev":
      if (isHelp) {
        printHelp('dev');
        return;
      }
      await manageLocalLifecycle("dev", parseDevArgs(args));
      return;

    case "auth":
      if (isHelp) {
        printHelp('auth');
        return;
      }
      await manageAuth(parseAuthArgs(args));
      return;

    case "security":
      if (isHelp) {
        printHelp('security');
        return;
      }
      await inspectSecurity(parseSecurityArgs(args));
      return;

    case "doctor":
      if (isHelp) {
        printHelp('doctor');
        return;
      }
      await runDoctor(parseDoctorArgs(args));
      return;

    case "env":
      if (isHelp) {
        printHelp('env');
        return;
      }
      await manageEnv(parseEnvArgs(args));
      return;

    case "deploy":
      if (isHelp) {
        printHelp('deploy');
        return;
      }
      await manageLocalLifecycle("deploy", parseDeployArgs(args));
      return;

    case "jobs":
      if (args.length) throw commandError("Unknown jobs argument.", "Use `sporades jobs`.");
      await inspectDevJobs({ projectDir: process.cwd() });
      return;

    case "schedules":
      if (args.length) throw commandError("Unknown schedules argument.", "Use `sporades schedules`.");
      await inspectDevSchedules({ projectDir: process.cwd() });
      return;

    case "host":
      if (isHelp) {
        printHelp('host');
        return;
      }
      await manageHost(parseHostArgs(args));
      return;

    case "logs":
      if (isHelp) {
        printHelp('logs');
        return;
      }
      await printLogs(parseLogsArgs(args));
      return;

    case "db":
      if (isHelp) {
        printHelp('db');
        return;
      }
      await inspectDatabase(parseDbArgs(args));
      return;

    default:
      throw commandError(`Unknown command: ${command ?? ""}`.trim(), "Use `sporades create <name>`.");
  }
}

function printHelp(cmd?: string) {
  process.stdout.write(renderCliHelp(cmd));
}

function parseVersionArgs(args: string[]) {
  let hostAlias = null;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--version" || arg === "-v") {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--host") {
      hostAlias = readFlagValue(args, ++index, "--host");
      continue;
    }
    throw commandError("Unknown version argument.", "Use `sporades --version` or `sporades --version --host <alias>`.");
  }

  if (hostAlias) {
    validateHostAlias(hostAlias);
  }

  return { hostAlias, json, projectDir: process.cwd() };
}

async function printVersion(options: LooseRecord) {
  if (!options.hostAlias) {
    if (options.json) {
      writeResult({ ok: true, data: { version: CLI_VERSION, source: "cli" }, error: null });
    } else {
      process.stdout.write(`${CLI_VERSION}\n`);
    }
    return;
  }

  const config = await readHostConfig();
  const resolved = resolveHostProfile(config, options.hostAlias);
  const result = invokeRemoteHostHelper({
    alias: resolved.alias,
    profile: resolved.profile,
    action: "host.version",
    projectDir: options.projectDir,
  });

  if (options.json) {
    writeResult(result, !result.ok);
    return;
  }

  if (!result.ok) {
    throw commandError(result.error.message, result.error.hint);
  }
  process.stdout.write(`${result.data.version}\n`);
}

function parseCreateArgs(args: string[]): LooseRecord {
  let name = null;
  let framework = null;
  let template = "blank";
  let install = true;
  let git = true;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--framework":
        framework = readFlagValue(args, ++index, "--framework");
        break;

      case "--template":
        template = readFlagValue(args, ++index, "--template");
        break;

      case "--no-install":
        install = false;
        break;

      case "--no-git":
        git = false;
        break;

      case "--json":
        json = true;
        break;

      default:
        if (arg.startsWith("--")) {
          throw commandError(`Unknown flag: ${arg}`, "Use `sporades create <name> --help` for supported flags.");
        }
        if (name !== null) {
          throw commandError("Too many positional arguments.", "Use `sporades create <name>`.");
        }
        name = arg;
    }
  }

  if (!name) {
    throw commandError("Missing scaffold name.", "Use `sporades create <name>`.");
  }
  if (framework !== null && !SUPPORTED_FRAMEWORKS.has(framework)) {
    throw commandError(`Unsupported framework: ${framework}`, "Use one of: react, preact, vanilla.");
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

function parseDevArgs(args: string[]): LooseRecord {
  const lifecycleCommands = new Set(["status", "stop", "reset"]);
  const subcommand = lifecycleCommands.has(args[0]) ? args[0] : "start";
  const rest = subcommand === "start" ? args : args.slice(1);
  let port = null;
  let json = false;
  let publicDev = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--port": {
        if (subcommand !== "start") {
          throw commandError(`Unknown flag: ${arg}`, "Use `sporades dev [status|stop|reset] --json`.");
        }
        const value = Number.parseInt(readFlagValue(rest, ++index, "--port"), 10);
        if (Number.isNaN(value) || value < 0) {
          throw commandError("Invalid dev port.", "Pass --port <number>.");
        }
        port = value;
        break;
      }

      case "--json":
        json = true;
        break;

      case "--public":
        if (subcommand !== "start") {
          throw commandError(`Unknown flag: ${arg}`, "Use `sporades dev [status|stop|reset] --json`.");
        }
        publicDev = true;
        break;

      default:
        throw commandError(`Unknown flag: ${arg}`, "Use `sporades dev [status|stop|reset] --json`.");
    }
  }

  return {
    subcommand,
    port,
    json,
    publicDev,
    projectDir: process.cwd(),
  };
}

function parseDeployArgs(args: string[]): LooseRecord {
  const lifecycleCommands = new Set(["status", "stop", "restart", "remove", "reset", "ssh", "jobs", "schedules"]);
  const subcommand = lifecycleCommands.has(args[0]) ? args[0] : "start";
  const rest = subcommand === "start" ? args : args.slice(1);
  let port = null;
  let json = false;
  let force = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--port":
        if (subcommand !== "start") {
          throw commandError(`Unknown flag: ${arg}`, "Use `sporades deploy [status|stop|restart|remove|reset] --json`.");
        }
        port = readPort(readFlagValue(rest, ++index, "--port"));
        break;

      case "--json":
        json = true;
        break;

      case "--force":
        if (subcommand !== "start") {
          throw commandError(`Unknown flag: ${arg}`, "Use `sporades deploy [status|stop|restart|remove|reset] --json`.");
        }
        force = true;
        break;

      default:
        throw commandError(`Unknown flag: ${arg}`, "Use `sporades deploy [status|stop|restart|remove|reset] --json`.");
    }
  }

  return {
    subcommand,
    port,
    force,
    json,
    projectDir: process.cwd(),
  };
}

function parseSecurityArgs(args: string[]): LooseRecord {
  let session = "dev";
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--session":
        session = readFlagValue(args, ++index, "--session");
        break;

      case "--json":
        json = true;
        break;

      default:
        throw commandError(
          `Unknown flag: ${arg}`,
          "Use `sporades security --session dev|public-dev|container|hosted --json`.",
        );
    }
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

function parseDoctorArgs(args: string[]): LooseRecord {
  let session = null;
  let host = null;
  let subname = null;
  let strict = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--session":
        session = readFlagValue(args, ++index, "--session");
        break;

      case "--host":
        host = readFlagValue(args, ++index, "--host");
        break;

      case "--subname":
        subname = readFlagValue(args, ++index, "--subname");
        break;

      case "--strict":
        strict = true;
        break;

      case "--json":
        json = true;
        break;

      default:
        throw commandError(
          `Unknown flag: ${arg}`,
          "Use `sporades doctor --session dev|public-dev|container|hosted --strict --json`.",
        );
    }
  }

  if (session !== null && !DOCTOR_SESSIONS.has(session)) {
    throw commandError("Invalid doctor session.", "Use one of: dev, public-dev, container, hosted.", { session });
  }
  if ((host !== null || subname !== null) && session !== "hosted") {
    throw commandError(
      "Hosted doctor options require the hosted session.",
      "Use `sporades doctor --session hosted --host <alias> --subname <name>`.",
      { session, host, subname },
    );
  }
  return {
    session,
    host,
    subname,
    strict,
    json,
    projectDir: process.cwd(),
  };
}

function parseAuthArgs(args: string[]): LooseRecord {
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

    switch (arg) {
      case "--json":
        json = true;
        break;

      case "--client-id":
        clientId = readFlagValue(rest, ++index, "--client-id");
        break;

      case "--client-secret":
        clientSecret = readFlagValue(rest, ++index, "--client-secret");
        break;

      case "--client-json":
        clientJson = readFlagValue(rest, ++index, "--client-json");
        break;

      case "--email":
        email = readFlagValue(rest, ++index, "--email");
        break;

      case "--display-name":
        displayName = readFlagValue(rest, ++index, "--display-name");
        break;

      case "--picture":
        picture = readFlagValue(rest, ++index, "--picture");
        break;

      case "--port":
        port = readPort(readFlagValue(rest, ++index, "--port"));
        break;

      case "--client":
        client = readFlagValue(rest, ++index, "--client");
        if (!isValidAuthClientTarget(client)) {
          throw commandError("Invalid auth client target.", "Use `--client current`, `--client all`, or a client id from `sporades auth clients`.");
        }
        break;

      default:
        throw commandError(`Unknown flag: ${arg}`, "Use `sporades auth status`, `sporades auth set google`, or `sporades auth as email`.");
    }
  }

  switch (subcommand) {
    case "status":
      return { subcommand, json, projectDir: process.cwd() };

    case "clients":
      return { subcommand, json, port, projectDir: process.cwd() };

    case "as":
      if (!simulatedProvider) {
        throw commandError("Missing simulated auth provider.", "Use `sporades auth as email --email <address> --json`.");
      }
      return { subcommand, provider: simulatedProvider, email, displayName, picture, port, client, json, projectDir: process.cwd() };

    case "set":
      if (provider === "google") {
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
      break;

    default:
      break;
  }

  throw commandError(
    "Unknown auth command.",
    "Use `sporades auth status`, `sporades auth clients`, `sporades auth set google`, or `sporades auth as email`.",
  );
}

function parseEnvArgs(args: string[]): LooseRecord {
  const [subcommand, ...rest] = args;
  let json = false;
  let file = null;
  let hostAlias = null;
  let subname = null;
  let output = null;
  let sealed = false;
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--json":
        json = true;
        break;

      case "--file":
        file = readFlagValue(rest, ++index, "--file");
        break;

      case "--host":
        hostAlias = readFlagValue(rest, ++index, "--host");
        break;

      case "--subname":
        subname = readFlagValue(rest, ++index, "--subname");
        break;

      case "--output":
        output = readFlagValue(rest, ++index, "--output");
        break;

      case "--sealed":
        sealed = true;
        break;

      default:
        if (arg.startsWith("--")) {
          throw commandError(
            `Unknown flag: ${arg}`,
            "Use `sporades env init`, `sporades env import`, `sporades env status`, `sporades env export`, or `sporades env reencrypt`.",
          );
        }
        positional.push(arg);
    }
  }

  switch (subcommand) {
    case "init":
    case "import":
    case "status":
    case "export":
    case "reencrypt":
      if (positional.length > 0) {
        throw commandError("Too many positional arguments.", `Use \`sporades env ${subcommand} --json\`.`);
      }
      if (hostAlias) {
        validateHostAlias(hostAlias);
      }
      if (subname) {
        validateCapsuleSubname(subname);
      }
      return { subcommand, file, hostAlias, subname, output, sealed, json, projectDir: process.cwd() };

    default:
      throw commandError(
        `Unknown env command: ${subcommand ?? ""}`.trim(),
        "Use `sporades env init`, `sporades env import`, `sporades env status`, `sporades env export`, or `sporades env reencrypt`.",
      );
  }
}

function parseHostArgs(args: string[]): LooseRecord {
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
  let fallbackToPreviousRelease = false;
  let branch = "main";
  let file = DEFAULT_GITHUB_AUTODEPLOY_WORKFLOW;
  let dryRun = false;
  let force = false;
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--json":
        json = true;
        break;

      case "--host":
        hostAlias = readFlagValue(rest, ++index, "--host");
        break;

      case "--server":
        server = readFlagValue(rest, ++index, "--server");
        break;

      case "--domain":
        domain = readFlagValue(rest, ++index, "--domain");
        break;

      case "--remote-root":
        remoteRoot = readFlagValue(rest, ++index, "--remote-root");
        break;

      case "--tls":
        tlsMode = readFlagValue(rest, ++index, "--tls");
        break;

      case "--subname":
        subname = readFlagValue(rest, ++index, "--subname");
        break;

      case "--lines":
      case "-n":
        lines = readHostLogLineCount(readFlagValue(rest, ++index, arg));
        break;

      case "--restart":
        restart = true;
        break;

      case "--verify":
        verify = true;
        restart = true;
        break;

      case "--fallback-to-previous-release":
        fallbackToPreviousRelease = true;
        break;

      case "--branch":
        branch = readFlagValue(rest, ++index, "--branch");
        break;

      case "--file":
        file = readFlagValue(rest, ++index, "--file");
        break;

      case "--dry-run":
        dryRun = true;
        break;

      case "--force":
        force = true;
        break;

      default:
        if (arg.startsWith("--")) {
          throw commandError(
            `Unknown flag: ${arg}`,
            "Use `sporades host add`, `sporades host use`, `sporades host current`, `sporades host health`, `sporades host bind`, `sporades host register`, `sporades host rotate-key`, `sporades host unregister`, `sporades host delete`, `sporades host push`, `sporades host bootstrap`, `sporades host upgrade`, `sporades host list`, `sporades host releases`, `sporades host rollback`, `sporades host stats`, `sporades host logs`, or `sporades host invoke`.",
          );
        }
        positional.push(arg);
    }
  }

  switch (subcommand) {
    case "add": {
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

    case "use": {
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

    case "current":
      if (positional.length > 0) {
        throw commandError("Too many positional arguments.", "Use `sporades host current --host <alias> --json`.");
      }
      if (hostAlias) {
        validateHostAlias(hostAlias);
      }
      return { subcommand, hostAlias, json, projectDir: process.cwd() };

    case "health": {
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

    case "bind": {
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

    case "register": {
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

    case "rotate-key": {
      const [positionalSubname, ...extra] = positional;
      if (!positionalSubname) {
        throw commandError("Missing Capsule subname.", "Use `sporades host rotate-key <subname> --host <alias>`.");
      }
      if (extra.length > 0) {
        throw commandError("Too many positional arguments.", "Use `sporades host rotate-key <subname> --host <alias>`.");
      }
      if (hostAlias) {
        validateHostAlias(hostAlias);
      }
      validateCapsuleSubname(positionalSubname);
      return { subcommand, subname: positionalSubname, hostAlias, json, projectDir: process.cwd() };
    }

    case "bootstrap":
      if (positional.length > 0) {
        throw commandError("Too many positional arguments.", "Use `sporades host bootstrap --host <alias> --json`.");
      }
      if (hostAlias) {
        validateHostAlias(hostAlias);
      }
      return { subcommand, hostAlias, json, projectDir: process.cwd() };

    case "upgrade":
      if (positional.length > 0) {
        throw commandError("Too many positional arguments.", "Use `sporades host upgrade --host <alias> --json`.");
      }
      if (hostAlias) {
        validateHostAlias(hostAlias);
      }
      return { subcommand, hostAlias, json, projectDir: process.cwd() };

    case "list":
      if (positional.length > 0) {
        throw commandError("Too many positional arguments.", "Use `sporades host list --host <alias> --json`.");
      }
      if (hostAlias) {
        validateHostAlias(hostAlias);
      }
      return { subcommand, hostAlias, json, projectDir: process.cwd() };

    case "stats": {
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

    case "jobs":
      if (positional.length > 0) throw commandError("Too many positional arguments.", "Use `sporades host jobs --host <alias> --subname <name>`.");
      if (!hostAlias) throw commandError("Missing Host profile alias.", "Pass `--host <alias>`.");
      if (!subname) throw commandError("Missing Capsule subname.", "Pass `--subname <name>`.");
      validateHostAlias(hostAlias); validateCapsuleSubname(subname);
      return { subcommand, subname, hostAlias, json: true, projectDir: process.cwd() };

    case "schedules":
      if (positional.length > 0) throw commandError("Too many positional arguments.", "Use `sporades host schedules --host <alias> --subname <name>`.");
      if (!hostAlias) throw commandError("Missing Host profile alias.", "Pass `--host <alias>`.");
      if (!subname) throw commandError("Missing Capsule subname.", "Pass `--subname <name>`.");
      validateHostAlias(hostAlias); validateCapsuleSubname(subname);
      return { subcommand, subname, hostAlias, json: true, projectDir: process.cwd() };

    case "ssh": {
      const [positionalSubname, ...extra] = positional;
      if (extra.length > 0) {
        throw commandError("Too many positional arguments.", "Use `sporades host ssh [subname] --host <alias> --json`.");
      }
      if (hostAlias) {
        validateHostAlias(hostAlias);
      }
      const selectedSubname = positionalSubname ?? subname ?? null;
      if (selectedSubname) {
        validateCapsuleSubname(selectedSubname);
      }
      return { subcommand, subname: selectedSubname, hostAlias, json, projectDir: process.cwd() };
    }

    case "start":
    case "stop":
    case "restart":
    case "unregister":
    case "delete": {
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

    case "releases": {
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

    case "rollback": {
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

    case "push":
      if (positional.length > 0) {
        throw commandError("Too many positional arguments.", "Use `sporades host push --host <alias> --subname <capsule-subname> --json`.");
      }
      if (hostAlias) {
        validateHostAlias(hostAlias);
      }
      if (subname) {
        validateCapsuleSubname(subname);
      }
      if (fallbackToPreviousRelease && !verify) {
        throw commandError(
          "Release fallback requires verification.",
          "Use `sporades host push --verify --fallback-to-previous-release`.",
        );
      }
      return { subcommand, hostAlias, subname, restart, verify, fallbackToPreviousRelease, json, projectDir: process.cwd() };

    case "github": {
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

    case "logs": {
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

    case "invoke": {
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

    default:
      throw commandError(
        `Unknown host command: ${subcommand ?? ""}`.trim(),
        "Use `sporades host add`, `sporades host use`, `sporades host current`, `sporades host health`, `sporades host bind`, `sporades host register`, `sporades host rotate-key`, `sporades host unregister`, `sporades host delete`, `sporades host push`, `sporades host bootstrap`, `sporades host upgrade`, `sporades host list`, `sporades host releases`, `sporades host rollback`, `sporades host stats`, `sporades host logs`, or `sporades host invoke`.",
      );
  }
}

function readProviderClientCredentials(provider: string, clientJsonPath: string, projectDir: string) {
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

function parseLogsArgs(args: string[]): LooseRecord {
  let json = false;
  let port = null;
  let subcommand = "recent";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "tail":
        subcommand = "tail";
        break;

      case "--port":
        port = readPort(readFlagValue(args, ++index, "--port"));
        break;

      case "--json":
        json = true;
        break;

      default:
        throw commandError(`Unknown flag: ${arg}`, "Use `sporades logs [tail] --json`.");
    }
  }

  return {
    subcommand,
    json,
    port,
    projectDir: process.cwd(),
  };
}

function parseDbArgs(args: string[]): LooseRecord {
  const [subcommand, ...rest] = args;
  let json = false;
  let port = null;
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--port":
        port = readPort(readFlagValue(rest, ++index, "--port"));
        break;

      case "--json":
        json = true;
        break;

      default:
        positional.push(arg);
    }
  }

  switch (subcommand) {
    case "list":
    case "dump":
      if (positional.length > 0) {
        throw commandError("Too many positional arguments.", `Use \`sporades db ${subcommand} --json\`.`);
      }
      return { subcommand, json, port, projectDir: process.cwd() };

    case "query":
      if (positional.length === 0) {
        throw commandError("Missing SQL query.", "Use `sporades db query <sql>`.");
      }
      return { subcommand, sql: positional.join(" "), json, port, projectDir: process.cwd() };

    default:
      throw commandError(
        `Unknown db command: ${subcommand ?? ""}`.trim(),
        "Use `sporades db list`, `sporades db dump`, or `sporades db query <sql>`.",
      );
  }
}

function readPort(value: string) {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port <= 0) {
    throw commandError("Invalid port.", "Pass --port <number>.");
  }
  return port;
}

function readHostLogLineCount(value: string) {
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

function validateHostLogSource(source: string) {
  if (!HOST_LOG_SOURCES.has(source)) {
    throw commandError(
      "Invalid Host log source.",
      "Use `sporades host logs [http|stdout|stderr] --host <alias> --subname <capsule-subname> -n <lines>`.",
    );
  }
}

function readFlagValue(args: string[], index: number, flag: string) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw commandError(`Missing value for ${flag}.`, `Pass ${flag} <value>.`);
  }
  return value;
}

function isValidAuthClientTarget(value: string) {
  return value === "current" || value === "all" || /^client-[a-z0-9]+$/.test(value);
}

async function createProject(options: LooseRecord) {
  await mkdir(options.projectDir, { recursive: false });

  const files = scaffoldFiles({
    ...options,
    sporadesDependency: defaultSporadesDependency(),
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

async function runDoctor(options: LooseRecord) {
  const envelope = createDoctorEnvelope(options, await runDoctorChecks(options));
  const failed = doctorShouldExitNonZero(envelope.data.checks, options.strict);

  if (options.json) {
    writeResult(envelope, failed);
    return;
  }

  process.stdout.write(renderDoctorHumanOutput(envelope.data));
  if (failed) {
    process.exitCode = 1;
  }
}

function defaultSporadesDependency() {
  const packageJsonPath = path.join(CLI_ROOT, "package.json");
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof packageJson.version === "string" && packageJson.version.trim()) {
      return `^${packageJson.version}`;
    }
  } catch {
    // Fall back to the package name when running from an unusual install layout.
  }
  return "sporades";
}

async function manageLocalLifecycle(surface: string, options: LooseRecord) {
  const mutating = surface === "deploy" && !["status", "ssh", "jobs", "schedules"].includes(options.subcommand);
  const release = mutating ? await acquireContainerLifecycleLock(options.projectDir) : null;
  try {
    return await manageLocalLifecycleUnlocked(surface, options);
  } finally {
    await release?.();
  }
}

async function manageLocalLifecycleUnlocked(surface: string, options: LooseRecord) {
  switch (options.subcommand) {
    case "status":
      await printLocalCapsuleServiceStatus(options, surface);
      return;

    case "stop":
      if (surface === "deploy") {
        const container = await stopLocalContainerSession(options);
        const services = await stopLocalCapsuleServices({ ...options, silent: true });
        if (options.json) {
          writeResult({ ok: true, data: { container, services }, error: null });
        } else {
          process.stdout.write("Local Container session stopped.\n");
        }
        return;
      }
      await stopLocalCapsuleServices(options);
      return;

    case "restart":
      if (surface !== "deploy") {
        throw commandError("Unsupported lifecycle command: restart", "Use `sporades deploy restart`.");
      }
      await restartLocalContainerSession(options);
      return;

    case "ssh":
      if (surface !== "deploy") {
        throw commandError("Unsupported lifecycle command: ssh", "Use `sporades deploy ssh`.");
      }
      await inspectLocalContainerSsh(options);
      return;

    case "jobs":
      if (surface !== "deploy") throw commandError("Unsupported lifecycle command: jobs", "Use `sporades deploy jobs`.");
      await inspectContainerJobs(options);
      return;

    case "schedules":
      if (surface !== "deploy") throw commandError("Unsupported lifecycle command: schedules", "Use `sporades deploy schedules`.");
      await inspectContainerSchedules(options);
      return;

    case "remove":
      if (surface !== "deploy") {
        throw commandError("Unsupported lifecycle command: remove", "Use `sporades deploy remove`.");
      }
      await removeLocalContainerSession(options);
      return;

    case "reset": {
      let container = null;
      if (surface === "deploy") {
        container = await removeLocalContainerSession({ ...options, silent: true, missingOk: true, stopServices: false });
      }
      const services = await resetLocalCapsuleServices({ ...options, silent: true });
      if (options.json) {
        writeResult({ ok: true, data: { ...(container ? { container } : {}), services }, error: null });
      } else {
        process.stdout.write(surface === "deploy" ? "Local Container session and Capsule service state reset.\n" : "Capsule service state reset.\n");
      }
      return;
    }

    default:
      if (surface === "dev") {
        await startDevSession(options);
        return;
      }
      await startContainerSession(options);
  }
}

function parseInspectionProcess(result: SpawnSyncReturns<string>, hint: string) {
  let envelope;
  try { envelope = JSON.parse(result.stdout.trim()); }
  catch { throw commandError("Runtime inspection returned invalid JSON.", hint); }
  if (!envelope?.ok) throw commandError(envelope?.error?.message ?? "Runtime inspection failed.", envelope?.error?.hint ?? hint, envelope?.error);
  writeResult(envelope);
}

async function inspectDevJobs(options: LooseRecord) {
  const session = await readDevSession(options.projectDir);
  try { process.kill(Number(session.pid), 0); }
  catch { throw commandError("No running Sporades dev session found.", "Start one with `sporades dev` from this project, then retry `sporades jobs`."); }
  const serviceEnv = await readActiveDevDatabaseServiceEnv(options.projectDir);
  const bundle = path.join(options.projectDir, ".sporades", "build", "server.mjs");
  const result = spawnSync(process.execPath, [bundle, "--sporades-action", "jobs.inspect"], {
    cwd: options.projectDir, encoding: "utf8",
    env: { ...process.env, ...serviceEnv, SPORADES_DATABASE_PATH: path.join(options.projectDir, ".sporades", "data.db") },
  });
  parseInspectionProcess(result, "Restart `sporades dev` to refresh the generated Bundle, then retry `sporades jobs`.");
}

async function inspectDevSchedules(options: LooseRecord) {
  const session = await readDevSession(options.projectDir);
  try { process.kill(Number(session.pid), 0); }
  catch { throw commandError("No running Sporades dev session found.", "Start one with `sporades dev` from this project, then retry `sporades schedules`."); }
  const serviceEnv = await readActiveDevDatabaseServiceEnv(options.projectDir, "schedules");
  const bundle = path.join(options.projectDir, ".sporades", "build", "server.mjs");
  const result = spawnSync(process.execPath, [bundle, "--sporades-action", "schedules.inspect"], {
    cwd: options.projectDir, encoding: "utf8",
    env: { ...process.env, ...serviceEnv, SPORADES_DATABASE_PATH: path.join(options.projectDir, ".sporades", "data.db") },
  });
  parseInspectionProcess(result, "Restart `sporades dev` to refresh the generated Bundle, then retry `sporades schedules`.");
}

async function readActiveDevDatabaseServiceEnv(projectDir: string, command = "jobs") {
  try { return JSON.parse(await readFile(path.join(projectDir, DEV_DATABASE_ENV_FILE), "utf8")); }
  catch (error) { if (errorDetails(error).code !== "ENOENT") throw commandError("Invalid active Dev database adapter metadata.", `Restart \`sporades dev\`, then retry \`sporades ${command}\`.`); }
  const config = await readProjectConfig(projectDir);
  const capsuleServices = localCapsuleServicesFromConfig(config, projectDir);
  const database = capsuleServices?.services?.database;
  if (!database) return {};
  const connection = await waitForCapsuleService(capsuleServices, projectDir, "database", database, "local");
  return capsuleServicesLocalEnv({ ...capsuleServices, services: { database } }, { database: connection });
}

async function writeActiveDevDatabaseServiceEnv(projectDir: string, serviceEnv: LooseRecord) {
  const databaseEnv = Object.fromEntries(Object.entries(serviceEnv).filter(([key, value]) => key.startsWith("SPORADES_SERVICE_DATABASE_") && typeof value === "string"));
  const filePath = path.join(projectDir, DEV_DATABASE_ENV_FILE);
  await mkdir(path.dirname(filePath), { recursive: true });
  const previous = await readFile(filePath).catch((error) => {
    if (errorDetails(error).code === "ENOENT") return null;
    throw error;
  });
  await replaceFileAtomically(filePath, `${JSON.stringify(databaseEnv)}\n`);
  return async () => {
    if (previous === null) await rm(filePath, { force: true });
    else await replaceFileAtomically(filePath, previous);
  };
}

async function replaceFileAtomically(filePath: string, contents: string | Uint8Array) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function inspectContainerJobs(options: LooseRecord) {
  const { binding } = await requireLocalContainerBinding(options, "jobs");
  const running = runDocker(["inspect", "--format", "{{.State.Running}}", binding.containerId], options.projectDir,
    "Unable to inspect the local Container session.", "Check Docker and retry `sporades deploy jobs`.");
  if (running !== "true") throw commandError("The local Container session is not running.", "Run `sporades deploy restart`, then retry `sporades deploy jobs`.");
  const result = spawnSync("docker", ["exec", binding.containerId, "node", "/app/server.mjs", "--sporades-action", "jobs.inspect"], { cwd: options.projectDir, encoding: "utf8" });
  parseInspectionProcess(result, "Redeploy the Capsule with the current Sporades CLI, then retry `sporades deploy jobs`.");
}

async function inspectContainerSchedules(options: LooseRecord) {
  const { binding } = await requireLocalContainerBinding(options, "schedules");
  const running = runDocker(["inspect", "--format", "{{.State.Running}}", binding.containerId], options.projectDir,
    "Unable to inspect the local Container session.", "Check Docker and retry `sporades deploy schedules`.");
  if (running !== "true") throw commandError("The local Container session is not running.", "Run `sporades deploy restart`, then retry `sporades deploy schedules`.");
  const result = spawnSync("docker", ["exec", binding.containerId, "node", "/app/server.mjs", "--sporades-action", "schedules.inspect"], { cwd: options.projectDir, encoding: "utf8" });
  let envelope;
  try { envelope = JSON.parse(result.stdout.trim()); }
  catch { throw commandError("Runtime inspection returned invalid JSON.", "Redeploy the Capsule with the current Sporades CLI, then retry `sporades deploy schedules`."); }
  const bounded = sanitizeScheduleInspectionEnvelope(envelope, () => {
    throw commandError("Runtime Schedule inspection returned an invalid response.", "Redeploy the Capsule with the current Sporades CLI, then retry `sporades deploy schedules`.");
  });
  if (!bounded.ok) throw commandError(bounded.error.message, bounded.error.hint, bounded.error.diagnostics);
  writeResult(bounded);
}

async function startDevSession(options: LooseRecord) {
  let config = await readProjectConfig(options.projectDir);
  const session = options.publicDev ? "public-dev" : "dev";
  let security = resolveEffectiveSecurityPolicy(config, session);
  const restartPolicy = restartPolicyForMode("dev");
  const port = options.port ?? config.dev?.port ?? config.deploy?.port ?? 4000;
  let bundle = await createBundle(options.projectDir, config);
  const capsuleServices = await writeCapsuleServicesCompose(options.projectDir, config, { publishPorts: true });
  const capsuleServiceEnv = await startCapsuleServices(capsuleServices, options.projectDir, {
    wait: true,
    emit: (data, error) => emitDevEvent(options, data, error),
  });
  let runtimeServiceEnv = capsuleServiceEnv;
  const inspectionToken = createDevInspectionToken();

  const sessionFilePath = path.join(options.projectDir, DEV_SESSION_FILE);
  const databasePath = path.join(options.projectDir, ".sporades", "data.db");
  const runtime: any = await createDevRuntime({
    databasePath,
    serverSource: bundle.serverRuntime.source,
    serverEnv: bundle.serverRuntime.env,
    serviceEnv: capsuleServiceEnv,
    capsuleModuleSource: bundle.serverRuntime.capsuleModuleSource,
    config: withRuntimeSecuritySession(config, session),
  });
  await writeActiveDevDatabaseServiceEnv(options.projectDir, runtimeServiceEnv);
  runtime.database.log.emit({
    category: "platform",
    event: "dev.session.started",
    level: "info",
    message: "Dev session started",
    data: { diagnostics: runtime.database.runtimeDiagnostics },
  });
  const websocketHub = createWebSocketHub(() => runtime.database);

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

      if (prepareHttpSecurity(runtime.database, request, response)) {
        return;
      }

      switch (`${request.method}:${requestUrl.pathname}`) {
        case "POST:/__sporades/debug/ctx-log":
          if (!requireDevInspectionToken(request, response, inspectionToken)) {
            return;
          }
          runtime.database.log.emit({
            category: "app",
            event: "ctx.log",
            level: "info",
            message: "ctx.log is available",
          });
          writeJsonResponse(response, 200, {
            ok: true,
            data: { log: ["info", "warn", "error"] },
            error: null,
          });
          return;

        case "POST:/__sporades/debug/privileged-audit":
          if (!requireDevInspectionToken(request, response, inspectionToken)) {
            return;
          }
          if (process.env.SPORADES_TEST_ENABLE_PRIVILEGED_AUDIT_DEBUG !== "1") {
            writeJsonResponse(response, 404, {
              ok: false,
              data: null,
              error: { message: "Not found." },
            });
            return;
          }
          {
            const input = await readJsonRequest(request, runtime.database);
            const event = await runtime.database.audit.emit(input);
            writeJsonResponse(response, 200, {
              ok: true,
              data: { event },
              error: null,
            });
          }
          return;

        case "GET:/__sporades/debug/logs":
          if (!requireDevInspectionToken(request, response, inspectionToken)) {
            return;
          }
          writeJsonResponse(response, 200, {
            ok: true,
            data: { source: "sqlite", entries: await runtime.database.log.recent() },
            error: null,
          });
          return;

        case "GET:/__sporades/debug/logs/tail":
          if (!requireDevInspectionToken(request, response, inspectionToken)) {
            return;
          }
          writeJsonResponse(response, 200, {
            ok: true,
            data: { source: "jsonl", entries: runtime.database.log.tail() },
            error: null,
          });
          return;

        case "GET:/__sporades/debug/db/list":
          if (!requireDevInspectionToken(request, response, inspectionToken)) {
            return;
          }
          writeJsonResponse(response, 200, {
            ok: true,
            data: { tables: await listDatabaseTables(runtime.database) },
            error: null,
          });
          return;

        case "GET:/__sporades/debug/db/dump":
          if (!requireDevInspectionToken(request, response, inspectionToken)) {
            return;
          }
          writeJsonResponse(response, 200, {
            ok: true,
            data: { tables: await dumpDatabase(runtime.database) },
            error: null,
          });
          return;

        case "POST:/__sporades/debug/db/query": {
          if (!requireDevInspectionToken(request, response, inspectionToken)) {
            return;
          }
          const body = await readJsonRequest(request, runtime.database);
          writeJsonResponse(response, 200, await runReadOnlyQuery(runtime.database, body.sql));
          return;
        }

        case "POST:/__sporades/debug/auth/as": {
          if (!requireDevInspectionToken(request, response, inspectionToken)) {
            return;
          }
          const body = await readJsonRequest(request, runtime.database);
          const result: LooseRecord = await simulateLocalIdentitySession(runtime.database, body);
          if (result.ok && body.client && result.data) {
            result.data.delivery = websocketHub.deliverAuthSession(body.client, result.data);
          }
          writeJsonResponse(response, result.ok ? 200 : 400, result);
          return;
        }

        case "GET:/__sporades/debug/auth/clients":
          if (!requireDevInspectionToken(request, response, inspectionToken)) {
            return;
          }
          writeJsonResponse(response, 200, {
            ok: true,
            data: { clients: websocketHub.listAuthClients() },
            error: null,
          });
          return;
      }

      if (
        (await routeSporadesAuth(runtime.database, request, response))
        || (await handleFileHttpRoute(runtime.database, request, response, websocketHub as any))
        || (await routeEndpoint(runtime.database, request, response))
      ) {
        return;
      }

      const rawPublicPathname = (request.url ?? "/").split("?", 1)[0];
      const publicAsset = await readPublicAsset(bundle.staticFiles.publicTree, rawPublicPathname);
      if (publicAsset) {
        response.writeHead(200, { "content-type": publicAsset.contentType });
        response.end(publicAsset.html
          ? injectPageConnectionToken(publicAsset.body.toString("utf8"), websocketHub.createConnectionToken())
          : publicAsset.body);
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      writeUnhandledHttpError(runtime.database, request, response, error);
    }
  });
  server.on("upgrade", (request, socket) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/__sporades/ws") {
      socket.destroy();
      return;
    }
    websocketHub.accept(request, socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
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
        session,
        inspectionToken,
        publicDev: security.cors.publicDev,
        security,
      },
      null,
      2,
    )}\n`,
  );
  let fatalRestartAttempts = 0;
  let fatalRestartInFlight = false;
  const restartAfterFatal = async (fatalEvent: string, error: Error) => {
    if (fatalRestartInFlight) {
      return;
    }
    fatalRestartInFlight = true;
    fatalRestartAttempts += 1;
    const attempt = fatalRestartAttempts;
    const errorData = {
      fatalEvent,
      attempt,
      maxAttempts: restartPolicy.maxAttempts,
      message: error?.message ?? String(error),
    };
    runtime.database.log.emit({
      category: "platform",
      event: "runtime.fatal",
      level: "error",
      message: "Dev runtime fatal event detected",
      data: errorData,
    });
    emitDevEvent(options, {
      event: "fatal",
      status: "detected",
      url,
      port: actualPort,
      restartPolicy: restartPolicyStatus("dev"),
      fatal: errorData,
    });
    if (attempt > restartPolicy.maxAttempts) {
      runtime.database.log.emit({
        category: "platform",
        event: "runtime.restart.exhausted",
        level: "error",
        message: "Dev runtime restart attempts exhausted",
        data: errorData,
      });
      emitDevEvent(
        options,
        {
          event: "restart",
          status: "exhausted",
          url,
          port: actualPort,
          restartPolicy: restartPolicyStatus("dev"),
          fatal: errorData,
        },
        {
          message: "Dev runtime restart attempts exhausted.",
          hint: "Restart `sporades dev` after fixing the fatal runtime error.",
        },
      );
      fatalRestartInFlight = false;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, restartPolicy.backoffMs * attempt));
    try {
      await runtime.restart(
        bundle.serverRuntime.source,
        bundle.serverRuntime.env,
        runtimeServiceEnv,
        bundle.serverRuntime.capsuleModuleSource,
        withRuntimeSecuritySession(config, session),
      );
      websocketHub.disconnectAll();
      runtime.database.log.emit({
        category: "platform",
        event: "runtime.restart.attempted",
        level: "info",
        message: "Dev runtime restarted after fatal event",
        data: { ...errorData, restarted: true },
      });
      emitDevEvent(options, {
        event: "restart",
        status: "success",
        url,
        port: actualPort,
        restartPolicy: restartPolicyStatus("dev"),
        fatal: errorData,
      });
    } catch (restartError) {
      const details = errorDetails(restartError);
      runtime.database.log.emit({
        category: "platform",
        event: "runtime.restart.failed",
        level: "error",
        message: "Dev runtime restart failed",
        data: { ...errorData, restartError: details.message },
      });
      emitDevEvent(
        options,
        {
          event: "restart",
          status: "failed",
          url,
          port: actualPort,
          restartPolicy: restartPolicyStatus("dev"),
          fatal: errorData,
        },
        {
          message: details.message,
          hint: details.hint ?? "Fix the fatal runtime error and save again.",
        },
      );
    } finally {
      fatalRestartInFlight = false;
    }
  };
  const onUnhandledRejection = (reason: any) => {
    restartAfterFatal("unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)));
  };
  const onUncaughtException = (error: any) => {
    restartAfterFatal("uncaughtException", error);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  const watchers = watchDevInputs(options.projectDir, async (change: { affectsServerRuntime: boolean; configChanged: any; }) => {
    let rebuild: Awaited<ReturnType<typeof createBundle>> | null = null;
    let rollbackLegacy: (() => Promise<void>) | null = null;
    let rollbackServiceEnv: (() => Promise<void>) | null = null;
    try {
      const nextConfig = await readProjectConfig(options.projectDir);
      const nextSecurity = resolveEffectiveSecurityPolicy(nextConfig, session);
      const nextCapsuleServices = await writeCapsuleServicesCompose(options.projectDir, nextConfig, { publishPorts: true });
      rebuild = await createBundle(options.projectDir, nextConfig, { publishLegacy: false });
      const nextCapsuleServiceEnv = await startCapsuleServices(nextCapsuleServices, options.projectDir, {
        wait: true,
        emit: (data, error) => emitDevEvent(options, data, error),
      }).catch((error) => { throw tagDevRebuildError(error, "services", nextConfig); });
      const affectsServerRuntime =
        change.affectsServerRuntime || (change.configChanged && configChangeAffectsServerRuntime(config, nextConfig));
      if (affectsServerRuntime) {
        rollbackServiceEnv = await writeActiveDevDatabaseServiceEnv(options.projectDir, nextCapsuleServiceEnv)
          .catch((error) => { throw tagDevRebuildError(error, "runtime", nextConfig); });
      }
      rollbackLegacy = await rebuild.publishLegacy();
      if (affectsServerRuntime) {
        await runtime.restart(
          rebuild.serverRuntime.source,
          rebuild.serverRuntime.env,
          nextCapsuleServiceEnv,
          rebuild.serverRuntime.capsuleModuleSource,
          withRuntimeSecuritySession(nextConfig, session),
        ).catch((error: unknown) => { throw tagDevRebuildError(error, "runtime", nextConfig, { preserveSchemaErrors: true }); });
        runtimeServiceEnv = nextCapsuleServiceEnv;
        fatalRestartAttempts = 0;
        websocketHub.disconnectAll();
      }
      const previousBundle = bundle;
      bundle = rebuild;
      rebuild.releasePublicTreeLease().catch((error) => {
        reportDevPublicCleanupDegradation(options, runtime, url, actualPort, nextConfig, error);
      });
      discardPublicTree(previousBundle.staticFiles.publicTree).catch((error) => {
        reportDevPublicCleanupDegradation(options, runtime, url, actualPort, nextConfig, error);
      });
      config = nextConfig;
      security = nextSecurity;
      emitDevEvent(options, {
        event: "rebuild",
        status: "success",
        url,
        port: actualPort,
        security,
        build: {
          phase: affectsServerRuntime ? "bundle" : "client",
          framework: nextConfig.client?.framework ?? "react",
          toolchain: "esbuild",
        },
      });
    } catch (error) {
      let rebuildError = error;
      if (rollbackLegacy) {
        try {
          await rollbackLegacy();
        } catch (rollbackError) {
          rebuildError = tagDevRebuildError(rollbackError, "publish", config);
        }
      }
      if (rollbackServiceEnv) {
        try {
          await rollbackServiceEnv();
        } catch (rollbackError) {
          rebuildError = tagDevRebuildError(rollbackError, "runtime", config);
        }
      }
      if (rebuild && rebuild !== bundle) {
        if (errorDetails(rebuildError).diagnostics?.candidateDiscard === "forbidden") {
          await rebuild.releasePublicTreeLease().catch((cleanupError) => {
            reportDevPublicCleanupDegradation(options, runtime, url, actualPort, config, cleanupError);
          });
        } else {
          await discardPublicTree(rebuild.staticFiles.publicTree).catch((cleanupError) => {
            reportDevPublicCleanupDegradation(options, runtime, url, actualPort, config, cleanupError);
          });
        }
      }
      const details = errorDetails(rebuildError);
      runtime.database.log.emit({
        category: "platform",
        event: "dev.rebuild.failed",
        level: "error",
        message: "Dev rebuild failed",
        data: { message: details.message },
      });
      emitDevEvent(
        options,
        {
          event: "rebuild",
          status: "failed",
          url,
          port: actualPort,
          ...(typeof details.phase === "string" ? {
            build: {
              phase: details.phase,
              framework: typeof details.framework === "string" ? details.framework : config.client?.framework ?? "react",
              toolchain: typeof details.toolchain === "string" ? details.toolchain : "esbuild",
            },
          } : {}),
        },
        {
          message: details.message,
          hint: details.hint ?? "Fix the build error and save again.",
          ...(details.diagnostics ? { diagnostics: details.diagnostics } : {}),
        },
      );
    }
  });
  emitDevEvent(options, { event: "started", url, port: actualPort, security, restartPolicy: restartPolicyStatus("dev") });

  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    for (const watcher of watchers) {
      watcher.close();
    }
    rm(path.join(options.projectDir, DEV_DATABASE_ENV_FILE), { force: true }).catch(() => {});
    websocketHub.disconnectAll();
    await runtime.shutdown();
    server.close(async () => {
      await rm(sessionFilePath, { force: true });
      process.off("unhandledRejection", onUnhandledRejection);
      process.off("uncaughtException", onUncaughtException);
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function tagDevRebuildError(
  error: unknown,
  phase: string,
  config: LooseRecord,
  options: { preserveSchemaErrors?: boolean } = {},
) {
  const details = errorDetails(error);
  if (options.preserveSchemaErrors && details.message === "Unsupported Capsule schema change.") {
    return error;
  }
  const tagged = (error instanceof Error
    ? error as Error & { phase?: string; framework?: string; toolchain?: string }
    : commandError(String(error), "Fix the rebuild error and save again.")) as Error & {
      phase?: string;
      framework?: string;
      toolchain?: string;
    };
  tagged.phase = phase;
  tagged.framework = config.client?.framework ?? "react";
  tagged.toolchain = "esbuild";
  return tagged;
}

function reportDevPublicCleanupDegradation(
  options: LooseRecord,
  runtime: any,
  url: string,
  port: number,
  config: LooseRecord,
  error: unknown,
) {
  runtime.database.log.emit({
    category: "platform",
    event: "dev.public-tree.cleanup.degraded",
    level: "warn",
    message: "Public tree cleanup degraded",
    data: { message: errorDetails(error).message },
  });
  emitDevEvent(
    options,
    {
      event: "cleanup",
      status: "degraded",
      url,
      port,
      build: { phase: "public", framework: config.client?.framework ?? "react", toolchain: "esbuild" },
    },
    {
      message: "Public tree cleanup degraded.",
      hint: "A later rebuild will retry bounded cleanup while preserving the active public tree.",
    },
  );
}

async function createDevRuntime(options: LooseRecord): Promise<any> {
  let database: any = await openDevDatabase(
    options.databasePath,
    options.serverSource,
    options.serverEnv,
    options.config,
    await importCapsuleDefinition(options.capsuleModuleSource),
    { serviceEnv: options.serviceEnv },
  );
  await database.init();

  return {
    get database() {
      return database;
    },
    async restart(serverSource: any, serverEnv: {}, serviceEnv: any, capsuleModuleSource: any, config: {}) {
      const nextDatabase: any = await openDevDatabase(
        options.databasePath,
        serverSource,
        serverEnv,
        config,
        await importCapsuleDefinition(capsuleModuleSource),
        { serviceEnv },
      );
      await nextDatabase.init();
      await database.shutdown();
      database.close();
      database = nextDatabase;
    },
    async shutdown() {
      await database.shutdown();
      database.close();
    },
  };
}

function createDevInspectionToken() {
  return randomBytes(32).toString("hex");
}

function requireDevInspectionToken(request: IncomingMessage, response: ServerResponse<IncomingMessage>, expectedToken: string) {
  if (devInspectionTokenMatches(request.headers[DEV_INSPECTION_TOKEN_HEADER], expectedToken)) {
    return true;
  }
  writeJsonResponse(response, 401, {
    ok: false,
    data: null,
    error: {
      message: "Dev inspection token is required.",
      hint: "Use Sporades CLI inspection commands for this Dev session.",
    },
  });
  return false;
}

function devInspectionTokenMatches(header: string | string[] | undefined, expectedToken: string) {
  const actualToken = Array.isArray(header) ? header[0] : header;
  if (typeof actualToken !== "string" || typeof expectedToken !== "string") {
    return false;
  }
  const actual = Buffer.from(actualToken);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function importCapsuleDefinition(moduleSource: WithImplicitCoercion<string>) {
  const encodedModule = Buffer.from(moduleSource, "utf8").toString("base64");
  const module = await import(`data:text/javascript;base64,${encodedModule}`);
  return module.default ?? null;
}

function watchDevInputs(projectDir: string, onChange: { (change: any): Promise<void>; (arg0: any): any; }) {
  const watchedPaths = [
    { path: path.join(projectDir, "server"), affectsServerRuntime: true },
    { path: path.join(projectDir, "client"), affectsServerRuntime: false },
    { path: path.join(projectDir, "shared"), affectsServerRuntime: true },
    { path: path.join(projectDir, "index.html"), affectsServerRuntime: false },
    { path: path.join(projectDir, "sporades.json"), affectsServerRuntime: false, configChanged: true },
  ];
  const watchers = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingChange: { affectsServerRuntime: boolean; configChanged?: boolean } | null = null;
  let rebuildInFlight = false;
  let lastHandledSignature: string | null = null;

  const schedule = (change: { path: string; affectsServerRuntime: boolean; configChanged?: undefined; } | { path: string; affectsServerRuntime: boolean; configChanged: boolean; }) => {
    pendingChange = {
      affectsServerRuntime: Boolean(pendingChange?.affectsServerRuntime || change.affectsServerRuntime),
      configChanged: Boolean(pendingChange?.configChanged || change.configChanged),
    };
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
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
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(runPendingChange, DEV_REBUILD_DEBOUNCE_MS);
      }
    }
  };

  for (const watchedPath of watchedPaths) {
    try {
      watchers.push(watch(watchedPath.path, { recursive: true }, () => schedule(watchedPath)));
    } catch (error) {
      if (errorDetails(error).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return watchers;
}

function configChangeAffectsServerRuntime(currentConfig: any, nextConfig: any) {
  return JSON.stringify(serverRuntimeConfig(currentConfig)) !== JSON.stringify(serverRuntimeConfig(nextConfig));
}

function serverRuntimeConfig(config: LooseRecord = {}) {
  const { client: _client, ...serverConfig } = config ?? {};
  return serverConfig;
}

function readDevInputSignature(watchedPaths: LooseRecord[]) {
  const entries: any[] = [];

  for (const watchedPath of watchedPaths) {
    collectPathSignature(watchedPath.path, entries);
  }

  return entries.sort().join("\n");
}

function collectPathSignature(filePath: string, entries: any[]) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
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

function emitDevEvent(options: LooseRecord, data: LooseRecord, error: any = null) {
  if (options.json) {
    writeResult({
      ok: error === null,
      data,
      error,
    });
    return;
  }

  switch (data.event) {
    case "started":
      process.stdout.write(`Sporades dev session started at ${data.url}\n`);
      return;

    case "service":
      return;

    case "fatal":
      process.stdout.write(`Sporades dev runtime fatal event: ${error?.message ?? data.fatal?.message ?? "unknown error"}\n`);
      return;

    case "restart":
      switch (data.status) {
        case "success":
          process.stdout.write(`Sporades dev runtime restarted at ${data.url}\n`);
          return;

        case "exhausted":
          process.stdout.write(`Sporades dev runtime restart attempts exhausted: ${error.message}\n`);
          return;

        default:
          process.stdout.write(`Sporades dev runtime restart failed: ${error.message}\n`);
          return;
      }

    default:
      if (data.status === "success") {
        process.stdout.write(`Sporades dev session rebuilt at ${data.url}\n`);
        return;
      }
  }

  process.stdout.write(`Sporades dev rebuild failed: ${error.message}\n`);
}

async function manageAuth(options: LooseRecord) {
  switch (options.subcommand) {
    case "status": {
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

    case "as": {
      const session = await resolveRequiredDevInspectionSession(options);
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

    case "clients": {
      const session = await resolveRequiredDevInspectionSession(options);
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

    default:
      break;
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

async function inspectSecurity(options: LooseRecord) {
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

async function manageEnv(options: LooseRecord) {
  const paths: any = sealedServerEnvPaths(options.projectDir);

  switch (options.subcommand) {
    case "init": {
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

    case "import": {
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

    case "status": {
      const envelope = await readSealedServerEnv(paths);
      const keyPair = await readKeyPair(paths);
      await writeEnvResult(options, {
        ...envelopeSummary(envelope, paths),
        privateKeyConfigured: Boolean(keyPair?.privateKey),
        legacyServerEnvFilePresent: (await readServerEnvFile(path.join(options.projectDir, ".env.sporades.server"))).exists,
      });
      return;
    }

    case "export": {
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

    case "reencrypt": {
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
      const hostKey = options.subname
        ? await readHostedCapsuleSealedEnvPublicKey(options.hostAlias, profile, options.subname, options.projectDir)
        : await ensureHostProfileEnvKey(hostConfig, options.hostAlias);
      const hostEnvelope = sealServerEnv(values, hostKey.publicKey, {
        source: options.subname ? "hosted-capsule-reencrypt" : "host-profile-reencrypt",
        hostAlias: options.hostAlias,
        hostDomain: profile.domain,
        ...(options.subname ? { subname: options.subname } : {}),
      });
      const hostEnvelopePath = path.join(
        paths.hosts,
        options.subname
          ? `${options.hostAlias}.${options.subname}.server-env.sealed.json`
          : `${options.hostAlias}.server-env.sealed.json`,
      );
      await mkdir(path.dirname(hostEnvelopePath), { recursive: true, mode: 0o700 });
      await writeFile(hostEnvelopePath, `${JSON.stringify(hostEnvelope, null, 2)}\n`, { mode: 0o600 });
      if (!options.subname) {
        await writeHostConfig(hostConfig);
      }
      await writeEnvResult(options, {
        reencrypted: true,
        hostAlias: options.hostAlias,
        hostDomain: profile.domain,
        ...(options.subname ? { subname: options.subname } : {}),
        keyCount: Object.keys(hostEnvelope.entries).length,
        publicKeyFingerprint: hostEnvelope.publicKeyFingerprint,
        envelopePath: hostEnvelopePath,
        privateKeyConfigured: !options.subname,
      });
    }
  }
}

async function readPortableSealedServerEnvEnvelope(filePath: PathLike | FileHandle) {
  let envelope;
  try {
    envelope = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
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

async function writeEnvResult(options: LooseRecord, data: LooseRecord) {
  if (options.json) {
    writeResult({ ok: true, data, error: null });
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function ensureHostProfileEnvKey(config: LooseRecord, alias: string | number) {
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

async function manageHost(options: LooseRecord) {
  switch (options.subcommand) {
    case "schedules": {
      const config = await readHostConfig();
      const resolved = resolveHostProfile(config, options.hostAlias);
      const result = invokeRemoteHostHelper({ alias: resolved.alias, profile: resolved.profile, action: "schedules.inspect", subname: options.subname, projectDir: options.projectDir });
      if (!result.ok && /Unsupported Host helper action/i.test(result.error.message)) {
        writeResult({ ok: false, data: null, error: { code: "HOST_HELPER_UPGRADE_REQUIRED", message: "The Host server CLI does not support Schedule inspection.", hint: `Run \`sporades host upgrade --host ${resolved.alias}\`, then retry the command.` } }, true);
        return;
      }
      writeResult(result, !result.ok);
      return;
    }
    case "jobs": {
      const config = await readHostConfig();
      const resolved = resolveHostProfile(config, options.hostAlias);
      const result = invokeRemoteHostHelper({ alias: resolved.alias, profile: resolved.profile, action: "jobs.inspect", subname: options.subname, projectDir: options.projectDir });
      if (!result.ok && /Unsupported Host helper action/i.test(result.error.message)) {
        writeResult({ ok: false, data: null, error: { code: "HOST_HELPER_UPGRADE_REQUIRED", message: "The Host server CLI does not support Job inspection.", hint: `Run \`sporades host upgrade --host ${resolved.alias}\`, then retry the command.` } }, true);
        return;
      }
      writeResult(result, !result.ok);
      return;
    }
    case "add": {
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

    case "use": {
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

    case "current": {
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

    case "health": {
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

    case "bind": {
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

    case "register": {
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

    case "push": {
      const config = await readHostConfig();
      const target = await resolveHostPushTarget(config, options);
      const projectConfig = await readProjectConfig(options.projectDir);
      const sshAccess = await resolveHostedCapsuleSshAccessForAudit(projectConfig, options.projectDir);
      const hostSealedServerEnv = await prepareHostPushSealedServerEnv({
        projectDir: options.projectDir,
        alias: target.alias,
        profile: target.profile,
        subname: target.subname,
      });
      const bundle = await createBundle(options.projectDir, projectConfig);
      const release = await createHostReleaseArchive({
        projectDir: options.projectDir,
        alias: target.alias,
        profile: target.profile,
        subname: target.subname,
        binding: target.binding,
        bundle,
        restart: options.restart,
        projectConfig,
        sealedServerEnv: hostSealedServerEnv,
        sshAccess,
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
        lifecycle: options.verify
          ? createHostLifecycleRequest(target.alias, target.profile, target.subname, {
            updatePolicyMode: readBaseImageUpdatePolicy(projectConfig),
          })
          : null,
        health: options.verify ? createHostRuntimeHealthRequest(target.profile, target.subname) : null,
        verification: options.verify
          ? {
            enabled: true,
            fallbackToPreviousRelease: options.fallbackToPreviousRelease,
            health: createHostRuntimeHealthRequest(target.profile, target.subname),
          }
          : null,
        projectDir: options.projectDir,
      });
      const outputResult = redactHostPushSshState(result);

      if (options.json) {
        writeResult(outputResult, !outputResult.ok);
        return;
      }

      if (!outputResult.ok) {
        throw commandError(outputResult.error.message, outputResult.error.hint);
      }
      process.stdout.write(`Hosted Capsule release pushed: ${target.binding.hostedUrl}\n`);
      if (!options.restart) {
        process.stdout.write("The Hosted Capsule was not restarted.\n");
      }
      return;
    }

    case "rotate-key": {
      const config = await readHostConfig();
      const resolved = resolveHostProfile(config, options.hostAlias);
      const result = invokeRemoteHostHelper({
        alias: resolved.alias,
        profile: resolved.profile,
        action: "capsule.sealed-env.rotate-key",
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
      const hostedUrl = result.data?.capsule?.hostedUrl ?? `${resolved.profile.scheme}://${options.subname}.${resolved.profile.domain}`;
      process.stdout.write(`Hosted Capsule sealed-env key rotated: ${hostedUrl}\n`);
      return;
    }

    case "github": {
      if (options.github?.area !== "workflow" || options.github?.action !== "write") {
        return;
      }
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

    case "start":
    case "stop":
    case "restart": {
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

    case "rollback": {
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

    case "unregister": {
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

    case "delete": {
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

    case "stats": {
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

    case "ssh": {
      const config = await readHostConfig();
      const target = await resolveHostPushTarget(config, options);
      const result = invokeRemoteHostHelper({
        alias: target.alias,
        profile: target.profile,
        action: "capsule.ssh",
        subname: target.subname,
        projectDir: options.projectDir,
      });

      if (options.json) {
        writeResult(result, !result.ok);
        return;
      }

      if (!result.ok) {
        throw commandError(result.error.message, result.error.hint);
      }
      const data = result.data;
      if (!data.enabled) {
        process.stdout.write(`Hosted Capsule SSH disabled: ${data.reason ?? "no-authorized-keys"}.\n`);
      } else if (!data.running) {
        process.stdout.write(`Hosted Capsule SSH configured, but the Capsule is not running: ${data.reason ?? "capsule-stopped"}.\n`);
      } else if (!data.port) {
        process.stdout.write("Hosted Capsule SSH configured, but port 22 is not published on the Host server loopback interface.\n");
      } else {
        process.stdout.write(`Hosted Capsule SSH enabled for ${data.user}@${data.host}:${data.port} on the Host server loopback interface (${data.keyCount} authorized key${data.keyCount === 1 ? "" : "s"}).\n`);
      }
      return;
    }

    case "invoke": {
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

    case "bootstrap": {
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
      return;
    }

    case "upgrade": {
      const config = await readHostConfig();
      const resolved = resolveHostProfile(config, options.hostAlias);
      const result = upgradeHostHelper({
        alias: resolved.alias,
        profile: resolved.profile,
        projectDir: options.projectDir,
      });

      if (options.json) {
        writeResult(result, false);
        return;
      }
      process.stdout.write(`Host helper upgraded on ${resolved.alias}: ${result.data.remoteHelper}\n`);
      return;
    }

    case "list": {
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

    case "releases": {
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

    case "logs": {
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
      return;
    }
  }
}

function redactHostPushSshState(result: HostHelperEnvelope<LooseRecord>) {
  if (!result.ok || !result.data) {
    return result;
  }
  const data = JSON.parse(JSON.stringify(result.data));
  if (data.release && typeof data.release === "object") {
    delete data.release.ssh;
    if (Array.isArray(data.release.files)) {
      data.release.files = data.release.files.filter((file: unknown) => file !== ".sporades/ssh/authorized_keys");
    }
  }
  if (data.lifecycle && typeof data.lifecycle === "object") {
    delete data.lifecycle.ssh;
    delete data.lifecycle.auditEvents;
    if (Object.keys(data.lifecycle).length === 0) {
      delete data.lifecycle;
    }
  }
  return { ...result, data };
}

async function resolveLocalContainerSshAccessForAudit(config: LooseRecord, projectDir: string, surface: string, targetResourceKind: string) {
  try {
    const sshAccess = await resolveLocalContainerSshAccess(config, projectDir);
    if (sshAccess.enabled || explicitSshConfigured(config)) {
      await emitCliSshAuditEvent(config, projectDir, {
        event: "ssh.config.validated",
        operation: "ssh.config.validate",
        surface,
        targetResourceKind,
        outcome: "completed",
        message: "SSH access configuration validated.",
        metadata: {
          enabled: sshAccess.enabled,
          keyCount: sshAccess.keyCount ?? 0,
          fingerprints: sshAccess.fingerprints ?? [],
          ...(sshAccess.enabled ? {} : { reason: "no-authorized-keys" }),
        },
      });
    }
    return sshAccess;
  } catch (error) {
    await emitCliSshAuditEvent(config, projectDir, {
      event: "ssh.config.validated",
      operation: "ssh.config.validate",
      surface,
      targetResourceKind,
      outcome: "errored",
      safeErrorCode: "SSH_CONFIG_INVALID",
      message: "SSH access configuration validation failed.",
      metadata: {
        enabled: false,
        keyCount: 0,
        fingerprints: [],
        reason: "invalid-ssh-config",
      },
    });
    throw error;
  }
}

async function emitCliSshAuditEvent(config: LooseRecord, projectDir: string, details: LooseRecord) {
  const logPath = projectLogPath(config, projectDir);
  await mkdir(path.dirname(logPath), { recursive: true });
  const input = createPrivilegedAuditLogInput({
    actorKind: "platform",
    source: "cli",
    ...details,
  });
  const event = createLogEnvelope({
    ...input,
    timestamp: null,
    config,
    serverEnv: {},
  });
  await appendFile(logPath, `${JSON.stringify(event)}\n`);
  return event;
}

function sshAuditMetadata(state: LooseRecord) {
  return {
    enabled: Boolean(state.enabled),
    running: Boolean(state.running),
    host: typeof state.host === "string" ? state.host : null,
    port: Number.isInteger(state.port) ? state.port : null,
    targetPort: Number.isInteger(state.targetPort) ? state.targetPort : 22,
    loopbackOnly: state.host === "127.0.0.1" || state.host === "localhost" || state.host === null,
    keyCount: Number.isInteger(state.keyCount) ? state.keyCount : 0,
    fingerprints: Array.isArray(state.fingerprints) ? state.fingerprints.filter((value: unknown) => typeof value === "string") : [],
    reason: typeof state.reason === "string" ? state.reason : null,
  };
}

function explicitSshConfigured(config: LooseRecord) {
  return Boolean(config && typeof config === "object" && Object.hasOwn(config, "ssh"));
}

function projectLogPath(config: LooseRecord, projectDir: string) {
  return (
    config?.logs?.jsonlPath ??
    config?.logging?.jsonlPath ??
    process.env.SPORADES_LOG_PATH ??
    path.join(projectDir, ".sporades", "data", "logs", "events.jsonl")
  );
}

function readProjectConfigSync(projectDir: string) {
  const raw = readFileSync(path.join(projectDir, "sporades.json"), "utf8");
  return JSON.parse(raw);
}

async function startContainerSession(options: LooseRecord) {
  const config = await readProjectConfig(options.projectDir);
  const port = options.port ?? config.deploy?.port ?? 4000;
  const runtimeDir = path.join(options.projectDir, ".sporades");
  const containerName = `sporades-${config.name ?? path.basename(options.projectDir)}`;
  const bindingPath = path.join(options.projectDir, CONTAINER_BINDING_FILE);
  const existingBinding = await readContainerBinding(bindingPath);
  const previousConsumer = await readPublicTreeConsumer(path.join(runtimeDir, "build"), "container");
  verifyContainerReplacementOwnership(existingBinding, previousConsumer, containerName);
  const sshAccess = await resolveLocalContainerSshAccessForAudit(config, options.projectDir, "sporades/deploy", "container-ssh-config");

  const capsuleServices = await writeCapsuleServicesCompose(options.projectDir, config);
  const bundle = await createBundle(options.projectDir, config, { publishLegacy: false });
  const dataDir = path.join(runtimeDir, "data");
  const runtimeUser = sshAccess.enabled ? baseImageRuntimeUser() : localContainerRuntimeUser();
  await mkdir(dataDir, { recursive: true });
  await prepareRuntimeDataPath(dataDir);

  const updatePolicyMode = readBaseImageUpdatePolicy(config);
  const containerCapsuleServices = await startCapsuleServices(capsuleServices, options.projectDir, {
    connection: "container",
    wait: true,
  });

  let clientRelease: LooseRecord;
  try {
    clientRelease = {
      framework: config.client?.framework ?? "react",
      toolchain: config.client?.toolchain ?? "esbuild",
      publicTree: path.basename(bundle.staticFiles.publicDir),
      ...(await summarizePublicTree(bundle.staticFiles.publicDir)),
    };
  } catch (error) {
    const details = errorDetails(error);
    await discardPublicTree(bundle.staticFiles.publicTree).catch(() => {});
    throw commandError(
      "Container public tree validation failed.",
      details.hint ?? "Rebuild the Capsule public output and retry deployment; the running Container was preserved.",
      { phase: "public", framework: config.client?.framework ?? "react", toolchain: config.client?.toolchain ?? "esbuild", cause: details.message },
    );
  }

  ensureLocalBaseImage(options.projectDir);
  const existingContainer = existingBinding?.containerId
    ? inspectDockerContainerOptional(options.projectDir, existingBinding.containerId)
    : null;
  if (existingBinding?.containerId && !existingContainer && !options.force) {
    await discardPublicTree(bundle.staticFiles.publicTree).catch(() => {});
    throw commandError(
      "The existing Container binding is stale.",
      "Retry with `sporades deploy --force`; through npm, use `npm run deploy -- --force`.",
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
  const sshArgs = sshAccess.enabled
    ? [
      "--volume",
      `${sshAccess.authorizedKeysPath}:/run/sporades/ssh/authorized_keys:ro`,
      "--env",
      "SPORADES_SSH_AUTHORIZED_KEYS_PATH=/run/sporades/ssh/authorized_keys",
      "--env",
      "SPORADES_SSH_AUTHORIZED_KEYS_TARGET=/app/data/ssh/authorized_keys",
      "--publish",
      "127.0.0.1::22",
    ]
    : [];
  const bundleMountArgs = bundle.containerMounts.files.flatMap((mount) => ["--volume", formatMount(mount)]);
  const containerTransactionToken = randomBytes(16).toString("hex");
  const capsuleServicesNetworkArgs = capsuleServices ? ["--network", capsuleServices.networks.services] : [];
  const capsuleServicesEnvArgs = Object.entries(containerCapsuleServices.env ?? {}).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`,
  ]);
  const dockerRunArgs = [
      "run",
      "--detach",
      "--name",
      containerName,
      "--restart",
      (restartPolicyForMode("container") as DockerRestartPolcy).dockerRestart,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      runtimeUser,
      ...capsuleServicesNetworkArgs,
      ...Object.entries(baseImageLabels(updatePolicyMode)).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--label",
      `com.sporades.container-transaction=${containerTransactionToken}`,
      "--publish",
      `${port}:4000`,
      ...sshArgs,
      ...bundleMountArgs,
      ...envArgs,
      ...sealedEnvArgs,
      ...capsuleServicesEnvArgs,
      "--volume",
      `${dataDir}:/app/data:rw`,
      "--workdir",
      "/app",
      "--env",
      "PORT=4000",
      "--env",
      "SPORADES_LOG_STDOUT=1",
      SPORADES_BASE_IMAGE.image,
      ...(sshAccess.enabled ? ["/usr/local/bin/sporades-start"] : ["node", "/app/server.mjs"]),
    ];
  const rollbackName = `${containerName}-rollback-${process.pid}-${randomBytes(4).toString("hex")}`;
  const oldName = String(existingContainer?.Name ?? existingBinding?.containerName ?? containerName).replace(/^\//, "");
  const oldWasRunning = Boolean(existingContainer?.State?.Running);
  let oldRenamed = false;
  let rollbackBundlePublication: null | (() => Promise<void>) = null;
  let containerId: string | null = null;
  let candidateOwnershipProven = false;
  let committedConsumer: Awaited<ReturnType<typeof writePublicTreeConsumer>> | null = null;
  let binding: LooseRecord | null = null;
  try {
    if (existingContainer) {
      runDocker(["rename", existingBinding.containerId, rollbackName], options.projectDir, "Failed to stage the existing Container for replacement.", "Retry after Docker can rename the bound Container.");
      oldRenamed = true;
      if (oldWasRunning) {
        runDocker(["stop", rollbackName], options.projectDir, "Failed to stop the staged Container replacement.", "Retry after Docker can stop the bound Container.");
      }
    }

    containerReplacementFault("publication");
    rollbackBundlePublication = await bundle.publishLegacy();
    containerId = runDocker(
      dockerRunArgs,
      options.projectDir,
      "Failed to start the container session.",
      "Check Docker is running, then retry `sporades deploy`.",
    );
    const candidateContainer = inspectDockerContainer(options.projectDir, containerId);
    candidateOwnershipProven = Boolean(
      candidateContainer?.Config?.Labels?.["com.sporades.container-transaction"] === containerTransactionToken
      && String(candidateContainer?.Name ?? "").replace(/^\//, "") === containerName,
    );
    if (!candidateOwnershipProven) {
      throw commandError("Container candidate ownership could not be verified.", "Inspect the returned Container ID before retrying deployment.");
    }
    containerReplacementFault("consumer");
    const consumer = await writePublicTreeConsumer(
      bundle.buildDir,
      "container",
      bundle.staticFiles.publicDir,
      containerId,
      previousConsumer ? { token: previousConsumer.token, identity: previousConsumer.identity } : null,
    );
    committedConsumer = consumer;
    clientRelease.consumerToken = consumer.token;
    binding = {
      containerId,
      containerName,
      clientRelease,
      ...(sshAccess.enabled ? {
        ssh: {
          enabled: true,
          user: SPORADES_BASE_IMAGE.runtimeUser,
          runtimeUser,
          targetPort: 22,
          keyCount: sshAccess.keyCount,
          fingerprints: sshAccess.fingerprints,
        },
      } : {}),
    };
    containerReplacementFault("binding");
    await replaceContainerBinding(bindingPath, binding);
    await bundle.releasePublicTreeLease();
    if (oldRenamed) {
      containerReplacementFault("cleanup");
      runDocker(["rm", rollbackName], options.projectDir, "Failed to finalize Container replacement cleanup.", "Retry deployment after Docker can remove the retained rollback Container.");
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    if (containerId && candidateOwnershipProven) {
      try { runDockerCleanup(["rm", "-f", containerId], options.projectDir, "", "", true); } catch { rollbackFailures.push("candidate-container"); }
    }
    if (rollbackBundlePublication) {
      try { await rollbackBundlePublication(); } catch { rollbackFailures.push("bundle-publication"); }
    }
    if (committedConsumer) {
      try {
        await restorePublicTreeConsumer(
          bundle.buildDir,
          "container",
          previousConsumer,
          { token: committedConsumer.token, identity: committedConsumer.identity },
        );
      } catch { rollbackFailures.push("consumer"); }
    }
    try {
      if (existingBinding) await replaceContainerBinding(bindingPath, existingBinding);
      else await rm(bindingPath, { force: true });
    } catch { rollbackFailures.push("binding"); }
    if (oldRenamed) {
      try { runDocker(["rename", rollbackName, oldName], options.projectDir, "", ""); } catch { rollbackFailures.push("container-name"); }
      if (oldWasRunning) {
        try { runDocker(["start", oldName], options.projectDir, "", ""); } catch { rollbackFailures.push("container-start"); }
      }
    }
    try { await discardPublicTree(bundle.staticFiles.publicTree); } catch { rollbackFailures.push("candidate-public-tree"); }
    if (rollbackFailures.length > 0) {
      throw commandError(
        "Container replacement recovery is incomplete.",
        "Inspect the retained Container, binding, and public-tree state before retrying deployment.",
        { failures: rollbackFailures, cause: errorDetails(error).message },
      );
    }
    throw error;
  }

  if (!containerId || !binding) throw commandError("Container replacement did not commit.", "Retry deployment.");
  if (sshAccess.enabled || explicitSshConfigured(config)) {
    await emitCliSshAuditEvent(config, options.projectDir, {
      event: sshAccess.enabled ? "ssh.access.enabled" : "ssh.access.disabled",
      operation: sshAccess.enabled ? "ssh.container.start" : "ssh.container.disabled",
      surface: "sporades/deploy",
      targetResourceKind: "container-ssh-access",
      outcome: "completed",
      message: sshAccess.enabled ? "Container SSH access enabled for local Container session." : "Container SSH access disabled for local Container session.",
      metadata: {
        enabled: sshAccess.enabled,
        running: true,
        targetPort: 22,
        loopbackOnly: true,
        keyCount: sshAccess.keyCount ?? 0,
        fingerprints: sshAccess.fingerprints ?? [],
        ...(existingBinding?.containerId ? { redeploy: true } : { redeploy: false }),
        ...(sshAccess.enabled ? {} : { reason: "no-authorized-keys" }),
      },
    });
  }

  const url = `http://localhost:${port}`;
  if (options.json) {
    writeResult({
      ok: true,
      data: {
        url,
        port,
        containerId,
        restartPolicy: restartPolicyStatus("container"),
        ...(containerCapsuleServices.services ? { services: containerCapsuleServices.services } : {}),
      },
      error: null,
    });
  } else {
    process.stdout.write(`Sporades container session started at ${url}\n`);
  }
}

async function inspectLocalContainerSsh(options: LooseRecord) {
  const config = await readProjectConfig(options.projectDir);
  const bindingPath = path.join(options.projectDir, CONTAINER_BINDING_FILE);
  const binding = await readContainerBinding(bindingPath);
  if (!binding?.containerId) {
    const data = localContainerSshState({
      enabled: false,
      running: false,
      reason: "no-container-session",
    });
    if (options.json) {
      writeResult({ ok: true, data, error: null });
    } else {
      process.stdout.write("Container SSH disabled: no local Container session. Run `sporades deploy`.\n");
    }
    await emitLocalContainerSshInspectionAudit(config, options.projectDir, data);
    return;
  }

  const intended = binding.ssh ?? { enabled: false, reason: "no-authorized-keys" };
  if (!intended.enabled) {
    const data = localContainerSshState({
      enabled: false,
      running: false,
      reason: intended.reason ?? "no-authorized-keys",
    });
    if (options.json) {
      writeResult({ ok: true, data, error: null });
    } else {
      process.stdout.write("Container SSH disabled: no authorized keys configured. Add `ssh.authorizedKeys` and run `sporades deploy`.\n");
    }
    await emitLocalContainerSshInspectionAudit(config, options.projectDir, data);
    return;
  }

  const inspected = inspectDockerContainer(options.projectDir, binding.containerId);
  const running = Boolean(inspected?.State?.Running);
  const port = inspectedSshPort(inspected);
  const data = localContainerSshState({
    enabled: true,
    running,
    user: intended.user ?? SPORADES_BASE_IMAGE.runtimeUser,
    runtimeUser: inspected?.Config?.User || intended.runtimeUser || baseImageRuntimeUser(),
    host: port?.host ?? null,
    port: port?.port ?? null,
    targetPort: intended.targetPort ?? 22,
    keyCount: intended.keyCount ?? 0,
    fingerprints: intended.fingerprints ?? [],
    reason: running ? (port ? null : "port-not-published") : "container-stopped",
  });
  if (options.json) {
    writeResult({ ok: true, data, error: null });
  } else if (!data.enabled) {
    process.stdout.write("Container SSH disabled.\n");
  } else if (!data.running) {
    process.stdout.write("Container SSH configured, but the Container session is stopped. Run `sporades deploy restart`.\n");
  } else if (!data.port) {
    process.stdout.write("Container SSH configured, but port 22 is not published. Run `sporades deploy`.\n");
  } else {
    process.stdout.write(`Container SSH enabled for ${data.user}@${data.host}:${data.port} (${data.keyCount} authorized key${data.keyCount === 1 ? "" : "s"}).\n`);
  }
  await emitLocalContainerSshInspectionAudit(config, options.projectDir, data);
}

async function emitLocalContainerSshInspectionAudit(config: LooseRecord, projectDir: string, data: LooseRecord) {
  await emitCliSshAuditEvent(config, projectDir, {
    event: "ssh.state.inspected",
    operation: "ssh.container.inspect",
    surface: "sporades/deploy-ssh",
    targetResourceKind: "container-ssh-state",
    outcome: "completed",
    message: "Container SSH state inspected.",
    metadata: sshAuditMetadata(data),
  });
}

function localContainerSshState(overrides: LooseRecord) {
  return {
    enabled: false,
    running: false,
    user: SPORADES_BASE_IMAGE.runtimeUser,
    runtimeUser: null,
    host: null,
    port: null,
    targetPort: 22,
    keyCount: 0,
    fingerprints: [],
    reason: "no-authorized-keys",
    ...overrides,
  };
}

function inspectDockerContainer(projectDir: string, containerId: string) {
  const output = runDocker(
    ["inspect", "--format", "{{json .}}", containerId],
    projectDir,
    "Failed to inspect the local Container session.",
    "Check Docker is running and the bound container still exists. If it was removed manually, run `sporades deploy remove` and deploy again.",
  );
  return JSON.parse(output);
}

function inspectDockerContainerOptional(projectDir: string, containerId: string) {
  const result = spawnSync("docker", ["inspect", "--format", "{{json .}}", containerId], { cwd: projectDir, encoding: "utf8" });
  if (result.status === 0) return JSON.parse(result.stdout.trim());
  if (isMissingDockerContainerError(result)) return null;
  throw commandError("Failed to inspect the existing Container session.", "Check Docker is running, then retry deployment.");
}

function inspectedSshPort(inspected: LooseRecord) {
  const entries = inspected?.NetworkSettings?.Ports?.["22/tcp"];
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  const entry = entries.find((candidate) => candidate?.HostIp === "127.0.0.1") ?? entries[0];
  const port = Number(entry?.HostPort);
  return Number.isInteger(port) ? { host: entry.HostIp ?? null, port } : null;
}

async function inspectDatabase(options: LooseRecord) {
  if (options.subcommand === "query") {
    const validation = validateReadOnlyInspectionSql(options.sql);
    if (!validation.ok) {
      throw commandError(validation.error.message, validation.error.hint);
    }
  }

  const result = await fetchInspectionDatabase(options);

  if (options.json) {
    writeResult(result, !result.ok);
    return;
  }

  if (!result.ok) {
    throw commandError(result.error.message, result.error.hint);
  }

  switch (options.subcommand) {
    case "list":
      for (const table of result.data.tables) {
        process.stdout.write(`${table}\n`);
      }
      return;

    case "dump":
      process.stdout.write(`${JSON.stringify(result.data.tables, null, 2)}\n`);
      return;

    case "query":
      process.stdout.write(`${JSON.stringify(result.data.rows, null, 2)}\n`);
      return;

    default:
      return;
  }
}

async function printLogs(options: LooseRecord) {
  const result =
    (await tryFetchInspectionJson(
      options,
      options.subcommand === "tail" ? "/__sporades/debug/logs/tail" : "/__sporades/debug/logs",
    )) ?? readContainerLogs(options);

  if (options.json) {
    if (options.subcommand === "tail" && result.ok) {
      for (const entry of result.data.entries) {
        process.stdout.write(`${JSON.stringify(entry)}\n`);
      }
      return;
    }
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

async function fetchInspectionDatabase(options: LooseRecord) {
  return (
    (await tryFetchInspectionJson(
      options,
      options.subcommand === "query" ? "/__sporades/debug/db/query" : `/__sporades/debug/db/${options.subcommand}`,
      options.subcommand === "query"
        ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sql: options.sql }),
        }
        : {},
    )) ?? inspectContainerDatabase(options)
  );
}

async function readDevSession(projectDir: string) {
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

async function readOptionalDevSession(projectDir: any) {
  try {
    return await readDevSession(projectDir);
  } catch (error) {
    if (errorDetails(error).message === "No running Sporades dev session found.") {
      return null;
    }
    throw error;
  }
}

async function tryFetchInspectionJson(options: LooseRecord, pathname: string | URL, fetchOptions: LooseRecord = {}) {
  const session = await resolveOptionalDevInspectionSession(options);
  if (!session) {
    return null;
  }
  try {
    const response = await fetch(new URL(pathname, session.url), withDevInspectionTokenHeader(session, fetchOptions));
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

async function resolveRequiredDevInspectionSession(options: LooseRecord) {
  if (!options.port) {
    return await readDevSession(options.projectDir);
  }
  return await resolvePortDevInspectionSession(options);
}

async function resolveOptionalDevInspectionSession(options: LooseRecord) {
  if (!options.port) {
    return await readOptionalDevSession(options.projectDir);
  }
  return await resolvePortDevInspectionSession(options);
}

async function resolvePortDevInspectionSession(options: LooseRecord) {
  const url = `http://localhost:${options.port}`;
  const session = await readOptionalDevSession(options.projectDir);
  if (session && devSessionMatchesPort(session, Number(options.port))) {
    return { ...session, url };
  }
  return { url };
}

function devSessionMatchesPort(session: LooseRecord, port: number) {
  if (!Number.isInteger(port)) {
    return false;
  }
  if (Number(session?.port) === port) {
    return true;
  }
  try {
    return Number(new URL(session?.url).port) === port;
  } catch {
    return false;
  }
}

function readContainerLogs(options: LooseRecord) {
  const container = resolveLocalContainerTarget(options);
  const result = spawnSync("docker", ["logs", "--tail", "200", container.containerId], {
    cwd: options.projectDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return {
      ok: false,
      data: null as any,
      error: {
        message: "Container session logs are unavailable.",
        hint: "Check Docker is running and the bound container still exists, then retry `sporades logs`.",
      },
    };
  }
  const entries = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseDockerLogLine)
    .filter(Boolean);
  const localAuditEntries = readLocalAuditLogEntries(options.projectDir);
  return {
    ok: true,
    data: { source: "docker", containerId: container.containerId, entries: dedupeLogEntries([...localAuditEntries, ...entries]) },
    error: null,
  };
}

function readLocalAuditLogEntries(projectDir: string) {
  return readProjectJsonlLogEvents(projectDir).filter((entry: LooseRecord) => entry?.category === "audit");
}

function readProjectJsonlLogEvents(projectDir: string, limit = 200) {
  try {
    const config = readProjectConfigSync(projectDir);
    return readJsonlLogEvents(projectLogPath(config, projectDir), limit);
  } catch {
    return [];
  }
}

function dedupeLogEntries(entries: LooseRecord[]) {
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function parseDockerLogLine(line: string) {
  try {
    const entry = JSON.parse(line);
    if (entry && typeof entry === "object" && entry.schema === "sporades.log.v1") {
      return entry;
    }
  } catch {
    // Ignore non-JSON process warnings emitted by Node or Docker.
  }
  return null;
}

async function inspectContainerDatabase(options: LooseRecord) {
  const databasePath = resolveLocalContainerDatabasePath(options);
  const sqlite = await createSqliteDatabaseAdapter(databasePath, { readOnly: true });
  try {
    sqlite.exec("PRAGMA busy_timeout = 1000");
    sqlite.exec("PRAGMA query_only = ON");
    const database = { adapter: sqlite, sqlite };

    switch (options.subcommand) {
      case "list":
        return { ok: true, data: { source: "sqlite-file", tables: await listDatabaseTables(database) }, error: null };

      case "dump":
        return { ok: true, data: { source: "sqlite-file", tables: await dumpDatabase(database) }, error: null };

      default:
        return await runReadOnlyQuery(database, options.sql);
    }
  } finally {
    sqlite.close();
  }
}

function resolveLocalContainerDatabasePath(options: LooseRecord) {
  const container = resolveLocalContainerTarget(options);
  const mount = container.mounts.find((entry: { Destination: string; }) => entry.Destination === "/app/data");
  const dataDir = mount?.Source ?? path.join(options.projectDir, ".sporades", "data");
  return path.join(dataDir, "data.db");
}

function resolveLocalContainerTarget(options: LooseRecord) {
  if (options.port) {
    const result = spawnSync("docker", ["ps", "--filter", `publish=${options.port}`, "--format", "{{.ID}}"], {
      cwd: options.projectDir,
      encoding: "utf8",
    });
    const containerId = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean)[0] : null;
    if (containerId) {
      return { containerId, mounts: inspectDockerMounts(options.projectDir, containerId) };
    }
  }

  const bindingPath = path.join(options.projectDir, CONTAINER_BINDING_FILE);
  let binding = null;
  try {
    binding = JSON.parse(readFileSync(bindingPath, "utf8"));
  } catch (error) {
    if (errorDetails(error).code !== "ENOENT") {
      throw error;
    }
  }
  if (!binding?.containerId) {
    throw commandError(
      "No running Sporades session found.",
      "Start `sporades dev`, run `sporades deploy`, or pass `--port <number>` for a running local Container session.",
    );
  }
  return { containerId: binding.containerId, mounts: inspectDockerMounts(options.projectDir, binding.containerId) };
}

function inspectDockerMounts(cwd: any, containerId: string) {
  const result = spawnSync("docker", ["inspect", "--format", "{{json .Mounts}}", containerId], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return [];
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return [];
  }
}

async function fetchLocalIdentitySimulation(session: LooseRecord, body: LooseRecord) {
  let response;
  try {
    response = await fetch(new URL("/__sporades/debug/auth/as", session.url), withDevInspectionTokenHeader(session, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
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

async function fetchAuthClients(session: LooseRecord) {
  let response;
  try {
    response = await fetch(new URL("/__sporades/debug/auth/clients", session.url), withDevInspectionTokenHeader(session));
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

function withDevInspectionTokenHeader(session: LooseRecord, fetchOptions: LooseRecord = {}) {
  if (!session?.inspectionToken) {
    return fetchOptions;
  }
  return {
    ...fetchOptions,
    headers: {
      ...(fetchOptions.headers ?? {}),
      [DEV_INSPECTION_TOKEN_HEADER]: session.inspectionToken,
    },
  };
}

async function upsertServerEnvValues(envPath: PathLike | FileHandle, values: { [s: string]: unknown; } | ArrayLike<unknown>) {
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

async function readRequiredFile(filePath: PathLike | FileHandle, message: string, hint: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      throw commandError(message, hint);
    }
    throw error;
  }
}

async function readContainerBinding(bindingPath: PathLike | FileHandle) {
  try {
    return JSON.parse(await readFile(bindingPath, "utf8"));
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
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

async function readRemoteBinding(projectDir: string) {
  try {
    return JSON.parse(await readFile(path.join(projectDir, REMOTE_BINDING_FILE), "utf8"));
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
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

async function resolveHostPushTarget(config: LooseRecord, options: LooseRecord) {
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
    if (errorDetails(error).code === "ENOENT") {
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

async function writeHostConfig(config: LooseRecord) {
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

function normaliseHostConfig(value: LooseRecord = {}) {
  return {
    profiles: normaliseHostProfiles(value?.profiles),
    currentHostAlias: typeof value?.currentHostAlias === "string" ? value.currentHostAlias : null,
  };
}

function normaliseHostProfiles(value: Record<string, LooseRecord>) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, HostProfile>).map(([alias, profile]) => [
      alias,
      {
        ...profile,
        tls: normaliseHostTls(profile?.tls),
      },
    ]),
  );
}

function normaliseHostTls(value: LooseRecord = {}) {
  const mode = typeof value?.mode === "string" && HOST_TLS_MODES.has(value.mode) ? value.mode : DEFAULT_HOST_TLS_MODE;
  return { mode };
}

function resolveHostProfile(config: LooseRecord, explicitAlias: any) {
  const alias = explicitAlias ?? config.currentHostAlias;
  if (!alias) {
    throw commandError(
      "No current Host profile selected.",
      "Run `sporades host use <alias>` or pass `--host <alias>`.",
    );
  }
  return { alias, profile: requireHostProfile(config, alias) };
}

function requireHostProfile(config: LooseRecord, alias: string | number) {
  const profile = config.profiles[alias];
  if (!profile) {
    throw commandError(
      `Unknown Host profile alias: ${alias}`,
      `Add it with \`sporades host add ${alias} --server <ssh-target> --domain <hosted-domain>\`.`,
    );
  }
  return profile;
}

function publicHostProfile(profile: LooseRecord) {
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

function createRemoteBinding(hostAlias: any, profile: LooseRecord, subname: any) {
  return {
    hostAlias,
    domain: profile.domain,
    scheme: profile.scheme,
    subname,
    hostedUrl: `${profile.scheme}://${subname}.${profile.domain}`,
    remoteCapsuleId: `${profile.domain}/${subname}`,
  };
}

function invokeRemoteHostHelper(options: LooseRecord): HostHelperEnvelope<LooseRecord> {
  const helperPath = remoteHostHelperPath(options.profile);
  const request: LooseRecord = {
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

async function prepareHostPushSealedServerEnv(options: LooseRecord) {
  const paths = sealedServerEnvPaths(options.projectDir);
  const envelope = await readSealedServerEnv(paths);
  if (!envelope) {
    const legacyEnvFile = await readServerEnvFile(path.join(options.projectDir, ".env.sporades.server"));
    const legacyValues = legacyEnvFile.exists ? parseServerEnv(legacyEnvFile) : {};
    if (Object.keys(legacyValues).length > 0) {
      throw commandError(
        "Hosted Capsule push requires Sealed Server env.",
        "Run `sporades env import --file .env.sporades.server --json` explicitly, then retry `sporades host push`.",
        {
          source: "legacy-server-env",
          legacyServerEnvFilePresent: true,
          localSealedServerEnvConfigured: false,
          requiresExplicitImport: true,
        },
      );
    }
    return null;
  }

  const keyPair = await readKeyPair(paths);
  const legacyServerEnvFilePresent = (await readServerEnvFile(path.join(options.projectDir, ".env.sporades.server"))).exists;
  if (!keyPair?.privateKey) {
    throw missingLocalSealedServerEnvSourceError({
      localPrivateKeyConfigured: false,
      legacyServerEnvFilePresent,
    });
  }

  let values;
  try {
    values = unsealServerEnv(envelope, keyPair.privateKey);
  } catch {
    throw missingLocalSealedServerEnvSourceError({
      localPrivateKeyConfigured: true,
      legacyServerEnvFilePresent,
    });
  }

  const hostKey = await readHostedCapsuleSealedEnvPublicKey(options.alias, options.profile, options.subname, options.projectDir);
  const hostEnvelope = sealServerEnv(values, hostKey.publicKey, {
    source: "host-push-auto-reencrypt",
    hostAlias: options.alias,
    hostDomain: options.profile.domain,
    subname: options.subname,
  });
  return {
    envelope: hostEnvelope,
    publicKeyFingerprint: hostKey.publicKeyFingerprint,
    publicKeyPath: hostKey.publicKeyPath ?? null,
  };
}

function missingLocalSealedServerEnvSourceError(details: LooseRecord = {}) {
  return commandError(
    "Local Sealed Server env source values are unavailable.",
    "Restore the local Sealed Server env private key, or run `sporades env import --file .env.sporades.server --json` explicitly from source-of-truth values, then retry. Legacy Server env files are imported only by that explicit command.",
    {
      source: "local-sealed-server-env",
      localSealedServerEnvConfigured: true,
      localPrivateKeyConfigured: Boolean(details.localPrivateKeyConfigured),
      legacyServerEnvFilePresent: Boolean(details.legacyServerEnvFilePresent),
      requiresSourceOfTruthValues: true,
    },
  );
}

async function readHostedCapsuleSealedEnvPublicKey(alias: any, profile: LooseRecord, subname: any, projectDir: any) {
  const result = invokeRemoteHostHelper({
    alias,
    profile,
    action: "capsule.list",
    projectDir,
  });
  if (!result.ok) {
    throw commandError(result.error.message, result.error.hint);
  }
  const capsule = (result.data?.capsules ?? []).find((entry: { subname: any; domain: any; }) => entry?.subname === subname && entry?.domain === profile.domain);
  const sealedServerEnv = capsule?.sealedServerEnv;
  if (!sealedServerEnv?.publicKey || !sealedServerEnv?.publicKeyFingerprint) {
    throw commandError(
      "Hosted Capsule Sealed Server env public key is unavailable.",
      `Run \`sporades host register ${subname} --host ${alias} --json\` or inspect \`sporades host list --host ${alias} --json\`, then retry.`,
      {
        capsule: {
          subname,
          domain: profile.domain,
          hostedUrl: capsule?.hostedUrl ?? `${profile.scheme ?? DEFAULT_HOST_SCHEME}://${subname}.${profile.domain}`,
          remoteCapsuleId: capsule?.registry?.remoteCapsuleId ?? `${profile.domain}/${subname}`,
        },
        sealedServerEnv: {
          expectedPublicKeyFingerprint:
            sealedServerEnv?.publicKeyFingerprint ?? capsule?.registry?.sealedServerEnv?.currentKeyFingerprint ?? null,
          status: sealedServerEnv?.status ?? "unavailable",
          publicKeyAvailable: sealedServerEnv?.publicKeyAvailable ?? false,
          privateKeyAvailable: sealedServerEnv?.privateKeyAvailable ?? null,
          recovery: "inspect-host-key-status-and-re-key-if-host-key-material-is-lost",
        },
      },
    );
  }
  return {
    publicKey: sealedServerEnv.publicKey,
    publicKeyFingerprint: sealedServerEnv.publicKeyFingerprint,
    publicKeyPath: sealedServerEnv.publicKeyPath ?? null,
  };
}

async function createHostReleaseArchive(options: LooseRecord) {
  const releaseId = createHostReleaseId();
  const hostPushDir = path.join(options.projectDir, ".sporades", "host-push");
  await mkdir(hostPushDir, { recursive: true });
  const localArchive = path.join(hostPushDir, `${releaseId}.tar.gz`);
  const packageDir = path.join(hostPushDir, `${releaseId}-files`);
  const remoteArchive = posixJoin(options.profile.remoteRoot, "incoming", `${releaseId}.tar.gz`);
  const sealedServerEnv = await createHostReleaseSealedServerEnv(options);
  const publicFiles = await listHostedPublicFiles(options.bundle.staticFiles.publicDir);
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
    sshAccess: options.sshAccess,
    updatePolicyMode: readBaseImageUpdatePolicy(options.projectConfig),
    publicFiles,
  });
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(path.join(packageDir, ".sporades", "sealed-server-env"), { recursive: true });
  await mkdir(path.join(packageDir, ".sporades", "ssh"), { recursive: true });
  await cp(options.bundle.staticFiles.publicDir, path.join(packageDir, "public"), { recursive: true, errorOnExist: true });
  const releaseConfig = sanitizeHostedReleaseConfig(options.projectConfig, options.sshAccess);
  await Promise.all([
    writeFile(path.join(packageDir, "server.mjs"), await readFile(path.join(options.bundle.buildDir, "server.mjs"), "utf8")),
    writeFile(path.join(packageDir, "sporades.json"), `${JSON.stringify(releaseConfig, null, 2)}\n`),
  ]);
  if (options.bundle.containerMounts.serverEnv) {
    await writeFile(path.join(packageDir, ".env.sporades.server"), await readFile(options.bundle.containerMounts.serverEnv.host, "utf8"));
  }
  if (sealedServerEnv) {
    await writeFile(
      path.join(packageDir, ".sporades", "sealed-server-env", "server-env.sealed.json"),
      `${JSON.stringify(sealedServerEnv.envelope, null, 2)}\n`,
    );
  }
  if (options.sshAccess?.enabled) {
    const authorizedKeysPath = path.join(packageDir, ".sporades", "ssh", "authorized_keys");
    await writeFile(authorizedKeysPath, `${options.sshAccess.lines.join("\n")}\n`, { mode: 0o644 });
    await chmod(authorizedKeysPath, 0o644);
  }
  const tarArgs = [
    "-czf",
    localArchive,
    "server.mjs",
    "sporades.json",
    ...publicFiles,
  ];
  if (options.bundle.containerMounts.serverEnv) {
    tarArgs.push(".env.sporades.server");
  }
  if (sealedServerEnv) {
    tarArgs.push(".sporades/sealed-server-env/server-env.sealed.json");
  }
  if (options.sshAccess?.enabled) {
    tarArgs.push(".sporades/ssh/authorized_keys");
  }
  const result = spawnSync("tar", tarArgs, {
    cwd: packageDir,
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
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

async function listHostedPublicFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listHostedPublicFiles(root, entryPath));
    else if (entry.isFile()) files.push(`public/${path.relative(root, entryPath).split(path.sep).join("/")}`);
    else throw commandError("Invalid Hosted Capsule public tree.", "Rebuild a normalized public tree containing regular files only.");
  }
  return files.sort();
}

async function resolveHostedCapsuleSshAccess(config: LooseRecord, projectDir: string) {
  const lines = await resolveAuthorizedKeyLines(config.ssh, projectDir);
  if (lines.length === 0) {
    return { enabled: false, keyCount: 0, fingerprints: [], lines: [] };
  }
  return {
    enabled: true,
    keyCount: lines.length,
    fingerprints: lines.map(authorizedKeyFingerprint),
    lines,
  };
}

async function resolveHostedCapsuleSshAccessForAudit(config: LooseRecord, projectDir: string) {
  try {
    const sshAccess = await resolveHostedCapsuleSshAccess(config, projectDir);
    if (sshAccess.enabled || explicitSshConfigured(config)) {
      await emitCliSshAuditEvent(config, projectDir, {
        event: "ssh.config.validated",
        operation: "ssh.config.validate",
        surface: "sporades/host-push",
        targetResourceKind: "hosted-ssh-config",
        outcome: "completed",
        message: "Hosted Capsule SSH access configuration validated.",
        metadata: {
          enabled: sshAccess.enabled,
          keyCount: sshAccess.keyCount ?? 0,
          fingerprints: sshAccess.fingerprints ?? [],
          ...(sshAccess.enabled ? {} : { reason: "no-authorized-keys" }),
        },
      });
    }
    return sshAccess;
  } catch (error) {
    await emitCliSshAuditEvent(config, projectDir, {
      event: "ssh.config.validated",
      operation: "ssh.config.validate",
      surface: "sporades/host-push",
      targetResourceKind: "hosted-ssh-config",
      outcome: "errored",
      safeErrorCode: "SSH_CONFIG_INVALID",
      message: "Hosted Capsule SSH access configuration validation failed.",
      metadata: {
        enabled: false,
        keyCount: 0,
        fingerprints: [],
        reason: "invalid-ssh-config",
      },
    });
    throw error;
  }
}

function sanitizeHostedReleaseConfig(config: LooseRecord, sshAccess: LooseRecord) {
  const releaseConfig = JSON.parse(JSON.stringify(config ?? {}));
  if (releaseConfig && typeof releaseConfig === "object" && Object.hasOwn(releaseConfig, "ssh")) {
    delete releaseConfig.ssh;
  }
  return releaseConfig;
}

async function createHostReleaseSealedServerEnv(options: LooseRecord) {
  if (!options.bundle.containerMounts.sealedServerEnv) {
    return null;
  }
  if (!options.sealedServerEnv) {
    throw missingLocalSealedServerEnvSourceError();
  }
  return {
    included: true,
    envelope: options.sealedServerEnv.envelope,
    publicKeyFingerprint: options.sealedServerEnv.publicKeyFingerprint,
    publicKeyPath: options.sealedServerEnv.publicKeyPath,
  };
}

function uploadHostReleaseArchive(options: LooseRecord) {
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

function createHostReleaseId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

function normaliseHostLogEntries(data: LooseRecord) {
  if (!Array.isArray(data?.entries)) {
    return [];
  }
  return data.entries.map((entry: any) => String(entry));
}

function formatHostedCapsuleList(data: LooseRecord, profile: LooseRecord) {
  const capsules = normaliseHostedCapsules(data);
  const domain = data?.host?.domain ?? profile.domain;
  if (capsules.length === 0) {
    return `No Hosted Capsules registered for ${domain}.\n`;
  }

  const rows = capsules.map((capsule: { subname: any; hostedUrl: any; registry: any; currentRelease: any; docker: any; }) => ({
    subname: capsule.subname,
    hostedUrl: capsule.hostedUrl,
    registry: formatCapsuleRegistryStatus(capsule.registry),
    release: formatCapsuleRelease(capsule.currentRelease),
    docker: formatCapsuleDockerStatus(capsule.docker),
  }));
  const headers: Record<string, string> = {
    subname: "SUBNAME",
    hostedUrl: "URL",
    registry: "REGISTRY",
    release: "RELEASE",
    docker: "DOCKER",
  };
  const keys = ["subname", "hostedUrl", "registry", "release", "docker"];
  const widths = Object.fromEntries(
    keys.map((key) => [key, Math.max(headers[key].length, ...rows.map((row: LooseRecord) => row[key].length))]),
  );
  const line = (row: LooseRecord) =>
    [row.subname, row.hostedUrl, row.registry, row.release, row.docker]
      .map((value, index) => {
        const key = keys[index];
        return index === 4 ? value : value.padEnd(widths[key] + 2);
      })
      .join("");

  return `${line(headers)}\n${rows.map(line).join("\n")}\n`;
}

function normaliseHostedCapsules(data: LooseRecord) {
  if (!Array.isArray(data?.capsules)) {
    return [];
  }
  return data.capsules.map((capsule: { subname: any; hostedUrl: any; registry: any; currentRelease: any; docker: any; }) => ({
    subname: String(capsule?.subname ?? ""),
    hostedUrl: String(capsule?.hostedUrl ?? ""),
    registry: capsule?.registry ?? null,
    currentRelease: capsule?.currentRelease ?? null,
    docker: capsule?.docker ?? null,
  }));
}

function formatCapsuleRegistryStatus(registry: LooseRecord) {
  return String(registry?.status ?? registry?.state ?? registry?.lifecycleStatus ?? "registered");
}

function formatCapsuleRelease(release: LooseRecord) {
  return String(release?.id ?? release?.releaseId ?? release?.version ?? "none");
}

function formatHostedCapsuleReleases(data: LooseRecord) {
  const releases = Array.isArray(data?.releases) ? data.releases : [];
  const subname = data?.capsule?.subname ?? "Hosted Capsule";
  if (releases.length === 0) {
    return `No releases recorded for ${subname}.\n`;
  }

  const rows = releases.map((release: { id: any; state: any; current: any; createdAt: any; }) => ({
    id: String(release.id ?? ""),
    state: String(release.state ?? "uploaded"),
    current: release.current ? "yes" : "no",
    createdAt: String(release.createdAt ?? "unknown"),
  }));
  const headers: Record<string, string> = {
    id: "RELEASE",
    state: "STATE",
    current: "CURRENT",
    createdAt: "CREATED",
  };
  const keys = ["id", "state", "current", "createdAt"];
  const widths = Object.fromEntries(
    keys.map((key) => [key, Math.max(headers[key].length, ...rows.map((row: LooseRecord) => row[key].length))]),
  );
  const line = (row: LooseRecord) =>
    [row.id, row.state, row.current, row.createdAt]
      .map((value, index) => {
        const key = keys[index];
        return index === 3 ? value : value.padEnd(widths[key] + 2);
      })
      .join("");

  return `${line(headers)}\n${rows.map(line).join("\n")}\n`;
}

function formatCapsuleDockerStatus(docker: LooseRecord) {
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

function createHostHealthUrl(profile: LooseRecord) {
  return `${profile.scheme ?? DEFAULT_HOST_SCHEME}://host.${profile.domain}${HOST_HEALTH_PATH}`;
}

async function checkHostServerHealth(alias: any, profile: any) {
  const healthUrl = createHostHealthUrl(profile);
  const failureData = (failure: string, extra = {}) => ({
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
    const failure = classifyHostHealthFetchFailure(errorDetails(error));
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
    error: null as any,
  };
}

function classifyHostHealthFetchFailure(error: LooseRecord) {
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

function isExpectedHostHealthResponse(value: LooseRecord) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.ok === true &&
    Object.keys(value).length === 1
  );
}

function unexpectedHostHealthResponse(alias: any, healthUrl: string, statusCode: number) {
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

function remoteHostHelperPath(profile: LooseRecord) {
  return `${profile.remoteRoot}/bin/sporades-host-helper`;
}

function localHostHelperPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "sporades-host-helper.js");
}

function upgradeHostHelper(options: LooseRecord) {
  const localHelper = localHostHelperPath();
  const remoteHelper = remoteHostHelperPath(options.profile);
  const remoteBin = path.posix.dirname(remoteHelper);

  try {
    if (!statSync(localHelper).isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw commandError(
      "Local Host helper file was not found.",
      "Run `npm run build` or reinstall Sporades, then retry `sporades host upgrade --host <alias>`.",
    );
  }

  const prepare = spawnSync("ssh", [options.profile.server, `mkdir -p ${quoteRemoteShell(remoteBin)}`], {
    cwd: options.projectDir,
    encoding: "utf8",
  });
  if (prepare.error || prepare.status !== 0) {
    throw commandError(
      "Failed to prepare Host helper directory.",
      "Check the Host profile SSH target, network connectivity, SSH key access, and remote root permissions.",
    );
  }

  const upload = spawnSync("scp", [localHelper, `${options.profile.server}:${remoteHelper}`], {
    cwd: options.projectDir,
    encoding: "utf8",
  });
  if (upload.error || upload.status !== 0) {
    throw commandError(
      "Failed to upload Host helper.",
      "Check the Host profile SSH target, network connectivity, SSH key access, and remote root permissions.",
    );
  }

  const chmod = spawnSync("ssh", [options.profile.server, `chmod 0755 ${quoteRemoteShell(remoteHelper)}`], {
    cwd: options.projectDir,
    encoding: "utf8",
  });
  if (chmod.error || chmod.status !== 0) {
    throw commandError(
      "Failed to mark the Host helper executable.",
      "Check the Host profile SSH target, SSH key access, and remote root permissions.",
    );
  }

  return {
    ok: true,
    data: {
      alias: options.alias,
      version: CLI_VERSION,
      localHelper: normalisePathForOutput(localHelper),
      remoteHelper,
    },
    error: null as any,
  };
}

function quoteRemoteShell(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function writeGithubAutodeployWorkflow(options: LooseRecord) {
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
      error: null as any,
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
    if (errorDetails(error).code !== "ENOENT") {
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

function normalisePathForOutput(filePath: string) {
  return filePath.split(path.sep).join("/");
}

function posixJoin(...segments: string[]) {
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

function parseRemoteHostHelperResult(result: SpawnSyncReturns<string>) {
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

function parseSporadesJsonEnvelope(raw: string) {
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

function validateHostAlias(alias: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) {
    throw commandError(
      "Invalid Host profile alias.",
      "Use letters, numbers, dots, underscores, or dashes, starting with a letter or number.",
    );
  }
}

function validateHostedDomain(domain: string) {
  const labels = domain.split(".");
  const valid =
    domain.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
  if (!valid) {
    throw commandError(
      "Invalid Hosted domain.",
      "Pass a DNS domain such as `example.com` without a scheme, path, or wildcard.",
    );
  }
}

function validateHostRemoteRoot(remoteRoot: string) {
  const segments = remoteRoot.split("/").filter(Boolean);
  const valid =
    remoteRoot.startsWith("/") &&
    remoteRoot !== "/" &&
    !remoteRoot.includes("\0") &&
    !remoteRoot.includes("\n") &&
    segments.every((segment: string) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment));
  if (!valid) {
    throw commandError("Invalid Host remote root.", "Pass an absolute POSIX path such as `/srv/sporades`.");
  }
}

function validateHostTlsMode(tlsMode: string) {
  if (!HOST_TLS_MODES.has(tlsMode)) {
    throw commandError(
      "Invalid Host TLS mode.",
      "Use `--tls automatic` for Caddy-managed certificates or `--tls cloudflare-origin` for preinstalled Cloudflare origin certificates.",
    );
  }
}

function validateHostReleaseId(releaseId: string) {
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(releaseId)) {
    throw commandError(
      "Invalid Hosted Capsule release ID.",
      "Use a recorded release ID from `sporades host releases <subname> --json`.",
    );
  }
}

function validateGithubWorkflowBranch(branch: string) {
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

function validateGithubWorkflowFile(filePath: string) {
  if (!filePath || path.isAbsolute(filePath) || filePath.includes("\0")) {
    throw commandError("Invalid GitHub workflow file path.", "Pass a relative path such as `.github/workflows/sporades-autodeploy.yml`.");
  }
}

function validateCapsuleSubname(subname: string) {
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

function validateRemoteHelperAction(action: string) {
  if (!/^[a-z][a-z0-9.-]*$/.test(action)) {
    throw commandError(
      "Invalid remote Host helper action.",
      "Use a lowercase action name such as `contract.echo`.",
    );
  }
}

function run(command: string, args: readonly string[], cwd: any, message: string, hint: string) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw commandError(message, hint);
  }
}

function runDocker(args: any[] | readonly string[], cwd: any, message: string, hint: string) {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw commandError(message, hint);
  }
  return result.stdout.trim();
}

async function printLocalCapsuleServiceStatus(options: LooseRecord, surface: string) {
  const config = await readProjectConfig(options.projectDir);
  const capsuleServices = localCapsuleServicesFromConfig(config, options.projectDir);
  const binding = surface === "deploy"
    ? await readContainerBinding(path.join(options.projectDir, CONTAINER_BINDING_FILE))
    : null;
  const data = {
    ...(binding?.containerId ? {
      container: {
        containerId: binding.containerId,
        containerName: binding.containerName ?? null,
        clientRelease: binding.clientRelease ?? null,
      },
    } : {}),
    services: await localCapsuleServicesStatus(capsuleServices, options.projectDir),
  };

  if (options.json) {
    writeResult({ ok: true, data, error: null });
    return;
  }
  for (const [name, service] of Object.entries(data.services) as Array<[string, LooseRecord]>) {
    process.stdout.write(`${name}: ${service.status}${service.health ? ` (${service.health})` : ""}\n`);
  }
}

function localCapsuleServicesFromConfig(config: LooseRecord, projectDir: string) {
  if (!hasDeclaredLocalCapsuleServices(config)) {
    validateCapsuleServicesConfig(config.services);
    return null;
  }
  validateCapsuleServicesConfig(config.services);
  return {
    path: path.join(projectDir, CAPSULE_SERVICES_COMPOSE_FILE),
    relativePath: CAPSULE_SERVICES_COMPOSE_FILE,
    ...capsuleServicesComposeModel(config, projectDir),
  };
}

function hasDeclaredLocalCapsuleServices(config: LooseRecord) {
  return Boolean(config.services?.database || config.services?.storage);
}

async function requireLocalContainerBinding(options: LooseRecord, action: string) {
  const bindingPath = path.join(options.projectDir, CONTAINER_BINDING_FILE);
  const binding = await readContainerBinding(bindingPath);
  if (!binding?.containerId) {
    throw commandError(
      "No local Container session binding found.",
      `Run \`sporades deploy\` before \`sporades deploy ${action}\`.`,
    );
  }
  return { binding, bindingPath };
}

function containerLifecycleSummary(status: string, binding: LooseRecord) {
  return {
    status,
    containerId: binding.containerId,
    containerName: binding.containerName ?? null,
  };
}

async function stopLocalContainerSession(options: LooseRecord) {
  const { binding } = await requireLocalContainerBinding(options, "stop");
  runDocker(
    ["stop", binding.containerId],
    options.projectDir,
    "Failed to stop the local Container session.",
    "Check Docker is running and the bound container still exists. If it was removed manually, run `sporades deploy remove`.",
  );
  return containerLifecycleSummary("stopped", binding);
}

async function restartLocalContainerSession(options: LooseRecord) {
  const { binding } = await requireLocalContainerBinding(options, "restart");
  const config = await readProjectConfig(options.projectDir);
  const capsuleServices = await writeCapsuleServicesCompose(options.projectDir, config);
  const serviceState = await startCapsuleServices(capsuleServices, options.projectDir, {
    connection: "container",
    wait: true,
  });

  runDocker(
    ["start", binding.containerId],
    options.projectDir,
    "Failed to restart the local Container session.",
    "Check Docker is running and the bound container still exists. If it was removed manually, run `sporades deploy remove` and deploy again.",
  );

  if (options.json) {
    writeResult({
      ok: true,
      data: {
        container: containerLifecycleSummary("running", binding),
        ...(serviceState.services ? { services: serviceState.services } : { services: {} }),
      },
      error: null,
    });
  } else {
    process.stdout.write("Local Container session restarted.\n");
  }
}

async function removeLocalContainerSession(options: LooseRecord) {
  const bindingPath = path.join(options.projectDir, CONTAINER_BINDING_FILE);
  const binding = await readContainerBinding(bindingPath);
  if (!binding?.containerId) {
    if (options.missingOk) {
      return null;
    }
    throw commandError(
      "No local Container session binding found.",
      "Run `sporades deploy` before `sporades deploy remove`.",
    );
  }
  const buildDir = path.join(options.projectDir, ".sporades", "build");
  const currentConsumer = await readPublicTreeConsumer(buildDir, "container");
  const bindingExpectation = binding.clientRelease?.consumerToken
    ? { token: binding.clientRelease.consumerToken, identity: binding.containerId }
    : null;
  let claimedConsumer = null;
  if (currentConsumer || bindingExpectation) {
    if (!currentConsumer || !bindingExpectation) {
      throw commandError("Container consumer ownership changed.", "Inspect the current binding and retry from its owning Container lifecycle.");
    }
    claimedConsumer = await writePublicTreeConsumer(
      buildDir,
      "container",
      path.join(buildDir, ".public-trees", currentConsumer.tree),
      currentConsumer.identity,
      bindingExpectation,
    );
  }
  try {
    runDockerCleanup(
      ["rm", "-f", binding.containerId],
      options.projectDir,
      "Failed to remove the local Container session.",
      "Check Docker is running, then retry `sporades deploy remove`.",
      true,
    );
  } catch (error) {
    if (claimedConsumer && currentConsumer) {
      await restorePublicTreeConsumer(
        buildDir,
        "container",
        currentConsumer,
        { token: claimedConsumer.token, identity: claimedConsumer.identity },
      ).catch(() => {});
    }
    throw error;
  }
  await removePublicTreeConsumer(
    buildDir,
    "container",
    claimedConsumer ? { token: claimedConsumer.token, identity: claimedConsumer.identity } : null,
  );
  await rm(bindingPath, { force: true });
  const services = options.stopServices === false ? {} : await stopLocalCapsuleServices({ ...options, silent: true });
  const container = containerLifecycleSummary("removed", binding);

  if (options.silent) {
    return container;
  }
  if (options.json) {
    writeResult({ ok: true, data: { container, services }, error: null });
  } else {
    process.stdout.write("Local Container session removed.\n");
  }
  return container;
}

async function stopLocalCapsuleServices(options: LooseRecord) {
  const config = await readProjectConfig(options.projectDir);
  const capsuleServices = await writeCapsuleServicesCompose(options.projectDir, config);
  const services = {};
  if (capsuleServices) {
    runDocker(
      ["compose", "-f", capsuleServices.path, "down", "--remove-orphans"],
      options.projectDir,
      "Failed to stop Capsule services.",
      "Check Docker is running and supports `docker compose down`, then retry the command.",
    );
    Object.assign(services, capsuleServicesJsonSummary(capsuleServices, "stopped"));
  }

  if (options.silent) {
    return services;
  }
  if (options.json) {
    writeResult({ ok: true, data: { services }, error: null });
    return services;
  }
  process.stdout.write("Capsule services stopped.\n");
  return services;
}

async function resetLocalCapsuleServices(options: LooseRecord) {
  const config = await readProjectConfig(options.projectDir);
  validateCapsuleServicesConfig(config.services);
  const capsuleServices = hasDeclaredLocalCapsuleServices(config) ? await writeCapsuleServicesCompose(options.projectDir, config) : null;
  const services: Record<string, LooseRecord> = {};
  if (capsuleServices) {
    runDocker(
      ["compose", "-f", capsuleServices.path, "down", "--remove-orphans", "--volumes"],
      options.projectDir,
      "Failed to reset Capsule services.",
      "Check Docker is running and supports `docker compose down`, then retry the command.",
    );
    await Promise.all(
      Object.values(capsuleServices.services as Record<string, CapsuleService>).map((service) =>
        rm(service.stateDir, { recursive: true, force: true }),
      ),
    );
    const removedImages = removeSporadesOwnedCapsuleImages(capsuleServices, options.projectDir);
    Object.assign(services, capsuleServicesJsonSummary(capsuleServices, "reset"));
    for (const service of Object.values(services)) {
      service.removedImages = removedImages;
    }
  }

  if (options.silent) {
    return services;
  }
  if (options.json) {
    writeResult({ ok: true, data: { services }, error: null });
    return services;
  }
  process.stdout.write("Capsule service state reset.\n");
  return services;
}

async function localCapsuleServicesStatus(capsuleServices: CapsuleServicesModel | null, projectDir: any) {
  if (!capsuleServices) {
    return {};
  }
  const services: Record<string, LooseRecord> = {};
  const networkExists = dockerResourceExists(["network", "inspect", capsuleServices.networks.services], projectDir);
  for (const [name, service] of Object.entries(capsuleServices.services) as Array<[string, CapsuleService]>) {
    const diagnostics: LooseRecord[] = [];
    let runtime: LooseRecord = { state: "unknown", health: null };
    try {
      runtime = capsuleServiceStatus(capsuleServices, projectDir, service.name);
    } catch (error) {
      diagnostics.push({
        code: "compose-status-unavailable",
        message: (error as Error).message,
      });
    }
    services[name] = {
      declared: true,
      engine: service.engine,
      status: runtime.state || "unknown",
      health: runtime.health,
      network: {
        name: capsuleServices.networks.services,
        exists: networkExists,
      },
      volume: {
        type: "bind",
        path: path.join(CAPSULE_SERVICES_STATE_DIR, name),
        exists: await pathExists(service.stateDir),
      },
      containerName: service.name,
      composeFile: capsuleServices.relativePath,
      diagnostics,
    };
  }
  return services;
}

function removeSporadesOwnedCapsuleImages(capsuleServices: CapsuleServicesModel, projectDir: any) {
  const images = new Set();
  for (const args of [
    [
      "image",
      "ls",
      "--quiet",
      "--filter",
      "label=com.sporades.managed=true",
      "--filter",
      `label=com.sporades.project=${capsuleServices.projectSlug}`,
    ],
    ["image", "ls", "--quiet", `sporades-${capsuleServices.projectSlug}-*`],
  ]) {
    for (const image of dockerList(args, projectDir)) {
      images.add(image);
    }
  }
  if (images.size > 0) {
    runDocker(
      ["rmi", ...images],
      projectDir,
      "Failed to remove Sporades-owned Capsule images.",
      "Check Docker is running, then retry the reset command.",
    );
  }
  return [...images];
}

function dockerList(args: readonly string[], cwd: any) {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function dockerResourceExists(args: readonly string[], cwd: any) {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8" });
  return result.status === 0;
}

async function pathExists(targetPath: PathLike) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function startCapsuleServices(
  capsuleServices: CapsuleServicesModel | null,
  projectDir: any,
  options: StartCapsuleServicesOptions = {},
) {
  if (!capsuleServices) {
    return options.connection === "container" ? { env: {}, services: null } : {};
  }
  for (const [name, service] of Object.entries(capsuleServices.services) as Array<[string, CapsuleService]>) {
    options.emit?.({
      event: "service",
      service: name,
      status: "starting",
      engine: service.engine,
      statePath: path.join(CAPSULE_SERVICES_STATE_DIR, name),
    });
  }
  try {
    runDocker(
      ["compose", "-f", capsuleServices.path, "up", "--detach"],
      projectDir,
      "Failed to start Capsule services.",
      "Check Docker is running and supports `docker compose`, then retry the command.",
    );
  } catch (error) {
    if (options.connection === "container") {
      const details = errorDetails(error);
      details.diagnostics = {
        ...(details.diagnostics ?? {}),
        services: capsuleServicesJsonSummary(capsuleServices, "failed"),
      };
    }
    throw error;
  }
  if (!options.wait) {
    return {};
  }
  const connections: Record<string, CapsuleServiceConnection> = {};
  try {
    for (const [name, service] of Object.entries(capsuleServices.services) as Array<[string, CapsuleService]>) {
      connections[name] = await waitForCapsuleService(capsuleServices, projectDir, name, service, options.connection ?? "local");
    }
  } catch (error) {
    if (options.connection === "container") {
      const details = errorDetails(error);
      details.diagnostics = {
        ...(details.diagnostics ?? {}),
        services: capsuleServicesJsonSummary(capsuleServices, "failed"),
      };
    }
    throw error;
  }
  if (options.connection === "container") {
    return {
      env: capsuleServicesContainerEnv(capsuleServices),
      services: capsuleServicesJsonSummary(capsuleServices, "ready"),
    };
  }
  for (const [name, connection] of Object.entries(connections)) {
    const service = capsuleServices.services[name];
    options.emit?.({
      event: "service",
      service: name,
      status: "ready",
      engine: service.engine,
      statePath: path.join(CAPSULE_SERVICES_STATE_DIR, name),
      host: connection.host,
      port: connection.port,
    });
  }
  return capsuleServicesLocalEnv(capsuleServices, connections);
}

function capsuleServicesContainerEnv(capsuleServices: CapsuleServicesModel) {
  const env: ServiceEnv = {};
  if (capsuleServices.services.database) {
    const service = capsuleServices.services.database;
    env.SPORADES_SERVICE_DATABASE_ENGINE = service.engine;
    env.SPORADES_SERVICE_DATABASE_URL =
      service.engine === "postgres"
        ? `postgres://${encodeURIComponent(service.user)}:${encodeURIComponent(service.password)}@${service.name}:${service.targetPort}/${service.databaseName}`
        : `http://${service.name}:${service.targetPort}`;
  }
  if (capsuleServices.services.storage) {
    const service = capsuleServices.services.storage;
    env.SPORADES_SERVICE_STORAGE_ENGINE = service.engine;
    env.SPORADES_SERVICE_STORAGE_ENDPOINT = `http://${service.name}:${service.targetPort}`;
    env.SPORADES_SERVICE_STORAGE_ACCESS_KEY = service.accessKey;
    env.SPORADES_SERVICE_STORAGE_SECRET_KEY = service.secretKey;
    env.SPORADES_SERVICE_STORAGE_BUCKET = service.bucket;
    env.SPORADES_SERVICE_STORAGE_REGION = service.region;
    env.SPORADES_SERVICE_STORAGE_NAMESPACE = service.namespace;
  }
  return env;
}

function capsuleServicesLocalEnv(capsuleServices: CapsuleServicesModel, connections: Record<string, CapsuleServiceConnection>) {
  const env: ServiceEnv = {};
  if (capsuleServices.services.database) {
    const service = capsuleServices.services.database;
    const connection = connections.database;
    if (!connection?.url) {
      throw commandError("Capsule database service connection is unavailable.", "Restart `sporades dev` so the service can publish a local URL.");
    }
    env.SPORADES_SERVICE_DATABASE_ENGINE = service.engine;
    env.SPORADES_SERVICE_DATABASE_URL = connection.url;
  }
  if (capsuleServices.services.storage) {
    const service = capsuleServices.services.storage;
    const connection = connections.storage;
    if (!connection?.url) {
      throw commandError("Capsule storage service connection is unavailable.", "Restart `sporades dev` so the service can publish a local URL.");
    }
    env.SPORADES_SERVICE_STORAGE_ENGINE = service.engine;
    env.SPORADES_SERVICE_STORAGE_ENDPOINT = connection.url;
    env.SPORADES_SERVICE_STORAGE_ACCESS_KEY = service.accessKey;
    env.SPORADES_SERVICE_STORAGE_SECRET_KEY = service.secretKey;
    env.SPORADES_SERVICE_STORAGE_BUCKET = service.bucket;
    env.SPORADES_SERVICE_STORAGE_REGION = service.region;
    env.SPORADES_SERVICE_STORAGE_NAMESPACE = service.namespace;
  }
  return env;
}

function capsuleServicesJsonSummary(capsuleServices: CapsuleServicesModel, status: string) {
  return Object.fromEntries(
    (Object.entries(capsuleServices.services) as Array<[string, CapsuleService]>).map(([name, service]) => [
      name,
      {
        status,
        engine: service.engine,
        network: capsuleServices.networks.services,
        containerName: service.name,
        statePath: path.join(CAPSULE_SERVICES_STATE_DIR, name),
      },
    ]),
  );
}

async function waitForCapsuleService(capsuleServices: CapsuleServicesModel, projectDir: any, name: string, service: LooseRecord, connection: string) {
  if (connection === "container") {
    return await waitForHealthyCapsuleService(capsuleServices, projectDir, name, service);
  }
  if (service.kind === "database") {
    return await waitForCapsuleDatabaseService(capsuleServices, projectDir);
  }
  const deadline = Date.now() + capsuleServiceReadinessTimeoutMs();
  let lastStatus = null;
  let lastError = null;
  let lastProbe = null;

  while (Date.now() < deadline) {
    const status = capsuleServiceStatus(capsuleServices, projectDir, service.name);
    lastStatus = status;
    if (["exited", "dead", "removing"].includes(status.state) || status.health === "unhealthy") {
      lastError = status;
      break;
    }
    if (status.state === "running") {
      const port = capsuleServicePort(capsuleServices, projectDir, service.name, service.targetPort, name);
      const connection = {
        host: "127.0.0.1",
        port,
        url: `http://127.0.0.1:${port}`,
      };
      lastProbe = await probeCapsuleStorageService(connection.url);
      if (lastProbe.ok) {
        return connection;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const diagnostics = {
    service: name,
    engine: service.engine,
    status: lastError ?? lastStatus ?? { state: "unknown", health: null },
    probe: lastProbe,
  };
  const error = commandError(
    "Capsule storage service did not become ready.",
    "Run `docker compose -f .sporades/compose/capsule-services.compose.yml ps` and inspect the service logs.",
  );
  error.diagnostics = diagnostics;
  throw error;
}

async function waitForHealthyCapsuleService(capsuleServices: CapsuleServicesModel, projectDir: any, name: any, service: LooseRecord) {
  const deadline = Date.now() + capsuleServiceReadinessTimeoutMs();
  let lastStatus = null;
  let lastError = null;

  while (Date.now() < deadline) {
    const status = capsuleServiceStatus(capsuleServices, projectDir, service.name);
    lastStatus = status;
    if (["exited", "dead", "removing"].includes(status.state) || status.health === "unhealthy") {
      lastError = status;
      break;
    }
    if (status.state === "running" && status.health === "healthy") {
      return {
        host: service.name,
        port: service.targetPort,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const diagnostics = {
    service: name,
    engine: service.engine,
    status: lastError ?? lastStatus ?? { state: "unknown", health: null },
    probe: null as any,
  };
  const error = commandError(
    `Capsule ${service.kind} service did not become ready.`,
    "Run `docker compose -f .sporades/compose/capsule-services.compose.yml ps` and inspect the service logs.",
  );
  error.diagnostics = diagnostics;
  throw error;
}

async function waitForCapsuleDatabaseService(capsuleServices: CapsuleServicesModel, projectDir: any) {
  const service = capsuleServices.services.database;
  const deadline = Date.now() + capsuleServiceReadinessTimeoutMs();
  let lastStatus = null;
  let lastError = null;
  let lastProbe = null;

  while (Date.now() < deadline) {
    const status = capsuleServiceStatus(capsuleServices, projectDir, service.name);
    lastStatus = status;
    if (["exited", "dead", "removing"].includes(status.state) || status.health === "unhealthy") {
      lastError = status;
      break;
    }
    if (status.state === "running") {
      const port = capsuleServicePort(capsuleServices, projectDir, service.name, service.targetPort);
      const connection = {
        host: "127.0.0.1",
        port,
        url: localCapsuleDatabaseUrl(service, port),
      };
      lastProbe = await probeCapsuleDatabaseService(capsuleServices, connection.url);
      if (lastProbe.ok) {
        return connection;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const diagnostics = {
    service: "database",
    engine: service.engine,
    status: lastError ?? lastStatus ?? { state: "unknown", health: null },
    probe: lastProbe,
  };
  const error = commandError(
    "Capsule database service did not become ready.",
    "Run `docker compose -f .sporades/compose/capsule-services.compose.yml ps` and inspect the service logs.",
  );
  error.diagnostics = diagnostics;
  throw error;
}

function localCapsuleDatabaseUrl(service: LooseRecord, port: number) {
  if (service.engine === "postgres") {
    return `postgres://${encodeURIComponent(service.user)}:${encodeURIComponent(service.password)}@127.0.0.1:${port}/${service.databaseName}`;
  }
  return `http://127.0.0.1:${port}`;
}

async function probeCapsuleDatabaseService(capsuleServices: CapsuleServicesModel, url: string | URL | Request) {
  if (capsuleServices.services.database.engine === "postgres") {
    return await probePostgresCapsuleDatabaseService(url);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      ok: response.status < 500,
      statusCode: response.status,
    };
  } catch (error) {
    const details = errorDetails(error);
    return {
      ok: false,
      message: details.name === "AbortError" ? "probe timed out" : details.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeCapsuleStorageService(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`${url}/minio/health/ready`, { signal: controller.signal });
    return {
      ok: response.status < 500,
      statusCode: response.status,
    };
  } catch (error) {
    const details = errorDetails(error);
    return {
      ok: false,
      message: details.name === "AbortError" ? "probe timed out" : details.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probePostgresCapsuleDatabaseService(url: any) {
  try {
    const client = await createPostgresConnection(url);
    try {
      await client.query("SELECT 1 AS ok");
      return { ok: true, statusCode: 200 };
    } finally {
      await client.close().catch(() => { });
    }
  } catch (error) {
    const details = errorDetails(error);
    return {
      ok: false,
      message: details.message,
    };
  }
}

function capsuleServiceReadinessTimeoutMs() {
  const raw = process.env.SPORADES_SERVICE_READINESS_TIMEOUT_MS;
  if (!raw) {
    return 30000;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 30000;
}

function capsuleServiceStatus(capsuleServices: CapsuleServicesModel, projectDir: any, serviceName: any) {
  const output = runDocker(
    ["compose", "-f", capsuleServices.path, "ps", "--format", "json", serviceName],
    projectDir,
    "Failed to inspect Capsule service readiness.",
    "Check Docker is running and supports `docker compose ps --format json`, then retry the command.",
  );
  const parsed = parseComposeJsonOutput(output);
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  return {
    state: String(record?.State ?? record?.state ?? "").toLowerCase(),
    health: record?.Health ? String(record.Health).toLowerCase() : null,
  };
}

function capsuleServicePort(capsuleServices: CapsuleServicesModel, projectDir: any, serviceName: any, targetPort: any, serviceKind = "database") {
  const output = runDocker(
    ["compose", "-f", capsuleServices.path, "port", serviceName, String(targetPort)],
    projectDir,
    "Failed to inspect Capsule service port.",
    "Check Docker is running and supports `docker compose port`, then retry the command.",
  );
  const match = output.match(/:(\d+)\s*$/);
  if (!match) {
    throw commandError(
      `Capsule ${serviceKind} service port was not published.`,
      "Restart Docker and rerun `sporades dev` so Compose can publish the local service port.",
    );
  }
  return Number(match[1]);
}

function parseComposeJsonOutput(output: string) {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed
      .split("\n")
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
  }
}

function ensureLocalBaseImage(cwd: any) {
  const inspect = spawnSync("docker", ["image", "inspect", SPORADES_BASE_IMAGE.image], { cwd, encoding: "utf8" });
  if (inspect.status === 0) {
    return;
  }

  const pull = spawnSync("docker", ["pull", SPORADES_BASE_IMAGE.image], { cwd, encoding: "utf8" });
  if (pull.status === 0) {
    return;
  }

  const dockerfilePath = path.join(CLI_ROOT, "Dockerfile.base");
  try {
    const stats = statSync(dockerfilePath);
    if (!stats.isFile()) {
      throw new Error("Dockerfile.base is not a file.");
    }
  } catch {
    throw commandError(
      "Unable to prepare the Sporades Base image.",
      `Check Docker can pull ${SPORADES_BASE_IMAGE.image}, then retry \`sporades deploy\`.`,
    );
  }

  const build = spawnSync("docker", ["build", "-f", dockerfilePath, "-t", SPORADES_BASE_IMAGE.image, CLI_ROOT], {
    cwd,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    throw commandError(
      "Unable to prepare the Sporades Base image.",
      "Check Docker is running and can build the local Sporades Base image, then retry `sporades deploy`.",
    );
  }
}

function runDockerCleanup(args: any[] | readonly string[], cwd: any, message: string, hint: string, force = false) {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  if (force && isMissingDockerContainerError(result)) {
    return "";
  }
  throw commandError(message, hint);
}

async function replaceContainerBinding(bindingPath: string, binding: LooseRecord) {
  const temporaryPath = `${bindingPath}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(binding, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, bindingPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function verifyContainerReplacementOwnership(
  binding: LooseRecord | null,
  consumer: Awaited<ReturnType<typeof readPublicTreeConsumer>>,
  expectedContainerName: string,
) {
  if (binding === null && consumer === null) return;
  const owned = Boolean(
    binding
    && consumer
    && typeof binding.containerId === "string"
    && binding.containerId.length > 0
    && binding.containerName === expectedContainerName
    && typeof binding.clientRelease?.consumerToken === "string"
    && binding.clientRelease.consumerToken === consumer.token
    && binding.clientRelease.publicTree === consumer.tree
    && binding.containerId === consumer.identity,
  );
  if (!owned) {
    throw commandError(
      "Container replacement ownership could not be verified.",
      "Preserve the current Container state and reconcile its binding and public-tree consumer before retrying deployment.",
    );
  }
}

async function acquireContainerLifecycleLock(projectDir: string) {
  const lockDir = path.join(projectDir, ".sporades", ".container-lifecycle-lock");
  await mkdir(path.dirname(lockDir), { recursive: true });
  const token = randomBytes(16).toString("hex");
  const ownerPath = path.join(lockDir, "owner.json");
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, processStart: await getProcessStartIdentity(process.pid), token })}\n`);
      return async () => {
        const owner = await readFile(ownerPath, "utf8").then(JSON.parse).catch(() => null);
        if (owner?.token !== token) throw commandError("Container lifecycle lock ownership changed.", "Preserve the successor lifecycle lock.");
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      const owner = await readFile(ownerPath, "utf8").then(JSON.parse).catch(() => null);
      if (owner === null) {
        const age = Date.now() - await lstat(lockDir).then((stats) => stats.mtimeMs).catch(() => Date.now());
        if (age <= 1_000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
      }
      const actualStart = Number.isInteger(owner?.pid) ? await getProcessStartIdentity(owner.pid) : null;
      const live = Boolean(
        owner
        && Number.isInteger(owner.pid)
        && owner.pid > 0
        && typeof owner.token === "string"
        && ((actualStart !== null && owner.processStart === actualStart) || (actualStart === null && processIsLiveForContainerLock(owner.pid))),
      );
      if (!live) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw commandError("Container lifecycle is busy.", "Retry after the other Container operation completes.");
}

function processIsLiveForContainerLock(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM"); }
}

function containerReplacementFault(event: "publication" | "consumer" | "binding" | "cleanup") {
  if (process.env.SPORADES_TEST_CONTAINER_REPLACEMENT_FAULT === event) {
    throw commandError(`Injected Container replacement ${event} failure.`, "Retry without the test fault.");
  }
}

function formatMount(mount: LooseRecord) {
  return `${mount.host}:${mount.container}${mount.mode ? `:${mount.mode}` : ""}`;
}

async function prepareRuntimeDataPath(targetPath: string) {
  let stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw commandError(
      "Container session data path contains a symbolic link.",
      `Remove the symbolic link at ${targetPath}, then retry \`sporades deploy\`.`,
    );
  }

  if (stats.isDirectory()) {
    await chmod(targetPath, 0o700);
    const entries = await readdir(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      await prepareRuntimeDataPath(path.join(targetPath, entry.name));
    }
    return;
  }

  if (stats.isFile()) {
    await chmod(targetPath, 0o600);
  }
}

function localContainerRuntimeUser() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (typeof uid === "number" && typeof gid === "number" && Number.isInteger(uid) && Number.isInteger(gid) && uid >= 0 && gid >= 0) {
    return `${uid}:${gid}`;
  }
  return baseImageRuntimeUser();
}

function isMissingDockerContainerError(result: SpawnSyncReturns<string>) {
  return /No such container/i.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
}

function writeJsonResponse(response: ServerResponse<IncomingMessage>, status: number, result: LooseRecord) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(result)}\n`);
}
