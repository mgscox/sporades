import type { BinaryLike, KeyLike } from "node:crypto";
import type { PathLike } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ENVELOPE_VERSION = 1;
const KEY_ALGORITHM = "rsa";
const VALUE_ALGORITHM = "aes-256-gcm";

export type SealedServerEnvPaths = {
  root: string;
  envelope: string;
  privateKey: string;
  publicKey: string;
  hosts: string;
};
export type SealedServerEnvKeyPair = {
  publicKey: string;
  privateKey: string;
  publicKeyFingerprint: string;
};
export type SealedServerEnvEntry = {
  encryptedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
};
export type SealedServerEnvEnvelope = {
  version: number;
  keyAlgorithm: string;
  valueAlgorithm: string;
  publicKeyFingerprint: string;
  sealedAt: string;
  metadata: Record<string, unknown>;
  entries: Record<string, SealedServerEnvEntry>;
};
export type SealedServerEnvSummary = {
  configured: boolean;
  keyCount: number;
  publicKeyFingerprint: string | null;
  envelopePath: string | null;
  privateKeyPath: string | null;
};

type NodeError = Error & { code?: string };
type PublicEncryptionKey = KeyLike;
type PrivateEncryptionKey = KeyLike;

export function sealedServerEnvPaths(projectDir: string): SealedServerEnvPaths {
  const root = path.join(projectDir, ".sporades", "sealed-server-env");
  return {
    root,
    envelope: path.join(root, "server-env.sealed.json"),
    privateKey: path.join(root, "server-env.private.pem"),
    publicKey: path.join(root, "server-env.public.pem"),
    hosts: path.join(root, "hosts"),
  };
}

export async function ensureSealedServerEnvKeyPair(
  paths = sealedServerEnvPaths(process.cwd()),
): Promise<SealedServerEnvKeyPair> {
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

export async function readKeyPair(paths: Pick<SealedServerEnvPaths, "privateKey" | "publicKey">): Promise<SealedServerEnvKeyPair | null> {
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
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function sealServerEnv(
  values: Record<string, unknown>,
  publicKey: PublicEncryptionKey,
  metadata: Record<string, unknown> = {},
): SealedServerEnvEnvelope {
  const entries: Record<string, SealedServerEnvEntry> = {};
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

export function unsealServerEnv(envelope: unknown, privateKey: PrivateEncryptionKey): Record<string, string> {
  validateEnvelope(envelope);
  const values: Record<string, string> = {};
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

export async function readSealedServerEnv(paths: Pick<SealedServerEnvPaths, "envelope">): Promise<SealedServerEnvEnvelope | null> {
  try {
    const envelope = JSON.parse(await readFile(paths.envelope, "utf8"));
    validateEnvelope(envelope);
    return envelope;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeSealedServerEnv(
  paths: { root: PathLike; envelope: PathLike | FileHandle },
  envelope: SealedServerEnvEnvelope,
): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await writeFile(paths.envelope, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
}

export function envelopeSummary(
  envelope: SealedServerEnvEnvelope | null,
  paths: Pick<SealedServerEnvPaths, "envelope" | "privateKey"> | null = null,
): SealedServerEnvSummary {
  return {
    configured: Boolean(envelope),
    keyCount: envelope ? Object.keys(envelope.entries ?? {}).length : 0,
    publicKeyFingerprint: envelope?.publicKeyFingerprint ?? null,
    envelopePath: paths ? paths.envelope : null,
    privateKeyPath: paths ? paths.privateKey : null,
  };
}

export function exportedEnvelope(envelope: unknown): SealedServerEnvEnvelope & { exportedAt: string } {
  validateEnvelope(envelope);
  return {
    ...envelope,
    exportedAt: new Date().toISOString(),
  };
}

export function fingerprintPublicKey(publicKey: BinaryLike | PublicEncryptionKey): string {
  const fingerprintSource = isBinaryLike(publicKey)
    ? publicKey
    : createPublicKey(publicKey).export({ type: "spki", format: "pem" });
  return createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 16);
}

function validateEnvelope(envelope: unknown): asserts envelope is SealedServerEnvEnvelope {
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

function isEnvelopeEntry(value: unknown): value is SealedServerEnvEntry {
  return (
    isRecord(value) &&
    typeof value.encryptedKey === "string" &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.ciphertext === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isBinaryLike(value: BinaryLike | PublicEncryptionKey): value is BinaryLike {
  return typeof value === "string" || Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function errorCode(error: unknown): string | undefined {
  return isNodeError(error) ? error.code : undefined;
}

function isNodeError(error: unknown): error is NodeError {
  return Boolean(error && typeof error === "object" && "code" in error);
}
