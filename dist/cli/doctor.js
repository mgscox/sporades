import { readFile } from "node:fs/promises";
import path from "node:path";
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
    if (options.session) {
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
    const command = sshFollowUpCommand(options);
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
function sshFollowUpCommand(options) {
    if (options.session === "hosted") {
        return `sporades host ssh ${options.subname} --host ${options.host}`;
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
        }
    }
    lines.push("");
    return lines.join("\n");
}
//# sourceMappingURL=doctor.js.map