/** Opt-in Capsule-wide MIME policy. This is signature checking, not malware inspection. */
export function resolveFileAllowedMimeTypes(files: any): ReadonlySet<string> | null {
  const types = files?.allowedMimeTypes;
  if (types === undefined) return null;
  if (!Array.isArray(types) || types.some(type => typeof type !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type))) {
    throw Object.assign(new Error("Invalid File MIME allowlist."), {
      code: "INVALID_FILE_CONFIG", hint: "Set files.allowedMimeTypes to an array of lowercase exact MIME types; [] denies all uploads.",
    });
  }
  return new Set(types);
}

export function normalizeFileMimeType(type: unknown): string {
  return String(type ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
}

const signatures: readonly [string, readonly number[], number][] = [
  ["image/png", [137, 80, 78, 71, 13, 10, 26, 10], 0],
  ["image/jpeg", [255, 216, 255], 0],
  ["image/gif", [71, 73, 70, 56, 55, 97], 0],
  ["image/gif", [71, 73, 70, 56, 57, 97], 0],
  ["image/bmp", [66, 77], 0],
  ["application/pdf", [37, 80, 68, 70, 45], 0],
  ["application/gzip", [31, 139], 0],
  ["application/zip", [80, 75, 3, 4], 0],
  ["application/zip", [80, 75, 5, 6], 0],
  ["application/zip", [80, 75, 7, 8], 0],
];
const signedTypes = new Set([...signatures.map(([type]) => type), "image/webp", "image/avif"]);
function matches(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  return bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
}
function detectedMimeType(bytes: Uint8Array): string | null {
  for (const [type, signature, offset] of signatures) if (matches(bytes, signature, offset)) return type;
  if (matches(bytes, [82, 73, 70, 70]) && matches(bytes, [87, 69, 66, 80], 8)) return "image/webp";
  if (matches(bytes, [102, 116, 121, 112], 4) && (matches(bytes, [97, 118, 105, 102], 8) || matches(bytes, [97, 118, 105, 115], 8))) return "image/avif";
  return null;
}

/** Called before creating pending state and again on the actual bytes, before storage publication. */
export function assertAllowedFileMimeType(allowed: ReadonlySet<string> | null | undefined, rawType: unknown, bytes?: Uint8Array): void {
  if (!allowed) return;
  const type = normalizeFileMimeType(rawType);
  if (!allowed.has(type)) throw Object.assign(new Error("File MIME type is not allowed."), {
    code: "FILE_MIME_TYPE_NOT_ALLOWED", hint: "Choose a type permitted by files.allowedMimeTypes.",
  });
  if (!bytes) return;
  const detected = detectedMimeType(bytes);
  let valid = !signedTypes.has(type) || detected === type;
  if (type === "text/plain") {
    valid = detected === null;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      valid = valid && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
    } catch { valid = false; }
  }
  if (!valid) throw Object.assign(new Error("File bytes do not match the declared MIME type."), {
    code: "FILE_MIME_TYPE_MISMATCH", hint: "Supply bytes matching the declared MIME type.",
  });
}
