import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PUBLIC_TREE_LIMITS = {
  files: 512,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  pathBytes: 240,
} as const;

type PublicAsset = {
  body: Buffer;
  contentType: string;
  relativePath: string;
  html: boolean;
};

export async function replacePublicTree(
  buildDir: string,
  files: ReadonlyArray<{ path: string; contents: string | Uint8Array }>,
) {
  const publicDir = path.join(buildDir, "public");
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingDir = path.join(buildDir, `.public-staging-${nonce}`);
  const previousDir = path.join(buildDir, `.public-previous-${nonce}`);
  let previousMoved = false;
  const inputPaths = new Map<string, string>();

  await mkdir(stagingDir, { recursive: false });
  try {
    for (const file of files) {
      const relativePath = validateRelativePublicPath(file.path);
      const canonicalPath = relativePath.normalize("NFC");
      const collision = inputPaths.get(canonicalPath);
      if (collision) {
        throw publicTreeError(
          "Invalid public tree.",
          `Remove the normalization collision between ${collision} and ${relativePath}.`,
        );
      }
      inputPaths.set(canonicalPath, relativePath);
      const destination = path.join(stagingDir, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.contents);
    }
    await validatePublicTree(stagingDir);

    try {
      await rename(publicDir, previousDir);
      previousMoved = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    try {
      await rename(stagingDir, publicDir);
    } catch (error) {
      if (previousMoved) await rename(previousDir, publicDir);
      throw error;
    }
    if (previousMoved) await rm(previousDir, { recursive: true, force: true });
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  return publicDir;
}

export async function validatePublicTree(root: string) {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw publicTreeError("Invalid public tree.", "The public output root must be a real directory.");
  }

  const canonicalPaths = new Map<string, string>();
  let fileCount = 0;
  let totalBytes = 0;

  async function visit(directory: string, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      validateRelativePublicPath(relativePath);
      const canonicalPath = relativePath.normalize("NFC");
      const collision = canonicalPaths.get(canonicalPath);
      if (collision && collision !== relativePath) {
        throw publicTreeError(
          "Invalid public tree.",
          `Remove the normalization collision between ${collision} and ${relativePath}.`,
        );
      }
      canonicalPaths.set(canonicalPath, relativePath);

      const absolutePath = path.join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw publicTreeError("Invalid public tree.", `Replace the symbolic link at ${relativePath} with a regular file.`);
      }
      if (stats.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw publicTreeError("Invalid public tree.", `Remove the unsupported entry at ${relativePath}.`);
      }
      fileCount += 1;
      totalBytes += stats.size;
      if (fileCount > PUBLIC_TREE_LIMITS.files) {
        throw publicTreeError("Invalid public tree.", `Public output may contain at most ${PUBLIC_TREE_LIMITS.files} files.`);
      }
      if (stats.size > PUBLIC_TREE_LIMITS.fileBytes) {
        throw publicTreeError("Invalid public tree.", `${relativePath} exceeds the per-file public output limit.`);
      }
      if (totalBytes > PUBLIC_TREE_LIMITS.totalBytes) {
        throw publicTreeError("Invalid public tree.", "Public output exceeds the aggregate size limit.");
      }
    }
  }

  await visit(root);
  const indexStats = await lstat(path.join(root, "index.html")).catch(() => null);
  if (!indexStats?.isFile() || indexStats.isSymbolicLink()) {
    throw publicTreeError("Invalid public tree.", "Client output must contain a regular index.html file.");
  }

  return { fileCount, totalBytes };
}

export async function readPublicAsset(root: string, rawPathname: string): Promise<PublicAsset | null> {
  const rootStats = await lstat(root).catch((error) => {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
    throw error;
  });
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return null;
  const relativePath = publicPathFromRequest(rawPathname);
  if (!relativePath) return null;

  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stats = await lstat(current).catch((error) => {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
      throw error;
    });
    if (!stats || stats.isSymbolicLink()) return null;
  }
  const stats = await lstat(current);
  if (!stats.isFile() || stats.size > PUBLIC_TREE_LIMITS.fileBytes) return null;

  return {
    body: await readFile(current),
    contentType: publicContentType(relativePath),
    relativePath,
    html: relativePath === "index.html",
  };
}

function publicPathFromRequest(rawPathname: string) {
  if (/%2f|%5c/i.test(rawPathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (decoded === "/") return "index.html";
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return null;
  if (/%[0-9a-f]{2}/i.test(decoded)) return null;
  try {
    return validateRelativePublicPath(decoded.slice(1));
  } catch {
    return null;
  }
}

function validateRelativePublicPath(value: string) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw publicTreeError("Invalid public path.", "Public paths must be safe relative POSIX paths.");
  }
  if (Buffer.byteLength(value, "utf8") > PUBLIC_TREE_LIMITS.pathBytes) {
    throw publicTreeError("Invalid public path.", `Public paths may be at most ${PUBLIC_TREE_LIMITS.pathBytes} bytes.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw publicTreeError("Invalid public path.", "Public paths cannot be empty, current-directory, or parent-directory paths.");
  }
  return segments.join("/");
}

function publicContentType(relativePath: string) {
  switch (path.extname(relativePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function publicTreeError(message: string, hint: string) {
  return Object.assign(new Error(message), { hint });
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
}
