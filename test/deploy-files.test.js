import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, stat, open, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preservedDeployFilePath, attemptJournalPath, assertNoPreservedFileAttempt, beginPreservedFileAttempt, finishPreservedFileAttempt, readPreservedFileAttempt, recordPreservedFileAttempt, localPreservedFileAccess, parseUserIdentity, preservedFileAccessMatches, buildDeployFiles, resolveDeployFiles, preparePreservedFiles, deployFileMounts, assertPreservedDeployFile, rollbackPreservedFiles, localPreservedFileAccessArgs, rethrowAfterDeployCleanup } from "../dist/deploy-files.js";
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

test("deploy.files rejects case aliases of managed paths before reading source files", async () => temporary(async (root) => {
  for (const file of [".SPORADES/data.db", "Public/index.html", "DATA/settings.json", "Server.MJS", "CLIENT.JS", "INDEX.HTML", "Sporades.JSON", ".ENV.SPORADES.SERVER", "config/../PUBLIC/asset"]) {
    assert.throws(() => resolveDeployFiles([{ path: file }]), /collides with Sporades-managed files/);
    await assert.rejects(buildDeployFiles(root, [{ path: file }]), /collides with Sporades-managed files/);
  }
  assert.deepEqual(resolveDeployFiles([{ path: "Publications/config.json" }, { path: "nested/Public/settings.json" }]), [
    { path: "Publications/config.json", update: "replace" }, { path: "nested/Public/settings.json", update: "replace" },
  ]);
}));

test("missing deploy.files fails the local bundle before compilation; symlink files and parents fail", async () => temporary(async (root) => {
  await assert.rejects(createBundle(root, { deploy: { files: [{ path: "missing.json" }] } }), /Cannot build deploy.files entry missing.json/);
  // Dev sessions use project files directly, so declared files are never read or validated there.
  await assert.rejects(createBundle(root, { deploy: { files: [{ path: "missing.json" }] } }, { deployFiles: false }), /Missing HTML shell/);
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
  await writeFile(preservedDeployFilePath(stored, "config/settings.json"), "server edit");
  await writeFile(path.join(source, "config/settings.json"), "new seed");
  await preparePreservedFiles(preserve, source, stored);
  await preparePreservedFiles([], source, stored);
  const replace = resolveDeployFiles([{ path: "config/settings.json" }]);
  await preparePreservedFiles(replace, source, stored);
  assert.equal(await readFile(preservedDeployFilePath(stored, "config/settings.json"), "utf8"), "server edit");
  assert.equal(deployFileMounts(replace, source, stored)[0].host, path.join(source, "config/settings.json"));
  assert.equal(deployFileMounts(preserve, source, stored)[0].mode, "rw");
  await rm(preservedDeployFilePath(stored, "config/settings.json"));
  await symlink(path.join(source, "config/settings.json"), preservedDeployFilePath(stored, "config/settings.json"));
  await assert.rejects(preparePreservedFiles(preserve, source, stored), /without symlinks/);
}));


test("preserved deploy.files recovers a seed publication interrupted before temporary-link cleanup", async () => temporary(async (root) => {
  const source = path.join(root, "release");
  const stored = path.join(root, "stored");
  await mkdir(source); await mkdir(stored);
  await writeFile(path.join(source, "settings.json"), "new seed");
  const seed = path.join(stored, ".seed-00000000-0000-4000-8000-000000000000");
  await writeFile(seed, "published before crash");
  const destination = preservedDeployFilePath(stored, "settings.json");
  await link(seed, destination);
  assert.equal((await stat(destination)).nlink, 2);
  // Restart validates stored files without rerunning deployment.
  await assertPreservedDeployFile(stored, "settings.json");
  assert.equal((await stat(destination)).nlink, 1);
  await preparePreservedFiles([{ path: "settings.json", update: "preserve" }], source, stored);
  assert.equal(await readFile(destination, "utf8"), "published before crash");
  await assert.rejects(stat(seed), { code: "ENOENT" });
  await link(destination, preservedDeployFilePath(stored, "unrelated.json"));
  await assert.rejects(assertPreservedDeployFile(stored, "settings.json"), /regular files/);
}));


