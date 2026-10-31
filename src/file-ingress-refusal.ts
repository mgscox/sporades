/** Snapshot untrusted policy output without getters/toJSON or retained mutable references. */
export function snapshotIngressDecision(value: unknown): any {
  let nodes = 0;
  let bytes = 0;
  const invalid = () => { throw new Error("Invalid File ingress decision."); };
  const visit = (input: any, depth: number): any => {
    if (++nodes > 1024 || depth > 16) return invalid();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : invalid();
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input, "utf8");
      return bytes <= 8192 ? input : invalid();
    }
    if (!input || typeof input !== "object" || (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input)))) return invalid();
    const output: any = Array.isArray(input) ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (Array.isArray(input) && key === "length") continue;
      if (typeof key !== "string") return invalid();
      bytes += Buffer.byteLength(key, "utf8");
      if (bytes > 8192) return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return invalid();
      // Preserve the established optional allowFiles contract while keeping
      // refusal payloads strict JSON. Explicitly undefined optional fields
      // have the same meaning as omission, only at the decision root.
      if (depth === 0 && (key === "allowFiles" || key === "refusalJob") && descriptor.value === undefined) continue;
      if (Array.isArray(input) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= 1024)) return invalid();
      Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
    }
    if (Array.isArray(input) && (input.length > 1024 || Object.keys(output).length !== input.length)) return invalid();
    return Object.freeze(output);
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result) ?? "", "utf8") > 8192) invalid();
  return result;
}

export function ingressRefusalJob(decision: any) {
  if (!decision || decision.allow !== false || Object.keys(decision).some(key => !["allow", "refusalJob"].includes(key))) throw new Error("Invalid File ingress refusal.");
  if (!Object.hasOwn(decision, "refusalJob")) return null;
  const job = decision.refusalJob;
  if (!job || typeof job !== "object" || Array.isArray(job) || Object.keys(job).length !== 3
    || Object.keys(job).some(key => !["name", "payload", "idempotencyKey"].includes(key))
    || typeof job.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(job.name)
    || typeof job.idempotencyKey !== "string" || !job.idempotencyKey || Buffer.byteLength(job.idempotencyKey, "utf8") > 256
    || /[\x00-\x1f\x7f]/.test(job.idempotencyKey)
    || !Object.hasOwn(job, "payload") || Buffer.byteLength(JSON.stringify(job.payload), "utf8") > 4096) throw new Error("Invalid File ingress refusal.");
  return job;
}
