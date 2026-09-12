import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, stat, open, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDeployFiles, resolveDeployFiles, preparePreservedFiles, deployFileMounts, assertPreservedDeployFile, rollbackPreservedFiles, localPreservedFileAccessArgs, rethrowAfterDeployCleanup } from "../dist/deploy-files.js";
import { createBundle } from "../dist/bundle-pipeline.js";

async function temporary(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "deploy-files-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("deploy.files resolves contained paths and defaults to replace", () => {
  assert.deepEqual(resolveDeployFiles([{ path: "config/../settings.json" }, { path: "nested/a.json", update: "preserve" }]), [
    { path: "settings.json", update: "replace" }, { path: "nested/a.json", update: "preserve" },
  ]);
  assert.deepEqual(resolveDeployFiles(undefined), []);
  for (const file of ["../escape", "/absolute", ".", "config/../../escape", ".sporades/build/x", "public/logo.png", "data/settings.json", "server.mjs", "sporades.json", "server.mjs/x", "a:b", "a\nb", "-C"]) {
    assert.throws(() => resolveDeployFiles([{ path: file }]), /deploy.files/);
  }
  for (const entries of [[{ path: "a" }, { path: "./a" }], [{ path: "a" }, { path: "a/b" }], [{ path: "a", update: "typo" }]]) {
    assert.throws(() => resolveDeployFiles(entries), /deploy.files/);
  }
});

test("missing deploy.files fails the local bundle before compilation; symlink files and parents fail", async () => temporary(async (root) => {
  await assert.rejects(createBundle(root, { deploy: { files: [{ path: "missing.json" }] } }), /Cannot build deploy.files entry missing.json/);
  await mkdir(path.join(root, "config"));
  await writeFile(path.join(root, "config", "settings.json"), "original");
  const snapshot = await buildDeployFiles(root, [{ path: "config/settings.json" }]);
  await writeFile(path.join(root, "config", "settings.json"), "changed");
  assert.equal(snapshot[0].contents.toString(), "original");
  await symlink(path.join(root, "config"), path.join(root, "linked"));
  await symlink(path.join(root, "config", "settings.json"), path.join(root, "link.json"));
  for (const file of ["linked/settings.json", "link.json", "config"]) {
    await assert.rejects(buildDeployFiles(root, [{ path: file }]), /regular files without symlinks/);
  }
}));

test("preserved files seed once, survive removal and policy switches, and reject stored symlinks", async () => temporary(async (root) => {
  const source = path.join(root, "release");
  const stored = path.join(root, "preserved");
  await mkdir(path.join(source, "config"), { recursive: true });
  await writeFile(path.join(source, "config/settings.json"), "seed");
  const preserve = resolveDeployFiles([{ path: "config/settings.json", update: "preserve" }]);
  await preparePreservedFiles(preserve, source, stored);
  await writeFile(path.join(stored, "config/settings.json"), "server edit");
  await writeFile(path.join(source, "config/settings.json"), "new seed");
  await preparePreservedFiles(preserve, source, stored);
  await preparePreservedFiles([], source, stored);
  const replace = resolveDeployFiles([{ path: "config/settings.json" }]);
  await preparePreservedFiles(replace, source, stored);
  assert.equal(await readFile(path.join(stored, "config/settings.json"), "utf8"), "server edit");
  assert.equal(deployFileMounts(replace, source, stored)[0].host, path.join(source, "config/settings.json"));
  assert.equal(deployFileMounts(preserve, source, stored)[0].mode, "rw");
  await rm(path.join(stored, "config/settings.json"));
  await symlink(path.join(source, "config/settings.json"), path.join(stored, "config/settings.json"));
  await assert.rejects(preparePreservedFiles(preserve, source, stored), /without symlinks/);
}));


test("preserved deploy.files recovers a seed publication interrupted before temporary-link cleanup", async () => temporary(async (root) => {
  const source = path.join(root, "release");
  const stored = path.join(root, "stored");
  await mkdir(source); await mkdir(stored);
  await writeFile(path.join(source, "settings.json"), "new seed");
  const seed = path.join(stored, ".seed-00000000-0000-4000-8000-000000000000");
  await writeFile(seed, "published before crash");
  const destination = path.join(stored, "settings.json");
  await link(seed, destination);
  assert.equal((await stat(destination)).nlink, 2);
  // Restart validates stored files without rerunning deployment.
  await assertPreservedDeployFile(stored, "settings.json");
  assert.equal((await stat(destination)).nlink, 1);
  await preparePreservedFiles([{ path: "settings.json", update: "preserve" }], source, stored);
  assert.equal(await readFile(destination, "utf8"), "published before crash");
  await assert.rejects(stat(seed), { code: "ENOENT" });
  await link(destination, path.join(stored, "unrelated.json"));
  await assert.rejects(assertPreservedDeployFile(stored, "settings.json"), /regular files/);
}));


