import { spawn, spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

import {
  CAPSULE_SERVICES_COMPOSE_FILE,
  CAPSULE_SERVICES_STATE_DIR,
  capsuleServicesComposeModel,
} from "../capsule-services.js";
import { bundleServerCapsuleModule } from "../bundle-pipeline.js";
import { schemaFromCapsuleDefinition } from "../server-runtime-source.js";
import type { LooseRecord } from "./cli-support.js";
import { commandError, errorDetails } from "./cli-support.js";
import {
  authorizedKeyFingerprint,
  readProjectConfig,
  resolveAuthorizedKeyLines,
  resolveEffectiveSecurityPolicy,
  validateProjectConfigShape,
} from "./project-config.js";

export const DOCTOR_SESSIONS = new Set(["dev", "public-dev", "container", "hosted"]);
export const DOCTOR_STATUSES = ["pass", "warn", "fail", "skip"] as const;
export const DOCTOR_SEVERITIES = ["info", "warning", "error"] as const;

export async function runDoctorChecks(options: LooseRecord) {
  const checks: LooseRecord[] = [
    {
      id: "doctor.command-surface",
      title: "Doctor command surface",
      scope: "project",
      status: "pass",
      severity: "info",
      message: "Doctor command parsed successfully.",
    },
  ];

  const project = await projectConfigCheck(options.projectDir);
  checks.push(project.check);
  if (!project.config) {
    return checks;
  }

  checks.push(await securityPolicyCheck(project.config, options));
  const publicDevCheck = await publicDevPostureCheck(options);
  if (publicDevCheck) {
    checks.push(publicDevCheck);
  }
  checks.push(await sshAuthorizedKeysCheck(project.config, options));

  const capsuleAuthoringCheck = await capsuleAuthoringAclPostureCheck(options);
  if (capsuleAuthoringCheck) {
    checks.push(capsuleAuthoringCheck);
  }

  if (options.session) {
    if (options.session === "dev" || options.session === "public-dev") {
      checks.push(...await devSessionChecks(options));
      checks.push(...await localCapsuleServiceChecks(project.config, options));
    } else if (options.session === "container") {
      checks.push(...await localContainerChecks(options));
      checks.push(...await localCapsuleServiceChecks(project.config, options));
    } else if (options.session === "hosted") {
      checks.push(...await hostedCapsuleDoctorChecks(options));
    } else {
      checks.push(sessionDoctorPlaceholderCheck(options));
    }
  }

  return checks;
}

async function projectConfigCheck(projectDir: string) {
  try {
    const config = await readProjectConfig(projectDir);
    validateProjectConfigShape(config);
    return {
      config,
      check: {
        id: "doctor.project-config",
        title: "Project configuration",
        scope: "project",
        status: "pass",
        severity: "info",
        message: "sporades.json is valid and uses supported project-level keys.",
      },
    };
  } catch (error) {
    const details = errorDetails(error);
    return {
      config: null,
      check: {
        id: "doctor.project-config",
        title: "Project configuration",
        scope: "project",
        status: "fail",
        severity: "error",
        message: details.message ?? "Invalid project configuration.",
        hint: details.hint ?? "Fix sporades.json and rerun `sporades doctor`.",
        ...(details.diagnostics ? { details: details.diagnostics } : {}),
      },
    };
  }
}

async function securityPolicyCheck(config: LooseRecord, options: LooseRecord) {
  const session = options.session ?? "dev";
  const securitySession = session === "public-dev" ? "public-dev" : session;
  const security = resolveEffectiveSecurityPolicy(config, securitySession);
  const warnings = securityPostureWarnings(security, securitySession);
  const warn = warnings.length > 0;
  return {
    id: "doctor.security-policy",
    title: "Capsule security policy",
    scope: doctorScope(session),
    status: warn ? "warn" : "pass",
    severity: warn ? "warning" : "info",
    message: warn
      ? `Effective ${securitySession} security policy has permissive choices: ${warnings.join("; ")}.`
      : `Effective ${securitySession} security policy resolved successfully.`,
    ...(warn
      ? {
          hint: securityPolicyHint(warnings),
        }
      : {}),
    details: {
      session: securitySession,
      security,
    },
  };
}

function securityPostureWarnings(security: LooseRecord, session: string) {
  if (session !== "container" && session !== "hosted") {
    return [];
  }

  const warnings: string[] = [];
  if (security.cors.allowedOrigins.includes("*")) {
    warnings.push("CORS allows every origin");
  }

  const permissiveDirectives = Object.entries(security.csp.directives)
    .filter(([, values]) => Array.isArray(values) && values.some((value) => value === "*" || value === "'unsafe-eval'"))
    .map(([name]) => name);
  if (permissiveDirectives.length > 0) {
    warnings.push(`CSP directives are broad (${permissiveDirectives.join(", ")})`);
    if (security.csp.mode !== "enforce") {
      warnings.push("CSP is report-only while permissive directives are configured");
    }
  }
  return warnings;
}

function securityPolicyHint(warnings: string[]) {
  const hints = [];
  if (warnings.some((warning) => warning.includes("CORS"))) {
    hints.push("Restrict security.cors.allowedOrigins to trusted origins instead of `*`.");
  }
  if (warnings.some((warning) => warning.includes("CSP"))) {
    hints.push("Tighten security.csp.directives and use security.csp.mode `enforce` when the policy is ready.");
  }
  return hints.join(" ");
}

async function publicDevPostureCheck(options: LooseRecord) {
  const runningPublicDev = await readRunningPublicDevSession(options.projectDir);
  const devSessionRequested = options.session === "dev" || options.session === "public-dev";
  if (!devSessionRequested && !runningPublicDev) {
    return null;
  }
  const warn = options.session === "public-dev" || runningPublicDev;

  return {
    id: "doctor.public-dev-posture",
    title: "Public Dev posture",
    scope: "dev",
    status: warn ? "warn" : "pass",
    severity: warn ? "warning" : "info",
    message: warn
      ? (options.session === "public-dev"
        ? "Doctor is targeting Public Dev session posture."
        : "A running Dev session appears to be public.")
      : "Dev session posture is local-only; Public Dev is not active.",
    ...(warn
      ? { hint: "Use Public Dev sessions only for temporary demos, device testing, or tunnels, and return to `sporades dev` when finished." }
      : {}),
    commands: ["sporades dev status"],
    details: {
      requestedPublicDev: options.session === "public-dev",
      runningPublicDev,
    },
  };
}

async function readRunningPublicDevSession(projectDir: string) {
  try {
    const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
    return Boolean(session.publicDev || session.public || session.security?.cors?.publicDev);
  } catch {
    return false;
  }
}

async function sshAuthorizedKeysCheck(config: LooseRecord, options: LooseRecord) {
  const command = await sshFollowUpCommand(options);
  try {
    const lines = await resolveAuthorizedKeyLines(config.ssh, options.projectDir);
    const sshConfigured = Object.hasOwn(config, "ssh");
    const emptyConfiguredSsh = sshConfigured && lines.length === 0;
    return {
      id: "doctor.ssh-authorized-keys",
      title: "SSH authorized keys",
      scope: "project",
      status: emptyConfiguredSsh ? "warn" : "pass",
      severity: emptyConfiguredSsh ? "warning" : "info",
      message: emptyConfiguredSsh
        ? "ssh.authorizedKeys resolves to no effective authorized keys, so Container SSH access is disabled."
        : lines.length > 0
          ? `SSH authorized keys are valid (${lines.length} effective key${lines.length === 1 ? "" : "s"}).`
          : "No SSH block is configured; Container SSH access remains disabled.",
      ...(emptyConfiguredSsh
        ? {
            hint: `Add public keys to \`ssh.authorizedKeys\`, or remove the empty \`ssh\` block. Inspect effective SSH state with \`${command}\`.`,
          }
        : {
            hint: `Inspect effective SSH state with \`${command}\`.`,
          }),
      commands: [command],
      details: {
        configured: sshConfigured,
        keyCount: lines.length,
        fingerprints: lines.map(authorizedKeyFingerprint),
      },
    };
  } catch (error) {
    const details = errorDetails(error);
    return {
      id: "doctor.ssh-authorized-keys",
      title: "SSH authorized keys",
      scope: "project",
      status: "fail",
      severity: "error",
      message: details.message ?? "Invalid SSH authorized keys configuration.",
      hint: `${details.hint ?? "Fix ssh.authorizedKeys in sporades.json."} Inspect effective SSH state with \`${command}\`.`,
      commands: [command],
    };
  }
}

async function sshFollowUpCommand(options: LooseRecord) {
  if (options.session === "hosted") {
    const binding = await readDoctorRemoteBinding(options.projectDir);
    const alias = options.host ?? binding?.hostAlias ?? "<alias>";
    const subname = options.subname ?? binding?.subname ?? "<subname>";
    return `sporades host ssh ${subname} --host ${alias}`;
  }
  return "sporades deploy ssh";
}

async function capsuleAuthoringAclPostureCheck(options: LooseRecord) {
  const projectDir = typeof options.projectDir === "string" ? options.projectDir : process.cwd();
  const serverEntry = path.join(projectDir, "server", "index.ts");

  try {
    const serverSource = await readFile(serverEntry, "utf8");
    const serverModuleSource = await bundleServerCapsuleModule({
      serverSource,
      serverSourcePath: serverEntry,
    });
    const definition = await loadBundledCapsuleDefinition(serverModuleSource);
    return capsuleAclDeclarationCheck(definition, schemaFromCapsuleDefinition(definition));
  } catch (error) {
    return capsuleMetadataLoadFailureCheck(error);
  }
}

async function loadBundledCapsuleDefinition(serverModuleSource: string) {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(serverModuleSource, "utf8").toString("base64")}#${Date.now()}`;
  const capsuleModule = await import(moduleUrl);
  if (!capsuleModule.default) {
    throw commandError(
      "Capsule server entry did not export a default Capsule definition.",
      "Fix server/index.ts so it uses `export default capsule({ schema: { ... } })`, then rerun `sporades doctor`.",
    );
  }
  return capsuleModule.default;
}

