import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normaliseBaseImageUpdatePolicy } from "../base-image.js";
import { validateCapsuleServicesConfig } from "../capsule-services.js";
import { commandError, errorDetails } from "./cli-support.js";
export const SECURITY_SESSIONS = new Set(["dev", "public-dev", "container", "hosted"]);
const CLIENT_FRAMEWORKS = new Set(["react", "preact", "vanilla"]);
const CLIENT_TOOLCHAINS = new Set(["esbuild", "vite"]);
const DEFAULT_CSP_DIRECTIVES = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "connect-src": ["'self'", "ws:", "wss:"],
    "font-src": ["'self'", "data:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "frame-ancestors": ["'none'"],
};
const SUPPORTED_PROJECT_KEYS = new Set([
    "auth",
    "baseImage",
    "capsule",
    "client",
    "deploy",
    "dev",
    "files",
    "id",
    "logging",
    "logs",
    "name",
    "release",
    "security",
    "scheduling",
    "services",
    "ssh",
    "template",
]);
export async function readProjectConfig(projectDir) {
    const configPath = path.join(projectDir, "sporades.json");
    const raw = await readRequiredFile(configPath, "Missing project configuration: sporades.json", "Run `sporades create` to scaffold a new project.");
    let config;
    try {
        config = JSON.parse(raw);
    }
    catch {
        throw commandError("Invalid project configuration: sporades.json", "Fix the JSON syntax in sporades.json.");
    }
    validateSecurityConfig(config.security);
    validateClientConfig(config.client);
    validateSchedulingConfig(config.scheduling);
    validateCapsuleServicesConfig(config.services);
    return config;
}
export function validateClientConfig(client) {
    if (client === undefined)
        return;
    if (!client || typeof client !== "object" || Array.isArray(client) || Object.keys(client).some((key) => key !== "framework" && key !== "toolchain")) {
        throw commandError("Invalid client configuration.", "Set `client.framework` and optional `client.toolchain` in sporades.json.");
    }
    if (client.framework !== undefined && !CLIENT_FRAMEWORKS.has(client.framework)) {
        throw commandError(`Unsupported framework: ${client.framework}`, "Use one of: react, preact, vanilla.");
    }
    if (client.toolchain !== undefined && !CLIENT_TOOLCHAINS.has(client.toolchain)) {
        throw commandError(`Unsupported client toolchain: ${client.toolchain}`, "Use one of: esbuild, vite.");
    }
    if (client.toolchain === "vite" && (client.framework ?? "react") !== "react") {
        throw commandError(`Unsupported client framework/toolchain combination: ${client.framework}/vite`, "Use React with Vite, or keep Preact and Vanilla TypeScript on esbuild.");
    }
}
export function validateSchedulingConfig(scheduling) {
    if (scheduling === undefined)
        return;
    if (!scheduling || typeof scheduling !== "object" || Array.isArray(scheduling) || Object.keys(scheduling).some((key) => key !== "payloadFactoryTimeoutSeconds")) {
        throw commandError("Invalid scheduling configuration.", "Set `scheduling.payloadFactoryTimeoutSeconds` to an integer from 1 through 300.");
    }
    const seconds = scheduling.payloadFactoryTimeoutSeconds;
    if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > 300)) {
        throw commandError("Invalid Schedule payload factory timeout.", "Set `scheduling.payloadFactoryTimeoutSeconds` to an integer from 1 through 300.");
    }
}
export async function readOptionalProjectSecurity(projectDir, session) {
    try {
        return resolveEffectiveSecurityPolicy(await readProjectConfig(projectDir), session);
    }
    catch (error) {
        if (errorDetails(error).message === "Missing project configuration: sporades.json") {
            return null;
        }
        throw error;
    }
}
export function validateProjectConfigShape(config) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw commandError("Invalid project configuration: sporades.json", "Set sporades.json to a JSON object.");
    }
    const unsupportedKeys = Object.keys(config).filter((key) => !SUPPORTED_PROJECT_KEYS.has(key)).sort();
    if (unsupportedKeys.length > 0) {
        throw commandError("Unsupported project configuration keys.", "Remove unsupported top-level keys from sporades.json or move Capsule-specific values into Server env or app code.", { unsupportedKeys });
    }
}
export function validateSecurityConfig(security) {
    if (security === undefined) {
        return;
    }
    if (!security || typeof security !== "object" || Array.isArray(security)) {
        throw commandError("Invalid security policy.", "Set `security` in sporades.json to an object.");
    }
    const cors = security.cors;
    if (cors !== undefined) {
        if (!cors || typeof cors !== "object" || Array.isArray(cors)) {
            throw commandError("Invalid CORS policy.", "Set `security.cors` to an object with `allowedOrigins`.");
        }
        if (cors.allowedOrigins !== undefined &&
            (!Array.isArray(cors.allowedOrigins) || !cors.allowedOrigins.every((origin) => typeof origin === "string"))) {
            throw commandError("Invalid CORS allowed origins.", "Set `security.cors.allowedOrigins` to an array of origin strings.");
        }
    }
    const csp = security.csp;
    if (csp !== undefined) {
        if (!csp || typeof csp !== "object" || Array.isArray(csp)) {
            throw commandError("Invalid CSP policy.", "Set `security.csp` to an object with `mode`.");
        }
        if (csp.mode !== undefined && csp.mode !== "report-only" && csp.mode !== "enforce") {
            throw commandError("Invalid CSP mode.", "Use `security.csp.mode` of `report-only` or `enforce`.");
        }
    }
}
export function resolveEffectiveSecurityPolicy(config, session) {
    const security = config.security ?? {};
    const cors = security.cors ?? {};
    const csp = security.csp ?? {};
    const publicDev = session === "public-dev";
    const dev = session === "dev" || publicDev;
    const configuredOrigins = [...(cors.allowedOrigins ?? [])];
    const devOrigins = dev && !publicDev ? ["http://localhost:*", "http://127.0.0.1:*"] : [];
    const allowedOrigins = publicDev ? ["*"] : configuredOrigins;
    return {
        cors: {
            sameOrigin: !publicDev,
            publicDev,
            allowedOrigins,
            allowedOriginPatterns: devOrigins,
            requireExplicitCrossOrigin: !dev && configuredOrigins.length === 0,
        },
        headers: {
            contentTypeOptions: "nosniff",
            referrerPolicy: "no-referrer",
            frameOptions: "DENY",
            permissionsPolicy: "camera=(), microphone=(), geolocation=()",
            crossOriginOpenerPolicy: "same-origin",
            suppressTechnologyHeaders: true,
        },
        csp: {
            mode: csp.mode ?? "report-only",
            header: (csp.mode ?? "report-only") === "enforce" ? "content-security-policy" : "content-security-policy-report-only",
            directives: {
                ...DEFAULT_CSP_DIRECTIVES,
                ...(csp.directives ?? {}),
            },
        },
    };
}
export async function resolveLocalContainerSshAccess(config, projectDir) {
    const lines = await resolveAuthorizedKeyLines(config.ssh, projectDir);
    if (lines.length === 0) {
        return { enabled: false, authorizedKeysPath: null, keyCount: 0 };
    }
    const sshDir = path.join(projectDir, ".sporades", "ssh");
    const authorizedKeysPath = path.join(sshDir, "authorized_keys");
    await mkdir(sshDir, { recursive: true });
    await writeFile(authorizedKeysPath, `${lines.join("\n")}\n`, { mode: 0o644 });
    await chmod(authorizedKeysPath, 0o644);
    return {
        enabled: true,
        authorizedKeysPath,
        keyCount: lines.length,
        fingerprints: lines.map(authorizedKeyFingerprint),
    };
}
export async function resolveAuthorizedKeyLines(ssh, projectDir) {
    if (ssh === undefined) {
        return [];
    }
    if (!ssh || typeof ssh !== "object" || Array.isArray(ssh)) {
        throw commandError("Invalid SSH access configuration.", "Set `ssh` in sporades.json to an object with `authorizedKeys`.");
    }
    if (ssh.authorizedKeys === undefined) {
        return [];
    }
    if (!Array.isArray(ssh.authorizedKeys)) {
        throw commandError("Invalid SSH authorized keys configuration.", "Set `ssh.authorizedKeys` to an array of objects with exactly one of `key` or `file`.");
    }
    const lines = [];
    for (let index = 0; index < ssh.authorizedKeys.length; index += 1) {
        const entry = ssh.authorizedKeys[index];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw commandError(`Invalid SSH authorized key entry at ssh.authorizedKeys[${index}].`, "Use an object with exactly one of `key` or `file`.");
        }
        const hasKey = typeof entry.key === "string";
        const hasFile = typeof entry.file === "string";
        if (hasKey === hasFile) {
            throw commandError(`Invalid SSH authorized key entry at ssh.authorizedKeys[${index}].`, "Use exactly one of `key` or `file` for each SSH authorized key entry.");
        }
        const material = hasKey
            ? entry.key
            : await readAuthorizedKeysFile(resolveProjectFileReference(entry.file, projectDir), index);
        lines.push(...normaliseAuthorizedKeyMaterial(material, `ssh.authorizedKeys[${index}]`));
    }
    return lines;
}
export function authorizedKeyFingerprint(line) {
    const parts = line.split(/\s+/);
    const keyTypeIndex = parts.findIndex((part) => isOpenSshPublicKeyType(part));
    const digest = createHash("sha256").update(Buffer.from(parts[keyTypeIndex + 1], "base64")).digest("base64").replace(/=+$/, "");
    return `SHA256:${digest}`;
}
export function withRuntimeSecuritySession(config, session) {
    return {
        ...config,
        __sporadesSession: session,
    };
}
export function readBaseImageUpdatePolicy(config) {
    return normaliseBaseImageUpdatePolicy(config?.baseImage?.updatePolicy ?? config?.deploy?.baseImageUpdatePolicy);
}
async function readRequiredFile(filePath, message, hint) {
    try {
        return await readFile(filePath, "utf8");
    }
    catch (error) {
        if (errorDetails(error).code === "ENOENT") {
            throw commandError(message, hint);
        }
        throw error;
    }
}
async function readAuthorizedKeysFile(filePath, index) {
    try {
        return await readFile(filePath, "utf8");
    }
    catch {
        throw commandError(`Unable to read SSH authorized key file at ssh.authorizedKeys[${index}].`, "Check the `file` path is readable from this machine before running `sporades deploy`.");
    }
}
function resolveProjectFileReference(filePath, projectDir) {
    if (filePath.startsWith("~/")) {
        const home = process.env.HOME;
        if (home) {
            return path.join(home, filePath.slice(2));
        }
    }
    if (path.isAbsolute(filePath)) {
        return filePath;
    }
    return path.join(projectDir, filePath);
}
function normaliseAuthorizedKeyMaterial(material, source) {
    if (looksLikePrivateKey(material)) {
        throw commandError(`SSH authorized key material at ${source} looks like a private key.`, "Provide public authorized_keys material only, such as an `id_ed25519.pub` file.");
    }
    return material
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line, index) => {
        validateAuthorizedKeyLine(line, `${source}${material.includes("\n") ? ` line ${index + 1}` : ""}`);
        return line;
    });
}
function looksLikePrivateKey(material) {
    return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(material);
}
function validateAuthorizedKeyLine(line, source) {
    const parts = line.split(/\s+/);
    const keyTypeIndex = parts.findIndex((part) => isOpenSshPublicKeyType(part));
    if (keyTypeIndex < 0 || !parts[keyTypeIndex + 1]) {
        throw malformedAuthorizedKeyError(source);
    }
    const keyType = parts[keyTypeIndex];
    const blob = decodeAuthorizedKeyBlob(parts[keyTypeIndex + 1]);
    if (!blob || !isValidOpenSshPublicKeyBlob(keyType, blob)) {
        throw malformedAuthorizedKeyError(source);
    }
}
function isOpenSshPublicKeyType(value) {
    return /^(ssh-(rsa|dss|ed25519)(-cert-v01@openssh\.com)?|ecdsa-sha2-nistp(256|384|521)(-cert-v01@openssh\.com)?|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/.test(value);
}
function malformedAuthorizedKeyError(source) {
    return commandError(`Malformed SSH authorized key material at ${source}.`, "Use OpenSSH authorized_keys-compatible public key lines.");
}
function decodeAuthorizedKeyBlob(value) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
        return null;
    }
    const blob = Buffer.from(value, "base64");
    if (blob.length === 0) {
        return null;
    }
    const canonical = blob.toString("base64").replace(/=+$/, "");
    if (canonical !== value.replace(/=+$/, "")) {
        return null;
    }
    return blob;
}
function isValidOpenSshPublicKeyBlob(keyType, blob) {
    const first = readSshString(blob, 0);
    if (!first || first.value.toString("ascii") !== keyType) {
        return false;
    }
    if (keyType === "ssh-ed25519") {
        const publicKey = readSshString(blob, first.offset);
        return Boolean(publicKey && publicKey.value.length === 32 && publicKey.offset === blob.length);
    }
    if (keyType === "sk-ssh-ed25519@openssh.com") {
        const publicKey = readSshString(blob, first.offset);
        const application = publicKey ? readSshString(blob, publicKey.offset) : null;
        return Boolean(publicKey && publicKey.value.length === 32 && application && application.value.length > 0 && application.offset === blob.length);
    }
    if (keyType.startsWith("ecdsa-sha2-")) {
        const curve = readSshString(blob, first.offset);
        const publicKey = curve ? readSshString(blob, curve.offset) : null;
        return Boolean(curve && curve.value.length > 0 && publicKey && publicKey.value.length > 0 && publicKey.offset === blob.length);
    }
    if (keyType === "sk-ecdsa-sha2-nistp256@openssh.com") {
        const curve = readSshString(blob, first.offset);
        const publicKey = curve ? readSshString(blob, curve.offset) : null;
        const application = publicKey ? readSshString(blob, publicKey.offset) : null;
        return Boolean(curve && curve.value.length > 0 && publicKey && publicKey.value.length > 0 && application && application.value.length > 0 && application.offset === blob.length);
    }
    if (keyType === "ssh-rsa") {
        const exponent = readSshString(blob, first.offset);
        const modulus = exponent ? readSshString(blob, exponent.offset) : null;
        return Boolean(exponent && exponent.value.length > 0 && modulus && modulus.value.length > 0 && modulus.offset === blob.length);
    }
    if (keyType === "ssh-dss") {
        let offset = first.offset;
        for (let index = 0; index < 4; index += 1) {
            const part = readSshString(blob, offset);
            if (!part || part.value.length === 0) {
                return false;
            }
            offset = part.offset;
        }
        return offset === blob.length;
    }
    return keyType.includes("-cert-v01@openssh.com") && first.offset < blob.length;
}
function readSshString(blob, offset) {
    if (offset + 4 > blob.length) {
        return null;
    }
    const length = blob.readUInt32BE(offset);
    const start = offset + 4;
    const end = start + length;
    if (length <= 0 || end > blob.length) {
        return null;
    }
    return { value: blob.subarray(start, end), offset: end };
}
//# sourceMappingURL=project-config.js.map