test("failed seed transactions remove only newly published unchanged files", async () => temporary(async (root) => {
  const source = path.join(root, "release"); const stored = path.join(root, "stored");
  await mkdir(source);
  for (const file of ["new.json", "edited.json", "replaced.json", "existing.json"]) await writeFile(path.join(source, file), "seed");
  await preparePreservedFiles([{ path: "existing.json", update: "preserve" }], source, stored);
  const created = [];
  await preparePreservedFiles(["new.json", "edited.json", "replaced.json", "existing.json"].map((file) => ({ path: file, update: "preserve" })), source, stored, undefined, created);
  await writeFile(path.join(stored, "edited.json"), "operator edit");
  await rm(path.join(stored, "replaced.json"));
  await writeFile(path.join(stored, "replaced.json"), "replacement");
  await rollbackPreservedFiles(created);
  await assert.rejects(stat(path.join(stored, "new.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(stored, "existing.json"), "utf8"), "seed");
  assert.equal(await readFile(path.join(stored, "edited.json"), "utf8"), "operator edit");
  assert.equal(await readFile(path.join(stored, "replaced.json"), "utf8"), "replacement");
}));

test("local preserved-file access keeps the CLI owner and grants the SSH runtime group on one mount", () => {
  const args = localPreservedFileAccessArgs("/project/.sporades/preserved-files/settings.json", "501:20", "10001:10001", "image");
  assert.equal(args[args.indexOf("--user") + 1], "0:0");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args.filter((arg) => arg === "--volume").length, 1);
  assert(args.includes("/project/.sporades/preserved-files/settings.json:/file:rw"));
  assert.match(args.at(-1), /fchownSync\(fd, 501, 10001\)/);
  assert.match(args.at(-1), /fchmodSync\(fd, 432\)/);
  const privateArgs = localPreservedFileAccessArgs("/settings.json", "501:20", "501:20", "image");
  assert.match(privateArgs.at(-1), /fchownSync\(fd, 501, 20\)/);
  assert.match(privateArgs.at(-1), /fchmodSync\(fd, 384\)/);

});


test("seed rollback retains atomic-save replacements made at the claim boundary", async () => temporary(async (root) => {
  const source = path.join(root, "release"); const stored = path.join(root, "stored");
  await mkdir(source); await writeFile(path.join(source, "settings.json"), "seed");
  const created = [];
  await preparePreservedFiles([{ path: "settings.json", update: "preserve" }], source, stored, undefined, created);
  await rollbackPreservedFiles(created, { beforeClaim: async (target) => {
    await rm(target); await writeFile(target, "atomic save");
  } });
  assert.equal(await readFile(path.join(stored, "settings.json"), "utf8"), "atomic save");
  assert.equal((await stat(path.join(stored, "settings.json"))).nlink, 1);
}));

test("seed rollback retains edits through an open descriptor after the seed is claimed", async () => temporary(async (root) => {
  const source = path.join(root, "release"); const stored = path.join(root, "stored");
  await mkdir(source); await writeFile(path.join(source, "settings.json"), "seed");
  const created = [];
  await preparePreservedFiles([{ path: "settings.json", update: "preserve" }], source, stored, undefined, created);
  const writer = await open(path.join(stored, "settings.json"), "r+");
  try {
    await rollbackPreservedFiles(created);
    await writer.write("late edit", 0, "utf8");
  } finally { await writer.close(); }
  await assert.rejects(stat(path.join(stored, "settings.json")), { code: "ENOENT" });
  const recovery = (await readdir(stored)).find((entry) => entry.startsWith(".rollback-"));
  assert.equal(await readFile(path.join(stored, recovery), "utf8"), "late edit");
}));

test("deployment cleanup attempts core restoration even when another cleanup fails", async () => {
  const attempted = [];
  const original = new Error("install failed");
  await assert.rejects(rethrowAfterDeployCleanup(original, [
    async () => { attempted.push("seed"); throw new Error("cleanup denied"); },
    async () => { attempted.push("pointer"); },
    async () => { attempted.push("release"); },
  ]), (error) => error instanceof AggregateError && error.errors[0] === original);
  assert.deepEqual(attempted, ["seed", "pointer", "release"]);
});