function capsuleAclDeclarationCheck(definition: LooseRecord, normalizedSchema: LooseRecord) {
  const schema = definition?.schema ?? {};
  const tables = Object.entries(schema)
    .filter(([, table]) => isAppTableDeclaration(table))
    .map(([name, table]) => tableAclPosture(name, table as LooseRecord))
    .filter((table) => table.missing.length > 0);

  if (tables.length === 0) {
    return {
      id: "doctor.capsule-authoring.acl-posture",
      title: "Capsule app table ACL posture",
      scope: "project",
      status: "pass",
      severity: "info",
      message: "Capsule app table declarations include read and write ACL rules where table metadata is available.",
      details: {
        tableCount: Array.isArray(normalizedSchema.tables) ? normalizedSchema.tables.length : 0,
        inspectedResource: "app-tables",
      },
    };
  }

  return {
    id: "doctor.capsule-authoring.acl-posture",
    title: "Capsule app table ACL posture",
    scope: "project",
    status: "warn",
    severity: "warning",
    message:
      "Some Capsule app tables are missing ACL declarations; missing ACLs are allow-by-default and not deny-by-default today.",
    hint:
      "Add .acl({ read, write }) to app table declarations that should restrict reads or writes. Doctor only inspects declarations and does not evaluate ACL policy outcomes against live user data.",
    details: {
      inspectedResource: "app-tables",
      tables,
    },
  };
}

function isAppTableDeclaration(table: unknown): table is LooseRecord {
  return Boolean(table && typeof table === "object" && !Array.isArray(table) && (table as LooseRecord).kind === "table");
}

function tableAclPosture(name: string, table: LooseRecord) {
  const aclRules = table.aclRules;
  if (aclRules === undefined) {
    return {
      name,
      missing: ["declaration", "read", "write"],
    };
  }
  if (!aclRules || typeof aclRules !== "object" || Array.isArray(aclRules)) {
    return {
      name,
      missing: ["read", "write"],
    };
  }
  const missing = [];
  if (typeof aclRules.read !== "function") {
    missing.push("read");
  }
  if (typeof aclRules.write !== "function") {
    missing.push("write");
  }
  return { name, missing };
}

function capsuleMetadataLoadFailureCheck(error: unknown) {
  const details = errorDetails(error);
  return {
    id: "doctor.capsule-authoring.metadata-load",
    title: "Capsule schema metadata",
    scope: "project",
    status: "fail",
    severity: "error",
    message: `Capsule schema metadata could not be loaded: ${details.message ?? "unknown error"}.`,
    hint:
      details.hint ??
      "Fix server/index.ts so Sporades can bundle and load the Capsule definition, then rerun `sporades doctor`.",
  };
}

