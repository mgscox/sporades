export function sanitizeScheduleInspectionEnvelope(envelope, invalid) {
    if (envelope?.ok === false) {
        const source = envelope.error;
        const candidate = source?.diagnostics ?? source;
        const diagnostics = candidate?.code === "SCHEDULE_INSPECTION_INVALID_STATE" && typeof candidate.scheduleName === "string" && typeof candidate.field === "string"
            ? { code: candidate.code, scheduleName: candidate.scheduleName, field: candidate.field }
            : undefined;
        return { ok: false, data: null, error: {
                message: diagnostics ? "Persisted Schedule state is malformed." : "Schedule inspection failed.",
                hint: diagnostics ? "Repair or remove the malformed Schedule before retrying inspection." : "Inspect the Capsule and retry the command.",
                ...(diagnostics ? { diagnostics } : {}),
            } };
    }
    if (envelope?.ok !== true || typeof envelope.data?.capsule?.name !== "string" || !Array.isArray(envelope.data?.schedules))
        invalid();
    const schedules = envelope.data.schedules.map((value) => {
        if (!value || typeof value.name !== "string" || typeof value.expression !== "string" || typeof value.timezone !== "string" || !["skip", "latest"].includes(value.missedRun) || typeof value.enabled !== "boolean" || (value.nextOccurrence !== null && typeof value.nextOccurrence !== "string"))
            invalid();
        let latestOccurrence = null;
        if (value.latestOccurrence !== null) {
            const latest = value.latestOccurrence;
            if (!latest || typeof latest.scheduledFor !== "string" || !["enqueued", "payload-failed"].includes(latest.outcome))
                invalid();
            if (latest.outcome === "enqueued" && typeof latest.jobId === "string")
                latestOccurrence = { scheduledFor: latest.scheduledFor, outcome: latest.outcome, jobId: latest.jobId };
            else if (latest.outcome === "payload-failed" && ["SCHEDULE_PAYLOAD_FAILED", "SCHEDULE_ENQUEUE_FAILED"].includes(latest.errorCode))
                latestOccurrence = { scheduledFor: latest.scheduledFor, outcome: latest.outcome, errorCode: latest.errorCode };
            else
                invalid();
        }
        return { name: value.name, expression: value.expression, timezone: value.timezone, missedRun: value.missedRun, enabled: value.enabled, nextOccurrence: value.nextOccurrence, latestOccurrence };
    });
    return { ok: true, data: { capsule: { name: envelope.data.capsule.name }, schedules }, error: null };
}
//# sourceMappingURL=schedule-inspection-envelope.js.map