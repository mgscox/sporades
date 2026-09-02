// Endpoint attachment responses are a deliberately narrow runtime capability. Capsule handlers
// may name a File id/version pair and a presentation filename, but never receive bytes, a storage
// path, object key, stream, or storage credentials.

type LooseRecord = Record<string, any>;

type AttachmentResponseDetails = Readonly<{ fileId: string; version: string; filename: string }>;

const attachmentResponseDetails = new WeakMap<object, AttachmentResponseDetails>();
const guardedAttachmentHttpResponses = new WeakSet<object>();

export function createEndpointFileResponseApi(ingressApi: LooseRecord, enabled: boolean) {
  const attachment = enabled ? {
    attachment(reference: LooseRecord, options: LooseRecord) {
      const fileId = exactIdentifier(reference?.id);
      const version = exactIdentifier(reference?.version);
      const filename = safePresentationFilename(options?.filename);
      if (!fileId || !version || !filename) {
        const error: any = new Error("Invalid endpoint File attachment response.");
        error.code = "INVALID_ENDPOINT_FILE_ATTACHMENT";
        throw error;
      }
      const response = Object.freeze({});
      attachmentResponseDetails.set(response, Object.freeze({ fileId, version, filename }));
      return response;
    },
  } : {};
  return Object.freeze({ ...ingressApi, ...attachment });
}

export function endpointFileAttachmentDetails(value: unknown): AttachmentResponseDetails | null {
  return value !== null && typeof value === "object" ? attachmentResponseDetails.get(value as object) ?? null : null;
}

export function markGuardedAttachmentHttpResponse(response: object) {
  guardedAttachmentHttpResponses.add(response);
}

export function isGuardedAttachmentHttpResponse(response: unknown) {
  return response !== null && typeof response === "object" && guardedAttachmentHttpResponses.has(response as object);
}

function exactIdentifier(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512 || /[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

export function safePresentationFilename(value: unknown) {
  if (typeof value !== "string") return null;
  const filename = value.normalize("NFKC").trim();
  if (!filename || Buffer.byteLength(filename, "utf8") > 120) return "download";
  // A presentation filename is one inert basename. Treat suspicious input as invalid rather than
  // trying to rescue it piecemeal: headers are not a place for clever interpretation.
  if (/[\x00-\x1f\x7f\\/]|[\u202a-\u202e\u2066-\u2069]/u.test(filename) || filename === "." || filename === ".." || filename.includes("..")) return "download";
  const stem = filename.split(".")[0]?.trim().toUpperCase();
  if (["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].includes(stem)) return "download";
  return filename;
}

export function attachmentContentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_").replace(/[\x00-\x1f\x7f]/g, "_") || "download";
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
