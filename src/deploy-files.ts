import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, link, rm } from "node:fs/promises";

export type DeployFile = { path: string; update: "replace" | "preserve" };
export type BuiltDeployFile = DeployFile & { contents: Buffer };

// Paths owned by the runtime, including legacy release paths and writable data.
const RESERVED = [".sporades", "public", "data", "server.mjs", "client.js", "index.html", "sporades.json", ".env.sporades.server"];

export function resolveDeployFiles(value: unknown): DeployFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("deploy.files must be an array.");
  const root = path.resolve("/app");
  const files = value.map((entry): DeployFile => {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || !entry.path
      || path.isAbsolute(entry.path) || /[\\\x00-\x1f:]/.test(entry.path)) {
      throw new Error("Invalid deploy.files path: use a relative file path under the app root.");
    }
    const resolved = path.resolve(root, entry.path);
    const relative = path.relative(root, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`deploy.files path escapes the app root: ${entry.path}`);
    }
    for (const reserved of RESERVED) {
      const target = path.resolve(root, reserved);
      if (resolved === target || resolved.startsWith(`${target}${path.sep}`) || target.startsWith(`${resolved}${path.sep}`)) {
        throw new Error(`deploy.files path collides with Sporades-managed files: ${entry.path}`);
      }
    }
    const normalized = relative.split(path.sep).join("/");
    if (normalized.split("/").some((part) => part.startsWith("-") || part.startsWith("._") || part === "__MACOSX")) {
      throw new Error(`Unsupported deploy.files path: ${entry.path}`);
    }
    const update = entry.update === undefined ? "replace" : entry.update;
    if (update !== "replace" && update !== "preserve") throw new Error(`Invalid deploy.files update for ${entry.path}: use replace or preserve.`);
    return { path: normalized, update };
  });
  const seen: string[] = [];
  for (const file of files) {
    const name = file.path.normalize("NFC");
    if (seen.some((other) => name === other || name.startsWith(`${other}/`) || other.startsWith(`${name}/`))) {
      throw new Error(`Conflicting deploy.files paths: ${file.path}`);
    }
    seen.push(name);
  }
  return files;
}

export async function assertDeployFile(root: string, relative: string) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Unsafe deploy.files root: ${root}`);
  let current = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      throw new Error(`deploy.files requires regular files without symlinks: ${relative}`);
    }
  }
  return current;
}

export async function buildDeployFiles(projectDir: string, value: unknown): Promise<BuiltDeployFile[]> {
  const result: BuiltDeployFile[] = [];
  for (const file of resolveDeployFiles(value)) {
    try {
      result.push({ ...file, contents: await readFile(await assertDeployFile(projectDir, file.path)) });
    } catch (error) {
      throw new Error(`Cannot build deploy.files entry ${file.path}: ${(error as Error).message}`);
    }
  }
  return result;
}

export function deployFileMounts(files: DeployFile[], releaseRoot: string, preservedRoot: string) {
  return files.map((file) => ({
    host: path.join(file.update === "preserve" ? preservedRoot : releaseRoot, file.path),
    container: `/app/${file.path}`,
    mode: file.update === "preserve" ? "rw" : "ro",
  }));
}

// Parent directories stay host-owned; only explicitly declared files are writable.
export async function preparePreservedFiles(files: DeployFile[], releaseRoot: string, preservedRoot: string, owner?: string | ((handle: FileHandle, target: string, stats: Awaited<ReturnType<FileHandle["stat"]>>) => Promise<void>)) {
  for (const file of files.filter((entry) => entry.update === "preserve")) {
    let directory = preservedRoot;
    for (const part of ["", ...file.path.split("/").slice(0, -1)]) {
      directory = path.join(directory, part);
      await mkdir(directory, { mode: 0o755 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) {
        throw new Error(`Unsafe preserved deploy.files directory: ${file.path}`);
      }
    }
    const destination = path.join(preservedRoot, file.path);
    try {
      await assertDeployFile(preservedRoot, file.path);
      continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let handle;
    const temporary = path.join(path.dirname(destination), `.seed-${randomUUID()}`);
    try {
      const contents = await readFile(await assertDeployFile(releaseRoot, file.path));
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(contents);
      if (typeof owner === "function") await owner(handle, destination, await handle.stat());
      else if (owner) {
        const [uid, gid] = owner.split(":").map(Number);
        const stats = await handle.stat();
        if (stats.uid !== uid || stats.gid !== gid) await handle.chown(uid, gid);
      }
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
    await assertDeployFile(preservedRoot, file.path);
  }
}
