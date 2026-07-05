import { createCipheriv, createDecipheriv, createHash, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const ENVELOPE_VERSION = 1;
const KEY_ALGORITHM = "rsa";
const VALUE_ALGORITHM = "aes-256-gcm";
export function sealedServerEnvPaths(projectDir) {
    const root = path.join(projectDir, ".sporades", "sealed-server-env");
    return {
        root,
        envelope: path.join(root, "server-env.sealed.json"),
        privateKey: path.join(root, "server-env.private.pem"),
        publicKey: path.join(root, "server-env.public.pem"),
        hosts: path.join(root, "hosts"),
    };
}
export async function ensureSealedServerEnvKeyPair(paths = sealedServerEnvPaths(process.cwd())) {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    const existing = await readKeyPair(paths);
    if (existing) {
        return existing;
    }
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await writeFile(paths.privateKey, privateKey, { mode: 0o600 });
    await writeFile(paths.publicKey, publicKey, { mode: 0o644 });
    return {
        publicKey,
        privateKey,
        publicKeyFingerprint: fingerprintPublicKey(publicKey),
    };
}
export async function readKeyPair(paths) {
    try {
        const [publicKey, privateKey] = await Promise.all([
            readFile(paths.publicKey, "utf8"),
            readFile(paths.privateKey, "utf8"),
        ]);
        return {
            publicKey,
            privateKey,
            publicKeyFingerprint: fingerprintPublicKey(publicKey),
        };
    }
    catch (error) {
        if (errorCode(error) === "ENOENT") {
            return null;
        }
        throw error;
    }
}
export function sealServerEnv(values, publicKey, metadata = {}) {
    const entries = {};
    for (const [key, value] of Object.entries(values)) {
        const dataKey = randomBytes(32);
        const iv = randomBytes(12);
        const cipher = createCipheriv(VALUE_ALGORITHM, dataKey, iv);
        const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
        entries[key] = {
            encryptedKey: publicEncrypt(publicKey, dataKey).toString("base64"),
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            ciphertext: ciphertext.toString("base64"),
        };
    }
    return {
        version: ENVELOPE_VERSION,
        keyAlgorithm: KEY_ALGORITHM,
        valueAlgorithm: VALUE_ALGORITHM,
        publicKeyFingerprint: fingerprintPublicKey(publicKey),
        sealedAt: new Date().toISOString(),
        metadata,
        entries,
    };
}
export function unsealServerEnv(envelope, privateKey) {
    validateEnvelope(envelope);
    const values = {};
    for (const [key, entry] of Object.entries(envelope.entries)) {
        const dataKey = privateDecrypt(privateKey, Buffer.from(entry.encryptedKey, "base64"));
        const decipher = createDecipheriv(VALUE_ALGORITHM, dataKey, Buffer.from(entry.iv, "base64"));
        decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
        values[key] = Buffer.concat([
            decipher.update(Buffer.from(entry.ciphertext, "base64")),
            decipher.final(),
        ]).toString("utf8");
    }
    return values;
}
export async function readSealedServerEnv(paths) {
    try {
        const envelope = JSON.parse(await readFile(paths.envelope, "utf8"));
        validateEnvelope(envelope);
        return envelope;
    }
    catch (error) {
        if (errorCode(error) === "ENOENT") {
            return null;
        }
        throw error;
    }
}
export async function writeSealedServerEnv(paths, envelope) {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await writeFile(paths.envelope, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
}
export function envelopeSummary(envelope, paths = null) {
    return {
        configured: Boolean(envelope),
        keyCount: envelope ? Object.keys(envelope.entries ?? {}).length : 0,
        publicKeyFingerprint: envelope?.publicKeyFingerprint ?? null,
        envelopePath: paths ? paths.envelope : null,
        privateKeyPath: paths ? paths.privateKey : null,
    };
}
export function exportedEnvelope(envelope) {
    validateEnvelope(envelope);
    return {
        ...envelope,
        exportedAt: new Date().toISOString(),
    };
}
export function fingerprintPublicKey(publicKey) {
    const fingerprintSource = isBinaryLike(publicKey)
        ? publicKey
        : createPublicKey(publicKey).export({ type: "spki", format: "pem" });
    return createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 16);
}
function validateEnvelope(envelope) {
    if (!isRecord(envelope)) {
        throw new Error("Invalid sealed Server env envelope.");
    }
    if (envelope.version !== ENVELOPE_VERSION || envelope.keyAlgorithm !== KEY_ALGORITHM || envelope.valueAlgorithm !== VALUE_ALGORITHM) {
        throw new Error("Invalid sealed Server env envelope.");
    }
    if (typeof envelope.publicKeyFingerprint !== "string" || typeof envelope.sealedAt !== "string" || !isRecord(envelope.metadata)) {
        throw new Error("Invalid sealed Server env envelope.");
    }
    if (!isRecord(envelope.entries)) {
        throw new Error("Invalid sealed Server env envelope.");
    }
    for (const entry of Object.values(envelope.entries)) {
        if (!isEnvelopeEntry(entry)) {
            throw new Error("Invalid sealed Server env envelope.");
        }
    }
}
function isEnvelopeEntry(value) {
    return (isRecord(value) &&
        typeof value.encryptedKey === "string" &&
        typeof value.iv === "string" &&
        typeof value.tag === "string" &&
        typeof value.ciphertext === "string");
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isBinaryLike(value) {
    return typeof value === "string" || Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}
function errorCode(error) {
    return isNodeError(error) ? error.code : undefined;
}
function isNodeError(error) {
    return Boolean(error && typeof error === "object" && "code" in error);
}
//# sourceMappingURL=sealed-server-env.js.map