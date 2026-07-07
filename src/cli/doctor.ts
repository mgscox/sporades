import type { LooseRecord } from "./cli-support.js";

export const DOCTOR_SESSIONS = new Set(["dev", "container", "hosted"]);
export const DOCTOR_STATUSES = ["pass", "warn", "fail", "skip"] as const;
export const DOCTOR_SEVERITIES = ["info", "warning", "error"] as const;

export function runDoctorChecks(options: LooseRecord) {
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

  if (options.session) {
    checks.push(sessionDoctorPlaceholderCheck(options));
  }

  return checks;
}

function sessionDoctorPlaceholderCheck(options: LooseRecord) {
  const session = options.session;
  const commandBySession: LooseRecord = {
    dev: "sporades dev status",
    container: "sporades deploy status",
    hosted: `sporades host health ${options.subname} --host ${options.host}`,
  };
  const titleBySession: LooseRecord = {
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
    }
  }

  lines.push("");
  return lines.join("\n");
}