test("failed seed transactions remove only newly published unchanged files", async () => temporary(async (root) => {
  const source = path.join(root, "release"); const stored = path.join(root, "stored");
  await mkdir(source);
  for (const file of ["new.json", "edited.json", "replaced.json", "existing.json"]) await writeFile(path.join(source, file), "seed");
  await preparePreservedFiles([{ path: "existing.json", update: "preserve" }], source, stored);
  const created = [];
  await preparePreservedFiles(["new.json", "edited.json", "replaced.json", "existing.json"].map((file) => ({ path: file, update: "preserve" })), source, stored, undefined, created);
  await writeFile(preservedDeployFilePath(stored, "edited.json"), "operator edit");
  await rm(preservedDeployFilePath(stored, "replaced.json"));
  await writeFile(preservedDeployFilePath(stored, "replaced.json"), "replacement");
  await rollbackPreservedFiles(created);
  await assert.rejects(stat(preservedDeployFilePath(stored, "new.json")), { code: "ENOENT" });
  assert.equal(await readFile(preservedDeployFilePath(stored, "existing.json"), "utf8"), "seed");
  assert.equal(await readFile(preservedDeployFilePath(stored, "edited.json"), "utf8"), "operator edit");
  assert.equal(await readFile(preservedDeployFilePath(stored, "replaced.json"), "utf8"), "replacement");
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
  assert.equal(await readFile(preservedDeployFilePath(stored, "settings.json"), "utf8"), "atomic save");
  assert.equal((await stat(preservedDeployFilePath(stored, "settings.json"))).nlink, 1);
}));

