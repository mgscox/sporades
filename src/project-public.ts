import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { normalizePublicTreePath, PUBLIC_TREE_LIMITS, validatePublicTreeFileSet } from "./public-tree-contract.js";

type PublicFile = { path: string; contents: string | Uint8Array };

/** Merge explicitly public source files into the candidate, never the active tree. */
export async function mergeProjectPublicFiles(projectDir: string, generated: readonly PublicFile[]): Promise<PublicFile[]> {
  const root = path.join(await realpath(projectDir), "public");
  const info = await lstat(root).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return [...generated];
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid("public/ must be a real directory without symbolic links.");
  const files = [...generated];
  const claims = generated.map(file => ({ path: file.path, size: Buffer.byteLength(file.contents) }));
  const noFollow = process.platform === "darwin" ? 0x20000000 /* O_NOFOLLOW_ANY */ : constants.O_NOFOLLOW;

  async function visit(directory: string, relative: string, parent?: FileHandle) {
    // Linux descriptor paths pin every ancestor; Darwin rejects links in every
    // component. No source file is read through a project symlink.
    const target = process.platform === "linux" && parent
      ? `/proc/self/fd/${parent.fd}/${path.basename(directory)}` : directory;
    const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
    try {
      const entries = await readdir(process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : directory);
      for (const name of entries.sort()) {
        const filePath = relative ? `${relative}/${name}` : name;
        if (normalizePublicTreePath(filePath) === null) throw invalid("Public paths must be bounded safe relative POSIX paths.");
        if (filePath.split("/")[0].toLowerCase() === "__sporades") throw invalid("public/__sporades is reserved for Sporades HTTP routes.");
        const source = process.platform === "linux" ? `/proc/self/fd/${handle.fd}/${name}` : path.join(directory, name);
        const stats = await lstat(source);
        if (stats.isSymbolicLink()) throw invalid(`Replace the symbolic link at public/${filePath} with a regular file.`);
        if (stats.isDirectory()) {
          await visit(path.join(directory, name), filePath, handle);
          continue;
        }
        if (!stats.isFile()) throw invalid(`Remove the unsupported entry at public/${filePath}.`);
        const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) throw invalid("Public source changed during the build; retry.");
          const claim = { path: filePath, size: opened.size };
          const candidate = [...claims, claim];
          let validation = validatePublicTreeFileSet(candidate);
          // Reject case aliases on every platform: a macOS candidate must not
          // overwrite client.js with CLIENT.js while Linux treats them separately.
          if (validation.ok) validation = validatePublicTreeFileSet(candidate.map(file => ({ ...file, path: file.path.toLowerCase() })));
          if (!validation.ok) {
            const hints = {
              path: "Public paths must be bounded safe relative POSIX paths.",
              collision: `Conflicting public path: public/${filePath} collides with client output or another public path.`,
              files: `Public output may contain at most ${PUBLIC_TREE_LIMITS.files} files.`,
              "file-bytes": `public/${filePath} exceeds the per-file public output limit.`,
              "total-bytes": "Public output exceeds the aggregate size limit.",
              index: "Client output must contain a regular index.html file.",
            };
            throw invalid(hints[validation.reason]);
          }
          // Read only the admitted size plus one sentinel byte. Concurrent file
          // growth cannot bypass limits or allocate an unbounded readFile buffer.
          const contents = Buffer.alloc(opened.size + 1);
          let bytes = 0;
          while (bytes < contents.length) {
            const read = await file.read(contents, bytes, contents.length - bytes, bytes);
            if (read.bytesRead === 0) break;
            bytes += read.bytesRead;
          }
          const after = await file.stat();
          if (bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw invalid("Public source changed during the build; retry.");
          claims.push(claim);
          files.push({ path: filePath, contents: contents.subarray(0, bytes) });
        } finally { await file.close(); }
      }
    } finally { await handle.close(); }
  }

  await visit(root, "");
  return files;
}

function invalid(hint: string) {
  return Object.assign(new Error("Invalid public tree."), { hint });
}
