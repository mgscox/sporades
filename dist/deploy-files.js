import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, link, rm } from "node:fs/promises";
// Paths owned by the runtime, including legacy release paths and writable data.
const RESERVED = [".sporades", "public", "data", "server.mjs", "client.js", "index.html", "sporades.json", ".env.sporades.server"];
export function resolveDeployFiles(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error("deploy.files must be an array.");
    const root = path.resolve("/app");
    const files = value.map((entry) => {
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
        if (update !== "replace" && update !== "preserve")
            throw new Error(`Invalid deploy.files update for ${entry.path}: use replace or preserve.`);
        return { path: normalized, update };
    });
    const seen = [];
    for (const file of files) {
        const name = file.path.normalize("NFC");
        if (seen.some((other) => name === other || name.startsWith(`${other}/`) || other.startsWith(`${name}/`))) {
            throw new Error(`Conflicting deploy.files paths: ${file.path}`);
        }
        seen.push(name);
    }
    return files;
}
async function assertDeployFile(root, relative, recoverSeed = false) {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new Error(`Unsafe deploy.files root: ${root}`);
    let current = root;
    const parts = relative.split("/");
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        let info = await lstat(current);
        // A crash after no-clobber publication can leave our temporary hard link.
        // Recover only a matching, privately named seed inode in the same directory.
        if (recoverSeed && index === parts.length - 1 && info.isFile() && info.nlink === 2) {
            for (const entry of await readdir(path.dirname(current))) {
                if (!/^\.seed-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry))
                    continue;
                const seed = path.join(path.dirname(current), entry);
                const candidate = await lstat(seed).catch((error) => { if (error.code !== "ENOENT")
                    throw error; return null; });
                if (candidate?.isFile() && candidate.dev === info.dev && candidate.ino === info.ino) {
                    await rm(seed, { force: true });
                    info = await lstat(current);
                    break;
                }
            }
        }
        if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
            throw new Error(`deploy.files requires regular files without symlinks: ${relative}`);
        }
    }
    return current;
}
export async function assertPreservedDeployFile(root, relative) {
    return assertDeployFile(root, relative, true);
}
export async function buildDeployFiles(projectDir, value) {
    const result = [];
    for (const file of resolveDeployFiles(value)) {
        try {
            result.push({ ...file, contents: await readFile(await assertDeployFile(projectDir, file.path)) });
        }
        catch (error) {
            throw new Error(`Cannot build deploy.files entry ${file.path}: ${error.message}`);
        }
    }
    return result;
}
export function deployFileMounts(files, releaseRoot, preservedRoot) {
    return files.map((file) => ({
        host: path.join(file.update === "preserve" ? preservedRoot : releaseRoot, file.path),
        container: `/app/${file.path}`,
        mode: file.update === "preserve" ? "rw" : "ro",
    }));
}
// Parent directories stay host-owned; only explicitly declared files are writable.
export async function preparePreservedFiles(files, releaseRoot, preservedRoot, owner, created = []) {
    for (const file of files.filter((entry) => entry.update === "preserve")) {
        let directory = preservedRoot;
        for (const part of ["", ...file.path.split("/").slice(0, -1)]) {
            directory = path.join(directory, part);
            await mkdir(directory, { mode: 0o755 }).catch((error) => { if (error.code !== "EEXIST")
                throw error; });
            if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) {
                throw new Error(`Unsafe preserved deploy.files directory: ${file.path}`);
            }
        }
        const destination = path.join(preservedRoot, file.path);
        try {
            await assertPreservedDeployFile(preservedRoot, file.path);
            continue;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        let handle;
        const temporary = path.join(path.dirname(destination), `.seed-${randomUUID()}`);
        try {
            const contents = await readFile(await assertDeployFile(releaseRoot, file.path));
            handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            await handle.writeFile(contents);
            if (owner)
                await owner(handle, destination, await handle.stat());
            const identity = await handle.stat();
            await link(temporary, destination);
            created.push({ root: preservedRoot, path: file.path, dev: identity.dev, ino: identity.ino, sha256: createHash("sha256").update(contents).digest("hex") });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        finally {
            await handle?.close();
            await rm(temporary, { force: true });
        }
        await assertPreservedDeployFile(preservedRoot, file.path);
    }
}
// Roll back only this attempt's unchanged seeds. Retain any operator/runtime edits.
export async function rollbackPreservedFiles(created) {
    for (const seed of [...created].reverse()) {
        let handle;
        try {
            const target = await assertPreservedDeployFile(seed.root, seed.path);
            handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
            const info = await handle.stat();
            if (info.dev !== seed.dev || info.ino !== seed.ino || info.nlink !== 1)
                continue;
            if (createHash("sha256").update(await handle.readFile()).digest("hex") !== seed.sha256)
                continue;
            const current = await lstat(target);
            if (current.dev === info.dev && current.ino === info.ino && current.mtimeMs === info.mtimeMs && current.ctimeMs === info.ctimeMs)
                await rm(target);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        finally {
            await handle?.close();
        }
    }
}
export function localPreservedFileAccessArgs(file, localUser, runtimeUser, image) {
    const uid = Number(localUser.split(":")[0]);
    const gid = Number(runtimeUser.split(":")[1]);
    // Docker provides the ownership operation; the unprivileged CLI keeps ownership.
    // Owner access supports ordinary local sessions, group access supports SSH's UID.
    const script = `const fs = require("node:fs"); const fd = fs.openSync("/file", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const s = fs.fstatSync(fd); if (!s.isFile() || s.nlink !== 1) throw new Error("Unsafe preserved file"); fs.fchownSync(fd, ${uid}, ${gid}); fs.fchmodSync(fd, 0o660); fs.closeSync(fd);`;
    return ["run", "--rm", "--network", "none", "--read-only", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE", "--user", "0:0", "--volume", `${file}:/file:rw`, image, "node", "-e", script];
}
export async function removeDeployFileSnapshot(runtimeDir, snapshot) {
    if (typeof snapshot === "string"
        && path.dirname(snapshot) === path.join(runtimeDir, "deploy-files")
        && /^[a-f0-9]{32}$/.test(path.basename(snapshot))) {
        await rm(snapshot, { recursive: true, force: true });
    }
}
//# sourceMappingURL=deploy-files.js.map