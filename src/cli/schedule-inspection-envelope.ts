type LooseRecord = Record<string, any>;
const SCHEDULE_DIAGNOSTIC_FIELDS = new Set([
  "name", "expression", "timezone", "missedRun", "enabled", "exhausted", "nextOccurrence",
  "latestOccurrence", "latestOccurrence.scheduledFor", "latestOccurrence.jobId",
  "latestOccurrence.errorCode", "latestOccurrence.outcome",
]);
const SCHEDULE_DIAGNOSTIC_INLINE_NAME_BYTES = 4096;
const SCHEDULE_DIAGNOSTIC_NAME_PREFIX_LENGTH = 128;

function scheduleNameDigest(value: string) {
  return process.getBuiltinModule("node:crypto").createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedScheduleDiagnostic(candidate: LooseRecord) {
  const scheduleName = candidate?.scheduleName;
  const field = candidate?.field;
  if (candidate?.code !== "SCHEDULE_INSPECTION_INVALID_STATE" || typeof field !== "string" || !SCHEDULE_DIAGNOSTIC_FIELDS.has(field)) return undefined;
  if (typeof scheduleName === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(scheduleName)) {
    const scheduleNameBytes = Buffer.byteLength(scheduleName, "utf8");
    if (scheduleNameBytes <= SCHEDULE_DIAGNOSTIC_INLINE_NAME_BYTES) return { code: candidate.code, scheduleName, field };
    return {
      code: candidate.code,
      scheduleNamePrefix: scheduleName.slice(0, SCHEDULE_DIAGNOSTIC_NAME_PREFIX_LENGTH),
      scheduleNameSha256: scheduleNameDigest(scheduleName),
      scheduleNameBytes,
      field,
    };
  }
  if (
    typeof candidate?.scheduleNamePrefix === "string"
    && /^[A-Za-z][A-Za-z0-9_-]*$/.test(candidate.scheduleNamePrefix)
    && candidate.scheduleNamePrefix.length === SCHEDULE_DIAGNOSTIC_NAME_PREFIX_LENGTH
    && typeof candidate?.scheduleNameSha256 === "string"
    && /^[a-f0-9]{64}$/.test(candidate.scheduleNameSha256)
    && Number.isInteger(candidate?.scheduleNameBytes)
    && candidate.scheduleNameBytes > SCHEDULE_DIAGNOSTIC_INLINE_NAME_BYTES
  ) {
    return {
      code: candidate.code,
      scheduleNamePrefix: candidate.scheduleNamePrefix,
      scheduleNameSha256: candidate.scheduleNameSha256,
      scheduleNameBytes: candidate.scheduleNameBytes,
      field,
    };
  }
  return undefined;
}

export function sanitizeScheduleInspectionEnvelope(envelope: LooseRecord, invalid: () => never): LooseRecord {
  if (envelope?.ok === false) {
    const source = envelope.error;
    const candidate = source?.diagnostics ?? source;
    const diagnostics = boundedScheduleDiagnostic(candidate);
    return { ok: false, data: null, error: {
      message: diagnostics ? "Persisted Schedule state is malformed." : "Schedule inspection failed.",
      hint: diagnostics ? "Repair or remove the malformed Schedule before retrying inspection." : "Inspect the Capsule and retry the command.",
      ...(diagnostics ? { diagnostics } : {}),
    } };
  }
  if (envelope?.ok !== true || typeof envelope.data?.capsule?.name !== "string" || !Array.isArray(envelope.data?.schedules)) invalid();
  const schedules = envelope.data.schedules.map((value: LooseRecord) => {
    if (!value || typeof value.name !== "string" || typeof value.expression !== "string" || typeof value.timezone !== "string" || !["skip", "latest"].includes(value.missedRun) || typeof value.enabled !== "boolean" || (value.nextOccurrence !== null && typeof value.nextOccurrence !== "string")) invalid();
    let latestOccurrence = null;
    if (value.latestOccurrence !== null) {
      const latest = value.latestOccurrence;
      if (!latest || typeof latest.scheduledFor !== "string" || !["enqueued", "payload-failed"].includes(latest.outcome)) invalid();
      if (latest.outcome === "enqueued" && typeof latest.jobId === "string") latestOccurrence = { scheduledFor: latest.scheduledFor, outcome: latest.outcome, jobId: latest.jobId };
      else if (latest.outcome === "payload-failed" && ["SCHEDULE_PAYLOAD_FAILED", "SCHEDULE_ENQUEUE_FAILED"].includes(latest.errorCode)) latestOccurrence = { scheduledFor: latest.scheduledFor, outcome: latest.outcome, errorCode: latest.errorCode };
      else invalid();
    }
    return { name: value.name, expression: value.expression, timezone: value.timezone, missedRun: value.missedRun, enabled: value.enabled, nextOccurrence: value.nextOccurrence, latestOccurrence };
  });
  return { ok: true, data: { capsule: { name: envelope.data.capsule.name }, schedules }, error: null };
}
