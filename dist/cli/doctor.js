import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { bundleServerCapsuleModule } from "../bundle-pipeline.js";
import { schemaFromCapsuleDefinition } from "../server-runtime-source.js";
import { commandError, errorDetails } from "./cli-support.js";
import { authorizedKeyFingerprint, readProjectConfig, resolveAuthorizedKeyLines, resolveEffectiveSecurityPolicy, validateProjectConfigShape, } from "./project-config.js";
export const DOCTOR_SESSIONS = new Set(["dev", "public-dev", "container", "hosted"]);
export const DOCTOR_STATUSES = ["pass", "warn", "fail", "skip"];
export const DOCTOR_SEVERITIES = ["info", "warning", "error"];
export async function runDoctorChecks(options) {
    const checks = [
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
    if (options.session === "hosted") {
        checks.push(...await hostedCapsuleDoctorChecks(options));
    }
    else if (options.session) {
        checks.push(sessionDoctorPlaceholderCheck(options));
    }
    return checks;
}
async function projectConfigCheck(projectDir) {
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
    }
    catch (error) {
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
async function securityPolicyCheck(config, options) {
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
function securityPostureWarnings(security, session) {
    if (session !== "container" && session !== "hosted") {
        return [];
    }
    const warnings = [];
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
function securityPolicyHint(warnings) {
    const hints = [];
    if (warnings.some((warning) => warning.includes("CORS"))) {
        hints.push("Restrict security.cors.allowedOrigins to trusted origins instead of `*`.");
    }
    if (warnings.some((warning) => warning.includes("CSP"))) {
        hints.push("Tighten security.csp.directives and use security.csp.mode `enforce` when the policy is ready.");
    }
    return hints.join(" ");
}
async function publicDevPostureCheck(options) {
    const runningPublicDev = await readRunningPublicDevSession(options.projectDir);
    if (options.session !== "public-dev" && !runningPublicDev) {
        return null;
    }
    return {
        id: "doctor.public-dev-posture",
        title: "Public Dev posture",
        scope: "dev",
        status: "warn",
        severity: "warning",
        message: options.session === "public-dev"
            ? "Doctor is targeting Public Dev session posture."
            : "A running Dev session appears to be public.",
        hint: "Use Public Dev sessions only for temporary demos, device testing, or tunnels, and return to `sporades dev` when finished.",
        commands: ["sporades dev status"],
        details: {
            requestedPublicDev: options.session === "public-dev",
            runningPublicDev,
        },
    };
}
async function readRunningPublicDevSession(projectDir) {
    try {
        const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
        return Boolean(session.publicDev || session.public || session.security?.cors?.publicDev);
    }
    catch {
        return false;
    }
}
async function sshAuthorizedKeysCheck(config, options) {
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
    }
    catch (error) {
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
async function sshFollowUpCommand(options) {
    if (options.session === "hosted") {
        const binding = await readDoctorRemoteBinding(options.projectDir);
        const alias = options.host ?? binding?.hostAlias ?? "<alias>";
        const subname = options.subname ?? binding?.subname ?? "<subname>";
        return `sporades host ssh ${subname} --host ${alias}`;
    }
    return "sporades deploy ssh";
}
async function capsuleAuthoringAclPostureCheck(options) {
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
    }
    catch (error) {
        return capsuleMetadataLoadFailureCheck(error);
    }
}
async function loadBundledCapsuleDefinition(serverModuleSource) {
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(serverModuleSource, "utf8").toString("base64")}#${Date.now()}`;
    const capsuleModule = await import(moduleUrl);
    if (!capsuleModule.default) {
        throw commandError("Capsule server entry did not export a default Capsule definition.", "Fix server/index.ts so it uses `export default capsule({ schema: { ... } })`, then rerun `sporades doctor`.");
    }
    return capsuleModule.default;
}
function capsuleAclDeclarationCheck(definition, normalizedSchema) {
    const schema = definition?.schema ?? {};
    const tables = Object.entries(schema)
        .filter(([, table]) => isAppTableDeclaration(table))
        .map(([name, table]) => tableAclPosture(name, table))
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
        message: "Some Capsule app tables are missing ACL declarations; missing ACLs are allow-by-default and not deny-by-default today.",
        hint: "Add .acl({ read, write }) to app table declarations that should restrict reads or writes. Doctor only inspects declarations and does not evaluate ACL policy outcomes against live user data.",
        details: {
            inspectedResource: "app-tables",
            tables,
        },
    };
}
function isAppTableDeclaration(table) {
    return Boolean(table && typeof table === "object" && !Array.isArray(table) && table.kind === "table");
}
function tableAclPosture(name, table) {
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
function capsuleMetadataLoadFailureCheck(error) {
    const details = errorDetails(error);
    return {
        id: "doctor.capsule-authoring.metadata-load",
        title: "Capsule schema metadata",
        scope: "project",
        status: "fail",
        severity: "error",
        message: `Capsule schema metadata could not be loaded: ${details.message ?? "unknown error"}.`,
        hint: details.hint ??
            "Fix server/index.ts so Sporades can bundle and load the Capsule definition, then rerun `sporades doctor`.",
    };
}
function doctorScope(session) {
    return session === "public-dev" ? "dev" : session;
}
async function hostedCapsuleDoctorChecks(options) {
    const target = await resolveHostedDoctorTarget(options);
    if (!target.ok) {
        return [target.check];
    }
    options.host = target.alias;
    options.subname = target.subname;
    const commands = hostedCommands(target.alias, target.subname);
    const checks = [target.check];
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
async function resolveHostedDoctorTarget(options) {
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
async function readDoctorRemoteBinding(projectDir) {
    try {
        const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "remote-binding.json"), "utf8"));
        return binding && typeof binding === "object" && !Array.isArray(binding) ? binding : null;
    }
    catch {
        return null;
    }
}
function hostedCommands(alias, subname) {
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
function hostHealthCheck(result, commands) {
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
function hostedCapsuleFromList(result, subname) {
    const capsules = Array.isArray(result.data?.capsules) ? result.data.capsules : [];
    return capsules.find((capsule) => capsule?.subname === subname) ?? null;
}
function hostedRegistryCheck(result, capsule, commands) {
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
function hostedReleaseCheck(capsule, commands) {
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
function hostedRuntimeHealthCheck(result, commands) {
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
function hostedStatsCheck(hostStats, capsuleStats, commands) {
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
function hostedSealedServerEnvCheck(capsule, commands) {
    const releaseFingerprint = capsule.currentRelease?.sealedServerEnv?.publicKeyFingerprint ?? null;
    const currentFingerprint = capsule.sealedServerEnv?.publicKeyFingerprint ?? capsule.registry?.sealedServerEnv?.currentKeyFingerprint ?? null;
    const inspectedFingerprint = capsule.sealedServerEnv?.publicKeyFingerprint ?? null;
    const publicKeyAvailable = capsule.sealedServerEnv?.publicKeyAvailable ?? null;
    const privateKeyAvailable = capsule.sealedServerEnv?.privateKeyAvailable ?? null;
    const mismatch = Boolean(releaseFingerprint && releaseFingerprint !== currentFingerprint);
    const missingHostKeyMaterial = Boolean(capsule.sealedServerEnv?.status === "missing-key-material" || publicKeyAvailable === false || privateKeyAvailable === false);
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
function hostedSshStateCheck(result, commands) {
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
async function runHostJsonCommand(args, projectDir) {
    return new Promise((resolve) => {
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
            }
            catch {
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
function sessionDoctorPlaceholderCheck(options) {
    const session = options.session;
    const commandBySession = {
        dev: "sporades dev status",
        "public-dev": "sporades dev status",
        container: "sporades deploy status",
        hosted: `sporades host health ${options.subname} --host ${options.host}`,
    };
    const titleBySession = {
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
export function createDoctorEnvelope(options, checks) {
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
export function summarizeDoctorChecks(checks) {
    const summary = {
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
export function doctorShouldExitNonZero(checks, strict) {
    return checks.some((check) => check.status === "fail" || (strict && check.status === "warn"));
}
export function renderDoctorHumanOutput(data) {
    const lines = ["Sporades doctor"];
    const bySeverity = new Map([
        ["error", data.checks.filter((check) => check.severity === "error")],
        ["warning", data.checks.filter((check) => check.severity === "warning")],
        ["info", data.checks.filter((check) => check.severity === "info")],
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
                ? [...new Set(check.commands.filter((command) => typeof command === "string" && command.trim()))]
                : [];
            if (commands.length > 0) {
                lines.push(`  next: ${commands.join("; ")}`);
            }
        }
    }
    lines.push("");
    return lines.join("\n");
}
//# sourceMappingURL=doctor.js.map