import { readFile } from "node:fs/promises";
import path from "node:path";
import { bundleServerCapsuleModule } from "../bundle-pipeline.js";
import { schemaFromCapsuleDefinition } from "../server-runtime-source.js";
import { commandError, errorDetails } from "./cli-support.js";
export const DOCTOR_SESSIONS = new Set(["dev", "container", "hosted"]);
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
    const capsuleAuthoringCheck = await capsuleAuthoringAclPostureCheck(options);
    if (capsuleAuthoringCheck) {
        checks.push(capsuleAuthoringCheck);
    }
    if (options.session) {
        checks.push(sessionDoctorPlaceholderCheck(options));
    }
    return checks;
}
async function capsuleAuthoringAclPostureCheck(options) {
    const projectDir = typeof options.projectDir === "string" ? options.projectDir : process.cwd();
    const configPath = path.join(projectDir, "sporades.json");
    const serverEntry = path.join(projectDir, "server", "index.ts");
    try {
        await readFile(configPath, "utf8");
    }
    catch (error) {
        if (errorDetails(error).code === "ENOENT") {
            return null;
        }
        return capsuleMetadataLoadFailureCheck(error);
    }
    let serverSource;
    try {
        serverSource = await readFile(serverEntry, "utf8");
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
function sessionDoctorPlaceholderCheck(options) {
    const session = options.session;
    const commandBySession = {
        dev: "sporades dev status",
        container: "sporades deploy status",
        hosted: `sporades host health ${options.subname} --host ${options.host}`,
    };
    const titleBySession = {
        dev: "Dev session diagnostics pending",
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