function doctorScope(session: string) {
  return session === "public-dev" ? "dev" : session;
}

async function hostedCapsuleDoctorChecks(options: LooseRecord) {
  const target = await resolveHostedDoctorTarget(options);
  if (!target.ok) {
    return [target.check];
  }

  options.host = target.alias;
  options.subname = target.subname;
  const commands = hostedCommands(target.alias, target.subname);
  const checks: LooseRecord[] = [target.check];

  const [hostHealth, list, runtimeHealth, hostStats, capsuleStats, ssh] = await Promise.all([
    runHostJsonCommand(["host", "health", "--host", target.alias, "--json"], options.projectDir),
    runHostJsonCommand(["host", "list", "--host", target.alias, "--json"], options.projectDir),
    runHostJsonCommand(["host", "health", target.subname, "--host", target.alias, "--json"], options.projectDir),
    runHostJsonCommand(["host", "stats", "--host", target.alias, "--json"], options.projectDir),
    runHostJsonCommand(["host", "stats", target.subname, "--host", target.alias, "--json"], options.projectDir),
    runHostJsonCommand(["host", "ssh", target.subname, "--host", target.alias, "--json"], options.projectDir),
  ]);

  checks.push(hostHealthCheck(hostHealth, commands));
  const capsule = hostedCapsuleFromList(list, target.subname);
  checks.push(hostedRegistryCheck(list, capsule, commands));
  if (!capsule) {
    return checks;
  }
  checks.push(hostedReleaseCheck(capsule, commands));
  checks.push(hostedRuntimeHealthCheck(runtimeHealth, commands));
  checks.push(hostedStatsCheck(hostStats, capsuleStats, commands));
  checks.push(hostedSealedServerEnvCheck(capsule, commands));
  checks.push(hostedSshStateCheck(ssh, commands));
  return checks;
}

async function resolveHostedDoctorTarget(options: LooseRecord) {
  const binding = await readDoctorRemoteBinding(options.projectDir);
  const alias = options.host ?? binding?.hostAlias ?? null;
  const subname = options.subname ?? binding?.subname ?? null;
  if (!alias || !subname) {
    return {
      ok: false,
      check: {
        id: "doctor.hosted.target",
        title: "Hosted Capsule target",
        scope: "hosted",
        status: "fail",
        severity: "error",
        message: "No Hosted Capsule binding could be resolved for doctor.",
        hint: "Pass `--host <alias> --subname <name>`, bind this project to a Hosted Capsule, or register one first.",
        commands: ["sporades host bind <subname> --host <alias>", "sporades host register <subname> --host <alias>"],
        details: {
          hostProvided: Boolean(options.host),
          subnameProvided: Boolean(options.subname),
          remoteBindingFound: Boolean(binding),
        },
      },
    };
  }

  const current = await runHostJsonCommand(["host", "current", "--host", alias, "--json"], options.projectDir);
  if (!current.ok) {
    const message = current.error?.message ?? "Host profile could not be resolved.";
    const unknown = message.match(/^Unknown Host profile alias: (.+)$/);
    return {
      ok: false,
      check: {
        id: "doctor.hosted.target",
        title: "Hosted Capsule target",
        scope: "hosted",
        status: "fail",
        severity: "error",
        message,
        hint: current.error?.hint ?? "Add or select a Host profile, then rerun `sporades doctor --session hosted`.",
        commands: unknown
          ? [`sporades host add ${unknown[1]} --server <ssh-target> --domain <hosted-domain>`]
          : ["sporades host current --json", "sporades host add <alias> --server <ssh-target> --domain <hosted-domain>"],
        details: { alias, subname },
      },
    };
  }

  const resolvedAlias = current.data?.alias ?? alias;
  return {
    ok: true,
    alias: resolvedAlias,
    subname,
    check: {
      id: "doctor.hosted.target",
      title: "Hosted Capsule target",
      scope: "hosted",
      status: "pass",
      severity: "info",
      message: `Hosted Capsule target resolved as ${subname} on Host profile ${resolvedAlias}.`,
      details: {
        alias: resolvedAlias,
        subname,
        fromRemoteBinding: !options.host || !options.subname,
        hostedUrl: current.data?.profile?.domain ? `${current.data.profile.scheme ?? "https"}://${subname}.${current.data.profile.domain}` : null,
      },
    },
  };
}

async function readDoctorRemoteBinding(projectDir: string) {
  try {
    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "remote-binding.json"), "utf8"));
    return binding && typeof binding === "object" && !Array.isArray(binding) ? binding : null;
  } catch {
    return null;
  }
}

function hostedCommands(alias: string, subname: string) {
  return {
    hostHealth: `sporades host health --host ${alias}`,
    capsuleHealth: `sporades host health ${subname} --host ${alias}`,
    hostStats: `sporades host stats --host ${alias}`,
    capsuleStats: `sporades host stats ${subname} --host ${alias}`,
    hostLogs: `sporades host logs stdout --host ${alias} --subname ${subname}`,
    hostSsh: `sporades host ssh ${subname} --host ${alias}`,
    hostList: `sporades host list --host ${alias}`,
    hostRegister: `sporades host register ${subname} --host ${alias}`,
    hostPushVerify: `sporades host push --host ${alias} --subname ${subname} --verify`,
  };
}

function hostHealthCheck(result: LooseRecord, commands: LooseRecord) {
  if (result.ok) {
    return {
      id: "doctor.hosted.host-health",
      title: "Host server health",
      scope: "hosted",
      status: "pass",
      severity: "info",
      message: "Host server health route responded successfully.",
      commands: [commands.hostHealth],
      details: { healthUrl: result.data?.healthUrl ?? null, response: result.data?.response ?? null },
    };
  }
  return {
    id: "doctor.hosted.host-health",
    title: "Host server health",
    scope: "hosted",
    status: "warn",
    severity: "warning",
    message: result.error?.message ?? "Host server health could not be verified.",
    hint: result.error?.hint ?? "Check Host server reachability and retry the health command.",
    commands: [commands.hostHealth],
    details: result.data ?? null,
  };
}

