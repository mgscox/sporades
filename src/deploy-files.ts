import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, link, rename, rm, realpath } from "node:fs/promises";

export type DeployFile = { path: string; update: "replace" | "preserve" };
export type PreservedSeed = { root: string; path: string; dev: number; ino: number; sha256: string };
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

async function assertDeployFile(root: string, relative: string, recoverSeed = false) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Unsafe deploy.files root: ${root}`);
  let current = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info = await lstat(current);
    // A crash after no-clobber publication can leave our temporary hard link.
    // Recover only a matching, privately named seed inode in the same directory.
    if (recoverSeed && index === parts.length - 1 && info.isFile() && info.nlink === 2) {
      for (const entry of await readdir(path.dirname(current))) {
        if (!/^\.(?:seed|rollback)-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry)) continue;
        const seed = path.join(path.dirname(current), entry);
        const candidate = await lstat(seed).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
        if (candidate?.isFile() && candidate.dev === info.dev && candidate.ino === info.ino) {
          await rm(seed, { force: true });
          info = await lstat(current);
          break;
        }
      }
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || (recoverSeed && info.nlink !== 1))) {
      throw new Error(`deploy.files requires regular files without symlinks: ${relative}`);
    }
  }
  return current;
}

export async function assertPreservedDeployFile(root: string, relative: string) {
  return assertDeployFile(root, relative, true);
}

// Node does not expose openat. Linux's descriptor paths let each directory
// remain pinned while opening its child; Darwin provides O_NOFOLLOW_ANY.
async function readDeployFile(root: string, relative: string) {
  root = path.resolve(root);
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const handles: FileHandle[] = [rootHandle];
  try {
    const identity = await rootHandle.stat();
    await assertDeployFile(root, relative);
    const rootNow = await lstat(root);
    if (rootNow.isSymbolicLink() || rootNow.dev !== identity.dev || rootNow.ino !== identity.ino) throw new Error("deploy.files project root changed during the build.");
    let file: FileHandle;
    let checkRoot: (() => Promise<void>) | undefined;
    if (process.platform === "darwin") {
      // Resolve only ancestors, never a replacement symlink at the project root.
      const canonicalRoot = path.join(await realpath(path.dirname(root)), path.basename(root));
      checkRoot = async () => {
        const current = await lstat(canonicalRoot);
        if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("deploy.files project root changed during the build.");
      };
      await checkRoot();
      const O_NOFOLLOW_ANY = 0x20000000; // Darwin sys/fcntl.h
      file = await open(path.join(canonicalRoot, relative), constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY);
    } else if (process.platform === "linux") {
      let directory = rootHandle;
      const parts = relative.split("/");
      for (const part of parts.slice(0, -1)) {
        directory = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(directory);
      }
      file = await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } else {
      throw new Error("Secure deploy.files reads require macOS or Linux.");
    }
    handles.push(file);
    await checkRoot?.();
    if (!(await file.stat()).isFile()) throw new Error(`deploy.files requires a regular file: ${relative}`);
    return await file.readFile();
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

export async function buildDeployFiles(projectDir: string, value: unknown): Promise<BuiltDeployFile[]> {
  const result: BuiltDeployFile[] = [];
  for (const file of resolveDeployFiles(value)) {
    try {
      result.push({ ...file, contents: await readDeployFile(projectDir, file.path) });
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

// A surviving journal blocks another attempt until the interrupted runtime and
// seeds have been reconciled. Never silently adopt an uncommitted seed after exit.
export async function beginPreservedFileAttempt(preservedRoot: string, release: string, needed: boolean) {
  const journal = path.join(path.dirname(preservedRoot), "deploy-file-attempt.jsonl");
  if (!needed) {
    try { await lstat(journal); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    throw new Error(`Interrupted deploy.files attempt requires recovery: ${journal}`);
  }
  let handle: FileHandle;
  try { handle = await open(journal, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Interrupted deploy.files attempt requires recovery: ${journal}`);
    throw error;
  }
  try { await handle.writeFile(JSON.stringify({ release, preservedRoot }) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  return journal;
}

async function recordPreservedFileAttempt(journal: string | undefined, entry: object) {
  if (!journal) return;
  const handle = await open(journal, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try { await handle.writeFile(JSON.stringify(entry) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
}

export async function finishPreservedFileAttempt(journal?: string) {
  if (!journal) return;
  const handle = await open(journal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (!handle) return;
  let records: Array<{ temporary?: string }>;
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Unsafe deploy.files journal.");
    records = (await handle.readFile("utf8")).trim().split("\n").map((line) => JSON.parse(line));
  } finally { await handle.close(); }
  const root = path.join(path.dirname(journal), "preserved-files");
  for (const record of records) {
    if (record.temporary === undefined) continue;
    const relative = record.temporary;
    const resolved = path.resolve(root, relative);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.relative(root, resolved) !== relative || !/^\.seed-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path.basename(relative))) {
      throw new Error("Unsafe temporary seed path in deploy.files journal.");
    }
    try { await rm(await assertDeployFile(root, relative), { force: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await rm(journal, { force: true });
}

// Parent directories stay host-owned; only explicitly declared files are writable.
export async function preparePreservedFiles(files: DeployFile[], releaseRoot: string, preservedRoot: string, owner?: (handle: FileHandle, target: string, stats: Awaited<ReturnType<FileHandle["stat"]>>) => Promise<void>, created: PreservedSeed[] = [], journal?: string) {
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
      await assertPreservedDeployFile(preservedRoot, file.path);
      continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let handle;
    const temporary = path.join(path.dirname(destination), `.seed-${randomUUID()}`);
    try {
      await recordPreservedFileAttempt(journal, { temporary: path.relative(preservedRoot, temporary) });
      const contents = await readDeployFile(releaseRoot, file.path);
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(contents);
      if (owner) await owner(handle, destination, await handle.stat());
      const identity = await handle.stat();
      const seed = { root: preservedRoot, path: file.path, dev: identity.dev, ino: identity.ino, sha256: createHash("sha256").update(contents).digest("hex") };
      await recordPreservedFileAttempt(journal, seed);
      await link(temporary, destination);
      created.push(seed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
    await assertPreservedDeployFile(preservedRoot, file.path);
  }
}


// Move an attempted seed off its live pathname before inspecting the claimed inode.
// Retain claimed seeds for recovery: an editor may still hold an open descriptor.
export async function rollbackPreservedFiles(created: PreservedSeed[], hooks: {
  beforeClaim?: (target: string) => Promise<void>;
} = {}) {
  for (const seed of [...created].reverse()) {
    let handle: FileHandle | undefined;
    try {
      const target = await assertPreservedDeployFile(seed.root, seed.path);
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (info.dev !== seed.dev || info.ino !== seed.ino || info.nlink !== 1) continue;
      if (createHash("sha256").update(await handle.readFile()).digest("hex") !== seed.sha256) continue;
      await hooks.beforeClaim?.(target);
      const claimed = path.join(seed.root, `.rollback-${randomUUID()}`);
      await rename(target, claimed);
      const captured = await lstat(claimed);
      const sameSeed = captured.isFile() && captured.dev === info.dev && captured.ino === info.ino
        && createHash("sha256").update(await readFile(claimed)).digest("hex") === seed.sha256;
      if (!sameSeed) {
        // A concurrent replacement was captured. Restore without overwriting a
        // newer save; if the name is occupied, retain the captured recovery copy.
        try {
          await link(claimed, target);
          await rm(claimed);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { await handle?.close(); }
  }
}

export async function rethrowAfterDeployCleanup(error: unknown, cleanups: Array<() => Promise<unknown>>): Promise<never> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (failure) { failures.push(failure); }
  }
  if (failures.length) throw new AggregateError([error, ...failures], "Deployment failed and cleanup is incomplete.");
  throw error;
}

export function localPreservedFileAccessArgs(file: string, localUser: string, runtimeUser: string, image: string, mode = localUser === runtimeUser ? 0o600 : 0o660, expected?: { dev: number; ino: number }) {
  const uid = Number(localUser.split(":")[0]);
  const gid = Number(runtimeUser.split(":")[1]);
  // Docker provides the ownership operation; the unprivileged CLI keeps ownership.
  // Owner access supports ordinary local sessions, group access supports SSH's UID.
  const identityCheck = expected ? `if (s.dev !== ${expected.dev} || s.ino !== ${expected.ino}) process.exit(0);` : "";
  const script = `const fs = require("node:fs"); const fd = fs.openSync("/file", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const s = fs.fstatSync(fd); if (!s.isFile() || s.nlink !== 1) throw new Error("Unsafe preserved file"); ${identityCheck} fs.writeSync(1, JSON.stringify({ dev: s.dev, ino: s.ino, uid: s.uid, gid: s.gid, mode: s.mode & 0o777 })); fs.fchownSync(fd, ${uid}, ${gid}); fs.fchmodSync(fd, ${mode}); fs.closeSync(fd);`;
  return ["run", "--rm", "--network", "none", "--read-only", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE", "--user", "0:0", "--volume", `${file}:/file:rw`, image, "node", "-e", script];
}

export async function removeDeployFileSnapshot(runtimeDir: string, snapshot: unknown) {
  if (typeof snapshot === "string"
    && path.dirname(snapshot) === path.join(runtimeDir, "deploy-files")
    && /^[a-f0-9]{32}$/.test(path.basename(snapshot))) {
    await rm(snapshot, { recursive: true, force: true });
  }
}