test("seed rollback retains edits through an open descriptor after the seed is claimed", async () => temporary(async (root) => {
  const source = path.join(root, "release"); const stored = path.join(root, "stored");
  await mkdir(source); await writeFile(path.join(source, "settings.json"), "seed");
  const created = [];
  await preparePreservedFiles([{ path: "settings.json", update: "preserve" }], source, stored, undefined, created);
  const writer = await open(preservedDeployFilePath(stored, "settings.json"), "r+");
  try {
    await rollbackPreservedFiles(created);
    await writer.write("late edit", 0, "utf8");
  } finally { await writer.close(); }
  await assert.rejects(stat(preservedDeployFilePath(stored, "settings.json")), { code: "ENOENT" });
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


test("deploy.files journals seed ownership before publication and blocks interrupted attempts", async () => {
  for (const duringLink of [false, true]) await temporary(async (root) => {
    const release = path.join(root, "release");
    const preserved = path.join(root, "preserved-files");
    await mkdir(release);
    await writeFile(path.join(release, "settings.json"), "uncommitted seed");
    const moduleUrl = new URL("../dist/deploy-files.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      if (${duringLink}) { const original = fs.promises.link; fs.promises.link = async (...args) => { await original(...args); process.exit(17); }; syncBuiltinESMExports(); }
      const { beginPreservedFileAttempt, preparePreservedFiles } = await import(${JSON.stringify(moduleUrl)});
      const journal = await beginPreservedFileAttempt(${JSON.stringify(preserved)}, 'attempt-one', true);
      await preparePreservedFiles([{ path: 'settings.json', update: 'preserve' }], ${JSON.stringify(release)}, ${JSON.stringify(preserved)}, undefined, [], journal);
      process.exit(17);
    `], { encoding: "utf8" });
    assert.equal(child.status, 17, child.stderr);
    const journal = path.join(root, "deploy-file-attempt.jsonl");
    const records = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(records[0].release, "attempt-one");
    assert.equal(records.find((record) => record.sha256).ino, (await stat(preservedDeployFilePath(preserved, "settings.json"))).ino);
    await assert.rejects(beginPreservedFileAttempt(preserved, "attempt-two", true), /requires recovery/);
    await assert.rejects(beginPreservedFileAttempt(preserved, "attempt-two", false), /requires recovery/);
    // Simulate explicit recovery after the interrupted runtime has been stopped.
    await rollbackPreservedFiles(records.filter((record) => record.sha256));
    await finishPreservedFileAttempt(journal);
    await assert.rejects(stat(preservedDeployFilePath(preserved, "settings.json")), { code: "ENOENT" });
    const retry = await beginPreservedFileAttempt(preserved, "attempt-two", true);
    await finishPreservedFileAttempt(retry);
  });
});


test("deploy.files snapshots regular hard-linked source files", async () => temporary(async (root) => {
  await writeFile(path.join(root, "settings.json"), "linked source");
  await link(path.join(root, "settings.json"), path.join(root, "alias.json"));
  const files = await buildDeployFiles(root, [{ path: "settings.json" }]);
  assert.equal(files[0].contents.toString(), "linked source");
}));

test("permission rollback uses the helper's actual inode and skips later replacements", async () => temporary(async (root) => {
  const target = path.join(root, "settings.json");
  await writeFile(target, "old inode", { mode: 0o600 });
  const old = await stat(target);
  await writeFile(path.join(root, "replacement"), "atomic save", { mode: 0o640 });
  await rename(path.join(root, "replacement"), target);
  const owner = `${process.getuid()}:${process.getgid()}`;
  const run = (args) => spawnSync(process.execPath, ["-e", args.at(-1).replace('"/file"', JSON.stringify(target))], { encoding: "utf8" });
  const grant = run(localPreservedFileAccessArgs(target, owner, owner, "test", 0o660));
  assert.equal(grant.status, 0, grant.stderr);
  const actual = JSON.parse(grant.stdout);
  assert.notEqual(actual.ino, old.ino);
  assert.equal(actual.ino, (await stat(target)).ino);
  assert.equal(actual.mode, 0o640);
  const restoreArgs = localPreservedFileAccessArgs(target, owner, owner, "test", actual.mode, actual);
  assert.equal(run(restoreArgs).status, 0);
  assert.equal((await stat(target)).mode & 0o777, 0o640);
  await writeFile(path.join(root, "newer"), "another save", { mode: 0o600 });
  await rename(path.join(root, "newer"), target);
  assert.equal(run(restoreArgs).status, 0);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
}));

test("deploy.files never follows source, parent or project-root symlink substitutions", async () => {
  for (const substitution of ["file", "parent", "root"]) await temporary(async (root) => {
    const project = path.join(root, "project");
    const outside = path.join(root, "outside");
    await mkdir(path.join(project, "config"), { recursive: true });
    await mkdir(path.join(outside, "config"), { recursive: true });
    await writeFile(path.join(outside, "config/settings.json"), "outside bytes");
    await writeFile(path.join(project, "config/settings.json"), "project bytes");
    await writeFile(path.join(outside, "settings.json"), "outside bytes");
    const moduleUrl = new URL("../dist/deploy-files.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
      const project = ${JSON.stringify(project)}; const outside = ${JSON.stringify(outside)};
      const original = fs.promises.lstat; let swapped = false;
      fs.promises.lstat = async function(file, ...args) {
        const result = await original.call(this, file, ...args);
        if (!swapped && (${JSON.stringify(substitution)} === 'root' ? String(file) === project : String(file).endsWith('/config/settings.json'))) {
          swapped = true;
          const target = ${JSON.stringify(substitution)} === 'root' ? project : ${JSON.stringify(substitution)} === 'parent' ? path.join(project, 'config') : path.join(project, 'config/settings.json');
          await fs.promises.rename(target, target + '.held');
          await fs.promises.symlink(${JSON.stringify(substitution)} !== 'file' ? outside : path.join(outside, 'settings.json'), target);
        }
        return result;
      }; syncBuiltinESMExports();
      const { buildDeployFiles } = await import(${JSON.stringify(moduleUrl)});
      try { await buildDeployFiles(project, [{ path: 'config/settings.json' }]); process.exit(19); }
      catch (error) { if (!swapped) process.exit(20); process.stdout.write(error.message); }
    `], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.match(child.stdout, /Cannot build deploy.files/);
    assert.doesNotMatch(child.stdout, /outside bytes/);
  });
});

test("deploy.files journals temporary seeds before open and write and cleans them before clearing", async () => {
  for (const phase of ["open", "write"]) await temporary(async (root) => {
    const release = path.join(root, "release");
    const preserved = path.join(root, "preserved-files");
    await mkdir(release);
    await writeFile(path.join(release, "settings.json"), "temporary bytes");
    const moduleUrl = new URL("../dist/deploy-files.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const original = fs.promises.open;
      fs.promises.open = async function(file, ...args) {
        const handle = await original.call(this, file, ...args);
        if (String(file).includes('/.seed-')) {
          if (${JSON.stringify(phase)} === 'open') process.exit(17);
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...values) => { await write(...values); process.exit(17); };
        }
        return handle;
      }; syncBuiltinESMExports();
      const { beginPreservedFileAttempt, preparePreservedFiles } = await import(${JSON.stringify(moduleUrl)});
      const journal = await beginPreservedFileAttempt(${JSON.stringify(preserved)}, 'attempt', true);
      await preparePreservedFiles([{ path: 'settings.json', update: 'preserve' }], ${JSON.stringify(release)}, ${JSON.stringify(preserved)}, undefined, [], journal);
    `], { encoding: "utf8" });
    assert.equal(child.status, 17, child.stderr);
    const journal = path.join(root, "deploy-file-attempt.jsonl");
    const records = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
    const seedPath = path.join(preserved, records.find((record) => record.temporary).temporary);
    assert.equal(await readFile(seedPath, "utf8"), phase === "write" ? "temporary bytes" : "");
    await finishPreservedFileAttempt(journal);
    await assert.rejects(stat(seedPath), { code: "ENOENT" });
    await assert.rejects(stat(journal), { code: "ENOENT" });
  });
});

test("deploy.files retains journals when temporary cleanup is unsafe", async () => temporary(async (root) => {
  const preserved = path.join(root, "preserved-files");
  await mkdir(preserved);
  const name = ".seed-12345678-1234-1234-1234-123456789abc";
  const outside = path.join(root, name);
  await writeFile(outside, "outside bytes");
  const journal = path.join(root, "deploy-file-attempt.jsonl");
  await writeFile(journal, JSON.stringify({ temporary: `../${name}` }) + "\n");
  await assert.rejects(finishPreservedFileAttempt(journal), /Unsafe temporary seed path/);
  assert.equal(await readFile(outside, "utf8"), "outside bytes");
  await stat(journal);
  await mkdir(path.join(preserved, name));
  await writeFile(journal, JSON.stringify({ temporary: name }) + "\n");
  await assert.rejects(finishPreservedFileAttempt(journal), /regular files/);
  await stat(journal);
}));

test("preserved path shapes coexist across manifests and recover their original bytes", async () => temporary(async (root) => {
  const source = path.join(root, "release"); const stored = path.join(root, "preserved-files");
  await mkdir(source);
  await writeFile(path.join(source, "config"), "ancestor seed");
  await preparePreservedFiles([{ path: "config", update: "preserve" }], source, stored);
  const ancestor = preservedDeployFilePath(stored, "config");
  await writeFile(ancestor, "ancestor edit");
  await rm(path.join(source, "config"));
  await mkdir(path.join(source, "config"));
  await writeFile(path.join(source, "config/settings.json"), "descendant seed");
  await preparePreservedFiles([{ path: "config/settings.json", update: "preserve" }], source, stored);
  const descendant = preservedDeployFilePath(stored, "config/settings.json");
  assert.notEqual(ancestor, descendant);
  assert.equal(await readFile(ancestor, "utf8"), "ancestor edit");
  assert.equal(await readFile(descendant, "utf8"), "descendant seed");
  await rm(path.join(source, "config"), { recursive: true });
  await writeFile(path.join(source, "config"), "new ancestor seed");
  await preparePreservedFiles([{ path: "config", update: "preserve" }], source, stored);
  assert.equal(await readFile(ancestor, "utf8"), "ancestor edit");
  assert.equal(await readFile(descendant, "utf8"), "descendant seed");
  assert.deepEqual(deployFileMounts([{ path: "config", update: "preserve" }], source, stored), [{ host: ancestor, container: "/app/config", mode: "rw" }]);
}));

test("attempt journals are readable for reconciliation and block lifecycle actions until finished", async () => temporary(async (root) => {
  const preservedRoot = path.join(root, "preserved-files");
  await mkdir(preservedRoot);
  const journal = attemptJournalPath(preservedRoot);
  assert.equal(journal, path.join(root, "deploy-file-attempt.jsonl"));
  assert.equal(await readPreservedFileAttempt(journal), null);
  await assertNoPreservedFileAttempt(preservedRoot);
  assert.equal(await beginPreservedFileAttempt(preservedRoot, "release-a", false), undefined);
  assert.equal(await beginPreservedFileAttempt(preservedRoot, "release-a", true), journal);
  await recordPreservedFileAttempt(journal, { candidate: { name: "app", transaction: "ab".repeat(16) } });
  await recordPreservedFileAttempt(journal, { temporary: ".seed-0123abcd-0123-0123-0123-0123456789ab" });
  await recordPreservedFileAttempt(journal, { root: preservedRoot, path: "settings.json", dev: 1, ino: 2, sha256: "c".repeat(64) });
  await assert.rejects(assertNoPreservedFileAttempt(preservedRoot), /requires recovery.*reconcile/);
  await assert.rejects(beginPreservedFileAttempt(preservedRoot, "release-b", true), /requires recovery/);
  const attempt = await readPreservedFileAttempt(journal);
  assert.equal(attempt.release, "release-a");
  assert.equal(attempt.preservedRoot, preservedRoot);
  assert.deepEqual(attempt.temporaries, [".seed-0123abcd-0123-0123-0123-0123456789ab"]);
  assert.deepEqual(attempt.seeds, [{ root: preservedRoot, path: "settings.json", dev: 1, ino: 2, sha256: "c".repeat(64) }]);
  assert.deepEqual(attempt.records[1], { candidate: { name: "app", transaction: "ab".repeat(16) } });
  await writeFile(path.join(preservedRoot, ".seed-0123abcd-0123-0123-0123-0123456789ab"), "stale");
  await finishPreservedFileAttempt(journal);
  await assert.rejects(stat(journal), { code: "ENOENT" });
  await assert.rejects(stat(path.join(preservedRoot, ".seed-0123abcd-0123-0123-0123-0123456789ab")), { code: "ENOENT" });
  await assertNoPreservedFileAttempt(preservedRoot);
}));

test("preserved file access policy derives owner, runtime group, and mode from user identities", () => {
  assert.deepEqual(parseUserIdentity("501:20"), { uid: 501, gid: 20 });
  assert.deepEqual(localPreservedFileAccess("501:20", "501:20"), { uid: 501, gid: 20, mode: 0o600 });
  assert.deepEqual(localPreservedFileAccess("501:20", "10001:10001"), { uid: 501, gid: 10001, mode: 0o660 });
  assert.equal(preservedFileAccessMatches({ uid: 501, gid: 10001, mode: 0o100660 }, localPreservedFileAccess("501:20", "10001:10001")), true);
  assert.equal(preservedFileAccessMatches({ uid: 501, gid: 20, mode: 0o100660 }, localPreservedFileAccess("501:20", "10001:10001")), false);
  assert.equal(preservedFileAccessMatches({ uid: 501, gid: 10001, mode: 0o100600 }, localPreservedFileAccess("501:20", "10001:10001")), false);
});