function hostedCapsuleFromList(result: LooseRecord, subname: string) {
  const capsules = Array.isArray(result.data?.capsules) ? result.data.capsules : [];
  return capsules.find((capsule: LooseRecord) => capsule?.subname === subname) ?? null;
}

function hostedRegistryCheck(result: LooseRecord, capsule: LooseRecord | null, commands: LooseRecord) {
  if (!result.ok) {
    return {
      id: "doctor.hosted.registry",
      title: "Hosted Capsule registry",
      scope: "hosted",
      status: "fail",
      severity: "error",
      message: result.error?.message ?? "Hosted Capsule registry state could not be read.",
      hint: result.error?.hint ?? "Retry Host registry inspection.",
      commands: [commands.hostList],
      details: result.data ?? null,
    };
  }
  if (!capsule) {
    return {
      id: "doctor.hosted.registry",
      title: "Hosted Capsule registry",
      scope: "hosted",
      status: "fail",
      severity: "error",
      message: "Hosted Capsule is not present in the Host server registry.",
      hint: "Register the Hosted Capsule on the selected Host profile, or choose the correct Host profile and Capsule subname.",
      commands: [commands.hostList, commands.hostRegister],
    };
  }
  const status = String(capsule.registry?.status ?? "registered");
  const stopped = status === "stopped" || capsule.docker?.running === false;
  return {
    id: "doctor.hosted.registry",
    title: "Hosted Capsule registry",
    scope: "hosted",
    status: stopped ? "warn" : "pass",
    severity: stopped ? "warning" : "info",
    message: stopped
      ? `Hosted Capsule registry or container state is stopped (${status}).`
      : `Hosted Capsule registry state is ${status}.`,
    ...(stopped ? { hint: `Inspect logs, then start or push a verified release if needed.` } : {}),
    commands: stopped ? [commands.hostStats, commands.hostLogs, commands.hostPushVerify] : [commands.hostList],
    details: {
      registry: capsule.registry ?? null,
      docker: capsule.docker ?? null,
    },
  };
}

function hostedReleaseCheck(capsule: LooseRecord, commands: LooseRecord) {
  const release = capsule.currentRelease;
  if (!release?.id) {
    return {
      id: "doctor.hosted.release",
      title: "Hosted Capsule current release",
      scope: "hosted",
      status: "fail",
      severity: "error",
      message: "Hosted Capsule has no current release recorded.",
      hint: "Push a release with verification so the Host registry records current release metadata.",
      commands: [commands.hostPushVerify],
      details: { currentRelease: release ?? null },
    };
  }
  return {
    id: "doctor.hosted.release",
    title: "Hosted Capsule current release",
    scope: "hosted",
    status: "pass",
    severity: "info",
    message: `Current release metadata is available (${release.id}).`,
    commands: [commands.hostPushVerify],
    details: {
      id: release.id,
      sealedServerEnv: release.sealedServerEnv ?? null,
      baseImage: release.baseImage ?? capsule.baseImage ?? null,
    },
  };
}

function hostedRuntimeHealthCheck(result: LooseRecord, commands: LooseRecord) {
  if (result.ok) {
    return {
      id: "doctor.hosted.runtime-health",
      title: "Hosted Capsule health",
      scope: "hosted",
      status: "pass",
      severity: "info",
      message: "Hosted Capsule runtime health checks passed.",
      commands: [commands.capsuleHealth],
      details: {
        route: result.data?.route ?? null,
        container: result.data?.container ?? null,
        runtime: result.data?.runtime ?? null,
      },
    };
  }
  const failure = String(result.data?.failure ?? "");
  const routeMismatch = failure.includes("route") || failure.includes("container");
  const unavailable = failure.includes("unavailable");
  return {
    id: "doctor.hosted.runtime-health",
    title: "Hosted Capsule health",
    scope: "hosted",
    status: "warn",
    severity: "warning",
    message: routeMismatch
      ? "Hosted Capsule route and container state appear mismatched."
      : unavailable
        ? "Hosted Capsule is returning the Host unavailable response state."
        : result.error?.message ?? "Hosted Capsule runtime health check failed.",
    hint: result.error?.hint ?? "Inspect Hosted Capsule logs and retry health.",
    commands: [commands.capsuleHealth, commands.hostLogs, commands.hostPushVerify],
    details: result.data ?? null,
  };
}

function hostedStatsCheck(hostStats: LooseRecord, capsuleStats: LooseRecord, commands: LooseRecord) {
  const ok = Boolean(hostStats.ok && capsuleStats.ok);
  return {
    id: "doctor.hosted.stats",
    title: "Hosted Capsule resource stats",
    scope: "hosted",
    status: ok ? "pass" : "warn",
    severity: ok ? "info" : "warning",
    message: ok
      ? "Host and Hosted Capsule resource stats are available."
      : "One or more Host resource stat surfaces are unavailable.",
    ...(ok ? {} : { hint: capsuleStats.error?.hint ?? hostStats.error?.hint ?? "Check Docker on the Host server and retry stats." }),
    commands: [commands.hostStats, commands.capsuleStats],
    details: {
      hostStatsAvailable: Boolean(hostStats.ok),
      capsuleStatsAvailable: Boolean(capsuleStats.ok),
      capsule: capsuleStats.data?.capsule ?? null,
      lifecycle: capsuleStats.data?.lifecycle ?? null,
    },
  };
}

