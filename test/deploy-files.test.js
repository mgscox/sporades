import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDeployFiles, resolveDeployFiles, preparePreservedFiles, deployFileMounts } from "../dist/deploy-files.js";
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
