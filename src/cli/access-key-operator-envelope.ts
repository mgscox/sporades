type LooseRecord = Record<string, any>;

const FORBIDDEN_KEYS = new Set(["selector", "verifier", "verifierDigest", "token", "tokenFragment", "ownerEmail", "ownerDisplayName"]);

export function sanitizeAccessKeyOperatorEnvelope(value: unknown, invalid: () => never): LooseRecord {
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { return invalid(); }
  if (Buffer.byteLength(encoded, "utf8") > 256 * 1024) return invalid();
  const visit = (candidate: any): boolean => {
    if (candidate === null || ["string", "number", "boolean"].includes(typeof candidate)) return true;
    if (Array.isArray(candidate)) return candidate.length <= 100 && candidate.every(visit);
    if (!candidate || typeof candidate !== "object") return false;
    return Object.entries(candidate).every(([key, child]) => !FORBIDDEN_KEYS.has(key) && visit(child));
  };
  if (!visit(value) || !value || typeof value !== "object" || typeof (value as LooseRecord).ok !== "boolean") return invalid();
  const envelope = value as LooseRecord;
  if (envelope.ok) {
    if (!envelope.data || typeof envelope.data !== "object" || envelope.error !== null) return invalid();
  } else if (!envelope.error || typeof envelope.error.message !== "string" || typeof envelope.error.hint !== "string") {
    return invalid();
  }
  return envelope;
}