function hostedSealedServerEnvCheck(capsule: LooseRecord, commands: LooseRecord) {
  const releaseFingerprint = capsule.currentRelease?.sealedServerEnv?.publicKeyFingerprint ?? null;
  const currentFingerprint = capsule.sealedServerEnv?.publicKeyFingerprint ?? capsule.registry?.sealedServerEnv?.currentKeyFingerprint ?? null;
  const inspectedFingerprint = capsule.sealedServerEnv?.publicKeyFingerprint ?? null;
  const publicKeyAvailable = capsule.sealedServerEnv?.publicKeyAvailable ?? null;
  const privateKeyAvailable = capsule.sealedServerEnv?.privateKeyAvailable ?? null;
  const mismatch = Boolean(releaseFingerprint && releaseFingerprint !== currentFingerprint);
  const missingHostKeyMaterial = Boolean(
    capsule.sealedServerEnv?.status === "missing-key-material" || publicKeyAvailable === false || privateKeyAvailable === false,
  );
  const releaseKeyUnavailable = Boolean(missingHostKeyMaterial && releaseFingerprint && inspectedFingerprint === releaseFingerprint);
  const currentKeyUnavailable = Boolean(missingHostKeyMaterial && (!releaseKeyUnavailable || !releaseFingerprint));
  const unavailable = releaseKeyUnavailable || currentKeyUnavailable;
  return {
    id: "doctor.hosted.sealed-server-env",
    title: "Hosted Capsule Sealed Server env fingerprints",
    scope: "hosted",
    status: unavailable ? "warn" : "pass",
    severity: unavailable ? "warning" : "info",
    message: unavailable
      ? releaseKeyUnavailable
        ? `Release metadata references sealed-env key fingerprint ${releaseFingerprint}, but matching Host key material is unavailable.`
        : releaseFingerprint && currentFingerprint && releaseFingerprint !== currentFingerprint
          ? `Current Host sealed-env key fingerprint ${currentFingerprint} is unavailable; current release metadata references ${releaseFingerprint}, so doctor cannot infer that release key material is unavailable from this inspection signal.`
          : `Host sealed-env key fingerprint ${currentFingerprint} is unavailable.`
      : mismatch
        ? `Release sealed-env key fingerprint ${releaseFingerprint} differs from the current Host key fingerprint ${currentFingerprint}; this can be a healthy rotated-key state when old release keys are retained.`
        : releaseFingerprint
        ? `Release sealed-env key fingerprint ${releaseFingerprint} is available on the Host.`
        : "Current release metadata does not reference a Sealed Server env key fingerprint.",
    ...(unavailable ? { hint: "Re-key and re-seal from source values, then push a verified release." } : {}),
    commands: [commands.hostPushVerify],
    details: {
      releasePublicKeyFingerprint: releaseFingerprint,
      hostPublicKeyFingerprint: currentFingerprint,
      inspectedHostKeyFingerprint: inspectedFingerprint,
      publicKeyAvailable,
      privateKeyAvailable,
    },
  };
}

function hostedSshStateCheck(result: LooseRecord, commands: LooseRecord) {
  if (!result.ok) {
    return {
      id: "doctor.hosted.ssh",
      title: "Hosted Capsule SSH state",
      scope: "hosted",
      status: "warn",
      severity: "warning",
      message: result.error?.message ?? "Hosted Capsule SSH state could not be inspected.",
      hint: result.error?.hint ?? "Retry SSH inspection.",
      commands: [commands.hostSsh],
      details: result.data ?? null,
    };
  }
  const data = result.data ?? {};
  const enabled = Boolean(data.enabled);
  const ready = enabled && data.running && data.host && data.port;
  return {
    id: "doctor.hosted.ssh",
    title: "Hosted Capsule SSH state",
    scope: "hosted",
    status: ready ? "pass" : "warn",
    severity: ready ? "info" : "warning",
    message: ready
      ? "Hosted Capsule SSH inspection reports an effective loopback SSH state."
      : `Hosted Capsule SSH is unavailable (${data.reason ?? "unknown"}).`,
    hint: ready
      ? "Use SSH only as a compatibility and emergency access path; prefer structured Sporades commands for normal inspection."
      : `Inspect effective SSH state with \`${commands.hostSsh}\`.`,
    commands: [commands.hostSsh],
    details: {
      enabled,
      running: Boolean(data.running),
      reason: data.reason ?? null,
      host: data.host ?? null,
      port: data.port ?? null,
      user: data.user ?? null,
      keyCount: data.keyCount ?? 0,
      fingerprints: Array.isArray(data.fingerprints) ? data.fingerprints : [],
    },
  };
}

async function runHostJsonCommand(args: string[], projectDir: string) {
  return new Promise<LooseRecord>((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], ...args], {
      cwd: projectDir,
      env: process.env,
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
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch {
        resolve({
          ok: false,
          data: { code, stderr: stderr.trim() },
          error: {
            message: "Host command returned invalid JSON.",
            hint: "Retry the underlying Host command with `--json`.",
          },
        });
      }
    });
  });
}

async function devSessionChecks(options: LooseRecord) {
  const session = await readOptionalJsonFile(path.join(options.projectDir, ".sporades", "dev-session.json"));
  if (!session) {
    return [
      {
        id: "doctor.dev.binding",
        title: "Dev session binding",
        scope: "dev",
        status: "skip",
        severity: "info",
        message: "No Dev session binding was found in the Runtime directory.",
        hint: "Run `sporades dev status` to inspect Dev session state, or start one with `sporades dev`.",
        commands: ["sporades dev status"],
        details: {
          bindingPath: path.join(".sporades", "dev-session.json"),
          exists: false,
        },
      },
      {
        id: "doctor.dev.port-reachability",
        title: "Dev session port reachability",
        scope: "dev",
        status: "skip",
        severity: "info",
        message: "Port reachability was not checked because no Dev session binding was found.",
        commands: ["sporades dev status"],
      },
    ];
  }

  const port = Number(session.port);
  const bindingValid = Number.isInteger(port) && port > 0;
  const reachable = bindingValid ? await isTcpPortReachable("127.0.0.1", port) : false;
  return [
    {
      id: "doctor.dev.binding",
      title: "Dev session binding",
      scope: "dev",
      status: bindingValid ? "pass" : "warn",
      severity: bindingValid ? "info" : "warning",
      message: bindingValid
        ? `Dev session binding points to ${session.url ?? `http://localhost:${port}`}.`
        : "Dev session binding exists but does not include a valid port.",
      hint: bindingValid ? "Inspect live Dev state with `sporades dev status`." : "Restart the Dev session with `sporades dev`.",
      commands: ["sporades dev status"],
      details: {
        bindingPath: path.join(".sporades", "dev-session.json"),
        exists: true,
        port: bindingValid ? port : null,
        pid: session.pid ?? null,
        publicDev: Boolean(session.publicDev),
      },
    },
    {
      id: "doctor.dev.port-reachability",
      title: "Dev session port reachability",
      scope: "dev",
      status: reachable ? "pass" : "warn",
      severity: reachable ? "info" : "warning",
      message: reachable
        ? `Dev session port ${port} is reachable on loopback.`
        : `Dev session binding points to port ${bindingValid ? port : "unknown"}, but loopback connection failed.`,
      hint: reachable
        ? "Inspect live Dev state with `sporades dev status`."
        : "Run `sporades dev status`; if the session is stale, restart it with `sporades dev`.",
      commands: ["sporades dev status"],
      details: {
        host: "127.0.0.1",
        port: bindingValid ? port : null,
        reachable,
      },
    },
  ];
}

async function localContainerChecks(options: LooseRecord) {
  const bindingPath = path.join(options.projectDir, ".sporades", "binding.json");
  const binding = await readOptionalJsonFile(bindingPath);
  if (!binding?.containerId) {
    return [
      {
        id: "doctor.container.binding",
        title: "Container session binding",
        scope: "container",
        status: "skip",
        severity: "info",
        message: "No local Container binding was found in the Runtime directory.",
        hint: "Run `sporades deploy status` to inspect local Container session state, or start one with `sporades deploy`.",
        commands: ["sporades deploy status"],
        details: {
          bindingPath: path.join(".sporades", "binding.json"),
          exists: false,
        },
      },
    ];
  }

  const checks: LooseRecord[] = [
    {
      id: "doctor.container.binding",
      title: "Container session binding",
      scope: "container",
      status: "pass",
      severity: "info",
      message: `Container binding points to ${binding.containerName ?? binding.containerId}.`,
      hint: "Inspect local Container state with `sporades deploy status`.",
      commands: ["sporades deploy status"],
      details: {
        bindingPath: path.join(".sporades", "binding.json"),
        exists: true,
        containerId: binding.containerId,
        containerName: binding.containerName ?? null,
      },
    },
  ];
  const docker = dockerAvailabilityCheck("container", true);
  checks.push(docker);
  if (docker.status === "fail" || docker.status === "skip") {
    return checks;
  }

  const inspected = inspectDockerJson(["inspect", "--format", "{{json .}}", binding.containerId], options.projectDir);
  if (!inspected.ok) {
    checks.push({
      id: "doctor.container.running-state",
      title: "Container running state",
      scope: "container",
      status: "fail",
      severity: "error",
      message: "The Container binding is stale or Docker could not inspect the bound container.",
      hint: "Run `sporades deploy status`. If the bound container was removed, use `sporades deploy reset` before deploying again.",
      commands: ["sporades deploy status", "sporades deploy reset"],
      details: {
        containerId: binding.containerId,
        error: inspected.error,
      },
    });
    return checks;
  }

  const container = inspected.value;
  const running = Boolean(container?.State?.Running);
  checks.push({
    id: "doctor.container.running-state",
    title: "Container running state",
    scope: "container",
    status: running ? "pass" : "warn",
    severity: running ? "info" : "warning",
    message: running ? "The bound local Container is running." : "The bound local Container is not running.",
    hint: running ? "Inspect local Container state with `sporades deploy status`." : "Restart it with `sporades deploy restart`.",
    commands: running ? ["sporades deploy status"] : ["sporades deploy status", "sporades deploy restart"],
    details: {
      containerId: binding.containerId,
      running,
      state: container?.State ?? null,
    },
  });
  checks.push(containerRuntimePolicyCheck(container));
  return checks;
}

function containerRuntimePolicyCheck(container: LooseRecord) {
  const labels = container?.Config?.Labels ?? {};
  const mounts = containerInspectMounts(container);
  const ports = container?.NetworkSettings?.Ports ?? {};
  const baseImageLabels = {
    name: labels["com.sporades.base-image.name"] ?? null,
    version: labels["com.sporades.base-image.version"] ?? null,
    updatePolicy: labels["com.sporades.base-image.update-policy"] ?? null,
  };
  const readOnlyReleaseMounts = ["/app/server.mjs", "/app/client.js", "/app/index.html", "/app/sporades.json"].every((target) => {
    const mount = mounts.find((candidate: LooseRecord) => candidate.Target === target || candidate.Destination === target);
    return Boolean(mount && mountIsReadOnly(mount));
  });
  const dataMount = mounts.find((candidate: LooseRecord) => candidate.Target === "/app/data" || candidate.Destination === "/app/data");
  const writableDataMount = Boolean(dataMount && !mountIsReadOnly(dataMount));
  const loopbackOnlyPublishedPorts = Object.values(ports).every((entries) =>
    !Array.isArray(entries) || entries.length === 0 || entries.every((entry) => entry?.HostIp === "127.0.0.1"),
  );
  const ok = Boolean(
    baseImageLabels.name &&
    baseImageLabels.version &&
    baseImageLabels.updatePolicy &&
    container?.Config?.User &&
    container?.HostConfig?.ReadonlyRootfs === true &&
    readOnlyReleaseMounts &&
    writableDataMount &&
    container?.HostConfig?.RestartPolicy?.Name &&
    loopbackOnlyPublishedPorts,
  );
  return {
    id: "doctor.container.runtime-policy",
    title: "Container runtime policy",
    scope: "container",
    status: ok ? "pass" : "warn",
    severity: ok ? "info" : "warning",
    message: ok
      ? "Container runtime hardening and Base image metadata are visible."
      : "Some Container runtime hardening or Base image metadata is missing from Docker inspection.",
    hint: ok
      ? "Inspect Container details with `sporades deploy status` or SSH state with `sporades deploy ssh`."
      : "Run `sporades deploy status`; if runtime state is stale, use `sporades deploy restart` or `sporades deploy reset`.",
    commands: ok
      ? ["sporades deploy status", "sporades deploy ssh"]
      : ["sporades deploy status", "sporades deploy restart", "sporades deploy reset", "sporades deploy ssh"],
    details: {
      baseImageLabels,
      runtimeUser: container?.Config?.User ?? null,
      readOnlyRootFilesystem: container?.HostConfig?.ReadonlyRootfs === true,
      readOnlyReleaseMounts,
      writableDataMount,
      restartPolicy: container?.HostConfig?.RestartPolicy?.Name ?? null,
      loopbackOnlyPublishedPorts,
      ports,
    },
  };
}

function containerInspectMounts(container: LooseRecord) {
  if (Array.isArray(container?.Mounts)) {
    return container.Mounts;
  }
  if (Array.isArray(container?.HostConfig?.Mounts)) {
    return container.HostConfig.Mounts;
  }
  return [];
}

function mountIsReadOnly(mount: LooseRecord) {
  if (mount.ReadOnly === true || mount.RW === false) {
    return true;
  }
  if (typeof mount.Mode === "string") {
    return mount.Mode.split(",").includes("ro");
  }
  return false;
}

async function localCapsuleServiceChecks(config: LooseRecord, options: LooseRecord) {
  const capsuleServices = localCapsuleServicesFromConfig(config, options.projectDir);
  if (!capsuleServices) {
    return [
      {
        id: "doctor.services.declarations",
        title: "Capsule service declarations",
        scope: doctorScope(options.session),
        status: "skip",
        severity: "info",
        message: "No Capsule services are declared in sporades.json.",
        hint: "Declare services in sporades.json when this Capsule needs local runtime companions.",
        commands: ["sporades deploy status"],
        details: {
          declared: false,
          services: {},
        },
      },
    ];
  }

  const checks: LooseRecord[] = [
    {
      id: "doctor.services.declarations",
      title: "Capsule service declarations",
      scope: doctorScope(options.session),
      status: "pass",
      severity: "info",
      message: `Capsule services are declared: ${Object.keys(capsuleServices.services).join(", ")}.`,
      commands: ["sporades deploy status"],
      details: {
        declared: true,
        services: Object.fromEntries(
          Object.entries(capsuleServices.services).map(([name, service]) => [
            name,
            {
              kind: service.kind,
              engine: service.engine,
              containerName: service.name,
              targetPort: service.targetPort,
            },
          ]),
        ),
      },
    },
  ];
  const docker = dockerAvailabilityCheck(doctorScope(options.session), options.session === "container", "services");
  checks.push(docker);
  const compose = docker.status === "pass"
    ? dockerComposeAvailabilityCheck(doctorScope(options.session), options.session === "container")
    : docker;
  if (docker.status === "pass") {
    checks.push(compose);
  }
  checks.push(await generatedComposeCheck(capsuleServices, options.projectDir, doctorScope(options.session)));
  if (docker.status !== "pass" || compose.status !== "pass") {
    return checks;
  }
  checks.push(await capsuleServicesRuntimeStateCheck(capsuleServices, options.projectDir, doctorScope(options.session)));
  return checks;
}

function localCapsuleServicesFromConfig(config: LooseRecord, projectDir: string) {
  if (!config.services?.database && !config.services?.storage) {
    return null;
  }
  return {
    path: path.join(projectDir, CAPSULE_SERVICES_COMPOSE_FILE),
    relativePath: CAPSULE_SERVICES_COMPOSE_FILE,
    ...capsuleServicesComposeModel(config, projectDir),
  };
}

async function generatedComposeCheck(capsuleServices: LooseRecord, projectDir: string, scope: string) {
  const composePath = path.join(projectDir, CAPSULE_SERVICES_COMPOSE_FILE);
  let raw = "";
  try {
    raw = await readFile(composePath, "utf8");
  } catch (error) {
    if (errorDetails(error).code !== "ENOENT") {
      throw error;
    }
  }
  const missingServices = (Object.values(capsuleServices.services) as LooseRecord[])
    .filter((service: LooseRecord) => !raw.includes(service.name))
    .map((service: LooseRecord) => service.name);
  const exists = raw.length > 0;
  const ok = exists && missingServices.length === 0;
  return {
    id: "doctor.services.generated-compose",
    title: "Capsule services generated Compose state",
    scope,
    status: ok ? "pass" : "warn",
    severity: ok ? "info" : "warning",
    message: ok
      ? "Generated Capsule services Compose file matches declared service names."
      : exists
        ? "Generated Capsule services Compose file appears stale for current sporades.json declarations."
        : "Generated Capsule services Compose file is missing for declared services.",
    hint: "Run `sporades deploy status`; use `sporades deploy restart` or `sporades deploy reset` if Runtime directory state is stale.",
    commands: ["sporades deploy status", "sporades deploy restart", "sporades deploy reset"],
    details: {
      composeFile: CAPSULE_SERVICES_COMPOSE_FILE,
      exists,
      missingServices,
    },
  };
}

async function capsuleServicesRuntimeStateCheck(capsuleServices: LooseRecord, projectDir: string, scope: string) {
  const services: LooseRecord = {};
  const diagnostics: LooseRecord[] = [];
  const networkExists = dockerStatus(["network", "inspect", capsuleServices.networks.services], projectDir) === 0;
  for (const [name, service] of Object.entries(capsuleServices.services) as Array<[string, LooseRecord]>) {
    const runtime = inspectComposeService(capsuleServices.path, service.name, projectDir);
    const port = inspectComposeServicePort(capsuleServices.path, service.name, service.targetPort, projectDir);
    const volumeExists = await pathExists(service.stateDir);
    if (runtime.error) {
      diagnostics.push({ service: name, code: "compose-status-unavailable", message: runtime.error });
    }
    if (!volumeExists) {
      diagnostics.push({ service: name, code: "missing-service-state", message: "Capsule service state directory is missing." });
    }
    services[name] = {
      declared: true,
      engine: service.engine,
      status: runtime.state,
      health: runtime.health,
      port,
      network: {
        name: capsuleServices.networks.services,
        exists: networkExists,
      },
      volume: {
        type: "bind",
        path: path.join(CAPSULE_SERVICES_STATE_DIR, name),
        exists: volumeExists,
      },
      containerName: service.name,
      composeFile: capsuleServices.relativePath,
    };
  }
  const unhealthy = Object.values(services).some((service: LooseRecord) =>
    service.status && service.status !== "running" || service.health === "unhealthy" || !service.network.exists || !service.volume.exists,
  );
  const ok = diagnostics.length === 0 && !unhealthy;
  return {
    id: "doctor.services.runtime-state",
    title: "Capsule services runtime state",
    scope,
    status: ok ? "pass" : "warn",
    severity: ok ? "info" : "warning",
    message: ok
      ? "Capsule service containers, ports, networks, and state directories are visible."
      : "Capsule service runtime state has drift or unhealthy service signals.",
    hint: "Run `sporades deploy status`; use `sporades deploy restart` for stopped services or `sporades deploy reset` for stale generated state.",
    commands: ["sporades deploy status", "sporades deploy restart", "sporades deploy reset"],
    details: {
      services,
      diagnostics,
    },
  };
}

function dockerAvailabilityCheck(scope: string, required: boolean, idScope = scope) {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  const ok = result.status === 0;
  return {
    id: `doctor.${idScope}.docker-availability`,
    title: "Docker availability",
    scope,
    status: ok ? "pass" : required ? "fail" : "skip",
    severity: ok ? "info" : required ? "error" : "info",
    message: ok ? "Docker is available for read-only inspection." : "Docker is unavailable for local runtime inspection.",
    hint: ok
      ? "Inspect local runtime state with `sporades deploy status`."
      : "Install or start Docker, then rerun `sporades doctor` or inspect with `sporades deploy status`.",
    commands: ["sporades deploy status"],
    details: {
      available: ok,
      exitCode: result.status,
      stderr: result.stderr?.trim() || null,
    },
  };
}

function dockerComposeAvailabilityCheck(scope: string, required: boolean) {
  const result = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  const ok = result.status === 0;
  return {
    id: "doctor.services.compose-availability",
    title: "Docker Compose availability",
    scope,
    status: ok ? "pass" : required ? "fail" : "skip",
    severity: ok ? "info" : required ? "error" : "info",
    message: ok ? "Docker Compose is available for read-only Capsule service inspection." : "Docker Compose is unavailable.",
    hint: ok
      ? "Inspect Capsule service state with `sporades deploy status`."
      : "Install Docker Compose support, then rerun `sporades doctor`; service lifecycle follow-up uses `sporades deploy status`.",
    commands: ["sporades deploy status"],
    details: {
      available: ok,
      exitCode: result.status,
      stderr: result.stderr?.trim() || null,
    },
  };
}

function inspectDockerJson(args: string[], cwd: string) {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr?.trim() || result.stdout?.trim() || `docker ${args.join(" ")} failed` };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout.trim()) };
  } catch (error) {
    return { ok: false, error: errorDetails(error).message ?? "Docker returned invalid JSON." };
  }
}

function inspectComposeService(composePath: string, serviceName: string, cwd: string) {
  const inspected = inspectDockerJson(["compose", "-f", composePath, "ps", "--format", "json", serviceName], cwd);
  if (!inspected.ok) {
    return { state: "unknown", health: null, error: inspected.error };
  }
  const record = Array.isArray(inspected.value) ? inspected.value[0] : inspected.value;
  return {
    state: String(record?.State ?? record?.state ?? "unknown").toLowerCase(),
    health: record?.Health ? String(record.Health).toLowerCase() : null,
  };
}

function inspectComposeServicePort(composePath: string, serviceName: string, targetPort: number, cwd: string) {
  const result = spawnSync("docker", ["compose", "-f", composePath, "port", serviceName, String(targetPort)], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const match = result.stdout.match(/([^:\s]+):(\d+)\s*$/);
  return match ? { host: match[1], port: Number(match[2]), targetPort } : null;
}

function dockerStatus(args: string[], cwd: string) {
  return spawnSync("docker", args, { cwd, encoding: "utf8" }).status;
}

async function readOptionalJsonFile(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw commandError(`Invalid Runtime metadata: ${path.basename(filePath)}`, `Delete or fix ${path.relative(process.cwd(), filePath)}, then rerun \`sporades doctor\`.`);
    }
    throw error;
  }
}

async function pathExists(targetPath: string) {
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

function isTcpPortReachable(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function sessionDoctorPlaceholderCheck(options: LooseRecord) {
  const session = options.session;
  const commandBySession: LooseRecord = {
    dev: "sporades dev status",
    "public-dev": "sporades dev status",
    container: "sporades deploy status",
    hosted: `sporades host health ${options.subname} --host ${options.host}`,
  };
  const titleBySession: LooseRecord = {
    dev: "Dev session diagnostics pending",
    "public-dev": "Public Dev session diagnostics pending",
    container: "Container session diagnostics pending",
    hosted: "Hosted Capsule diagnostics pending",
  };
  return {
    id: `doctor.${session}.checks-pending`,
    title: titleBySession[session],
    scope: session,
    status: "skip",
    severity: "info",
    message: `Detailed ${session} checks are reserved for later doctor slices.`,
    hint: `Use \`${commandBySession[session]}\` for current runtime facts until those checks land.`,
    commands: [commandBySession[session]],
    details: { implementedInLaterSlice: true },
  };
}

export function createDoctorEnvelope(options: LooseRecord, checks: LooseRecord[]) {
  return {
    ok: true,
    data: {
      command: "doctor",
      version: 1,
      strict: options.strict,
      session: options.session,
      ...(options.host ? { host: options.host } : {}),
      ...(options.subname ? { subname: options.subname } : {}),
      summary: summarizeDoctorChecks(checks),
      checks,
    },
    error: null,
  };
}

export function summarizeDoctorChecks(checks: LooseRecord[]) {
  const summary: LooseRecord = {
    pass: 0,
    warn: 0,
    fail: 0,
    skip: 0,
    info: 0,
    warning: 0,
    error: 0,
  };

  for (const check of checks) {
    if (DOCTOR_STATUSES.includes(check.status)) {
      summary[check.status] += 1;
    }
    if (DOCTOR_SEVERITIES.includes(check.severity)) {
      summary[check.severity] += 1;
    }
  }

  return summary;
}

export function doctorShouldExitNonZero(checks: LooseRecord[], strict: boolean) {
  return checks.some((check) => check.status === "fail" || (strict && check.status === "warn"));
}

export function renderDoctorHumanOutput(data: LooseRecord) {
  const lines = ["Sporades doctor"];
  const bySeverity = new Map([
    ["error", data.checks.filter((check: LooseRecord) => check.severity === "error")],
    ["warning", data.checks.filter((check: LooseRecord) => check.severity === "warning")],
    ["info", data.checks.filter((check: LooseRecord) => check.severity === "info")],
  ]);

  for (const [severity, checks] of bySeverity) {
    if (checks.length === 0) {
      continue;
    }
    lines.push("", severity.toUpperCase());
    for (const check of checks) {
      lines.push(`- [${check.status}] ${check.title}: ${check.message}`);
      if (typeof check.hint === "string" && check.hint.trim()) {
        lines.push(`  hint: ${check.hint}`);
      }
      const commands = Array.isArray(check.commands)
        ? [...new Set(check.commands.filter((command: unknown) => typeof command === "string" && command.trim()))]
        : [];
      if (commands.length > 0) {
        lines.push(`  next: ${commands.join("; ")}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}
