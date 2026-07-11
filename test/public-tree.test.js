import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { publishLegacyBundles } from "../dist/bundle-pipeline.js";
import {
  normalizePublicTreePath,
  publicTreePathFromRequest,
  validatePublicTreeFileSet,
} from "../dist/public-tree-contract.js";
import {
  PUBLIC_TREE_LIMITS,
  cleanupPublicTrees,
  createPublicTree,
  discardPublicTree,
  getProcessStartIdentity,
  publishOwnerHeartbeat,
  readPublicAsset,
  readPublicTreeConsumer,
  releasePublicTreeLease,
  removePublicTreeConsumer,
  restorePublicTreeConsumer,
  validatePublicFiles,
  validatePublicTree,
  writePublicTreeConsumer,
} from "../dist/public-tree.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-public-tree-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a failed candidate leaves the active immutable public tree continuously readable", async () => {
  await withTempDir(async (buildDir) => {
    const active = await createPublicTree(buildDir, [
      { path: "index.html", contents: "<h1>last good</h1>" },
      { path: "assets/client.js", contents: "console.log('good')" },
      { path: "assets/capsule.css", contents: "body { color: teal; }" },
    ]);

    await assert.rejects(
      createPublicTree(buildDir, [
        { path: "index.html", contents: "<h1>bad</h1>" },
        { path: "../escape.js", contents: "bad" },
      ]),
      (error) => error.message === "Invalid public path.",
    );

    const html = await readPublicAsset(active, "/");
    const css = await readPublicAsset(active, "/assets/capsule.css");
    assert.equal(html.body.toString("utf8"), "<h1>last good</h1>");
    assert.equal(css.body.toString("utf8"), "body { color: teal; }");
    assert.equal(css.contentType, "text/css; charset=utf-8");
    assert.equal(await readFile(path.join(active.root, "assets", "client.js"), "utf8"), "console.log('good')");
  });
});

test("creating a replacement never removes or mutates the active public tree", async () => {
  await withTempDir(async (buildDir) => {
    const active = await createPublicTree(buildDir, [
      { path: "index.html", contents: "old html" },
      { path: "client.js", contents: "old client" },
    ]);
    const replacementPromise = createPublicTree(buildDir, [
      { path: "index.html", contents: "new html" },
      { path: "client.js", contents: "new client" },
    ]);

    assert.equal((await readPublicAsset(active, "/client.js")).body.toString("utf8"), "old client");
    const replacement = await replacementPromise;
    assert.notEqual(replacement.root, active.root);
    assert.equal((await readPublicAsset(active, "/client.js")).body.toString("utf8"), "old client");
    assert.equal((await readPublicAsset(replacement, "/client.js")).body.toString("utf8"), "new client");
  });
});

test("a durable Container consumer protects its mounted tree until replacement and removal", async () => {
  await withTempDir(async (buildDir) => {
    const treesDir = path.join(buildDir, ".public-trees");
    const mounted = await createPublicTree(buildDir, [
      { path: "index.html", contents: "mounted html" },
      { path: "client.js", contents: "mounted client" },
    ]);
    await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(mounted.root) })}\n`);
    const firstConsumer = await writePublicTreeConsumer(buildDir, "container", mounted.root, "container-first", null);
    await releasePublicTreeLease(mounted);

    for (let index = 0; index < 4; index += 1) {
      const standalone = await createPublicTree(buildDir, [
        { path: "index.html", contents: `standalone ${index}` },
        { path: "client.js", contents: `standalone client ${index}` },
      ]);
      await releasePublicTreeLease(standalone);
      await cleanupPublicTrees(buildDir);
      assert.equal(await readFile(path.join(mounted.root, "client.js"), "utf8"), "mounted client");
    }

    const replacement = await createPublicTree(buildDir, [
      { path: "index.html", contents: "replacement html" },
      { path: "client.js", contents: "replacement client" },
    ]);
    const secondConsumer = await writePublicTreeConsumer(
      buildDir,
      "container",
      replacement.root,
      "container-second",
      { token: firstConsumer.token, identity: firstConsumer.identity },
    );
    await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(replacement.root) })}\n`);
    await releasePublicTreeLease(replacement);
    await cleanupPublicTrees(buildDir, { maxCompleted: 0 });
    await assert.rejects(access(mounted.root), (error) => error.code === "ENOENT");
    assert.equal((await readPublicTreeConsumer(buildDir, "container")).token, secondConsumer.token);
    await access(replacement.root);

    await assert.rejects(
      writePublicTreeConsumer(buildDir, "container", replacement.root, "tokenless-overwrite", null),
      /consumer ownership changed/,
    );
    await assert.rejects(
      restorePublicTreeConsumer(buildDir, "container", firstConsumer, { token: firstConsumer.token, identity: firstConsumer.identity }),
      /consumer ownership changed/,
    );
    await assert.rejects(removePublicTreeConsumer(buildDir, "container", null), /consumer ownership changed/);
    assert.equal((await readPublicTreeConsumer(buildDir, "container")).token, secondConsumer.token);

    await assert.rejects(
      removePublicTreeConsumer(buildDir, "container", { token: firstConsumer.token, identity: firstConsumer.identity }),
      /consumer ownership changed/,
    );
    await removePublicTreeConsumer(buildDir, "container", { token: secondConsumer.token, identity: secondConsumer.identity });
    assert.equal(await readPublicTreeConsumer(buildDir, "container"), null);
  });
});

test("the validated asset snapshot is race-safe when an output path becomes a symlink", async () => {
  await withTempDir(async (buildDir) => {
    const tree = await createPublicTree(buildDir, [
      { path: "index.html", contents: "safe html" },
      { path: "client.js", contents: "safe client" },
    ]);
    const outside = path.join(buildDir, "outside.js");
    await writeFile(outside, "secret outside bytes");
    await rm(path.join(tree.root, "client.js"));
    await symlink(outside, path.join(tree.root, "client.js"));

    for (let index = 0; index < 25; index += 1) {
      assert.equal((await readPublicAsset(tree, "/client.js")).body.toString("utf8"), "safe client");
    }
    await assert.rejects(validatePublicTree(tree.root), /Invalid public tree/);
  });
});

test("public snapshots copy validated inputs and ignore later file growth", async () => {
  await withTempDir(async (buildDir) => {
    const mutableClient = Buffer.from("bounded client");
    const tree = await createPublicTree(buildDir, [
      { path: "index.html", contents: "safe html" },
      { path: "client.js", contents: mutableClient },
    ]);
    mutableClient.fill("x");
    await writeFile(path.join(tree.root, "client.js"), Buffer.alloc(PUBLIC_TREE_LIMITS.fileBytes + 1, 1));
    assert.equal((await readPublicAsset(tree, "/client.js")).body.toString("utf8"), "bounded client");

    const fullSized = Buffer.alloc(PUBLIC_TREE_LIMITS.fileBytes);
    assert.throws(
      () => validatePublicFiles([
        { path: "index.html", contents: "x" },
        { path: "assets/one.bin", contents: fullSized },
        { path: "assets/two.bin", contents: fullSized },
        { path: "assets/three.bin", contents: fullSized },
        { path: "assets/four.bin", contents: fullSized },
      ]),
      (error) => /aggregate size limit/.test(error.hint),
    );
  });
});

test("public tree cleanup stays bounded and preserves the newest recoverable trees", async () => {
  await withTempDir(async (buildDir) => {
    const active = await createPublicTree(buildDir, [
      { path: "index.html", contents: "active tree" },
      { path: "client.js", contents: "active client" },
    ]);
    const treesDir = path.join(buildDir, ".public-trees");
    await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(active.root) })}\n`);
    await releasePublicTreeLease(active);
    let newest = active;
    for (let index = 0; index < 5; index += 1) {
      newest = await createPublicTree(buildDir, [
        { path: "index.html", contents: `tree ${index}` },
        { path: "client.js", contents: `client ${index}` },
      ]);
      await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(newest.root) })}\n`);
      await releasePublicTreeLease(newest);
    }
    await cleanupPublicTrees(buildDir);
    const completed = (await readdir(treesDir)).filter((name) => !name.startsWith(".") && name !== "active.json");
    assert.equal(completed.length, 2);
    await access(newest.root);

    const staleStaging = path.join(treesDir, ".staging-stale");
    await mkdir(staleStaging);
    await assert.rejects(
      cleanupPublicTrees(buildDir, {
        keepRoots: [newest.root],
        fault: (_event, entryPath) => {
          if (entryPath === staleStaging) throw new Error("injected cleanup failure");
        },
      }),
      (error) => error.message === "Public tree cleanup degraded." && /active and recoverable trees were preserved/.test(error.hint),
    );
    await access(newest.root);
    await access(staleStaging);
  });
});

test("live candidate leases survive interleaved cleanup and released or crashed leases are reclaimed", async () => {
  await withTempDir(async (buildDir) => {
    const active = await createPublicTree(buildDir, [
      { path: "index.html", contents: "active" },
      { path: "client.js", contents: "active client" },
    ]);
    const treesDir = path.join(buildDir, ".public-trees");
    await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(active.root) })}\n`);
    await releasePublicTreeLease(active);

    const candidateA = await createPublicTree(buildDir, [
      { path: "index.html", contents: "candidate A" },
      { path: "client.js", contents: "client A" },
    ]);
    const candidateB = await createPublicTree(buildDir, [
      { path: "index.html", contents: "candidate B" },
      { path: "client.js", contents: "client B" },
    ]);
    assert.equal(await readFile(path.join(candidateA.root, "client.js"), "utf8"), "client A");

    await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(candidateA.root) })}\n`);
    await releasePublicTreeLease(candidateA);
    await discardPublicTree(candidateB);
    await cleanupPublicTrees(buildDir, { keepRoots: [candidateA.root] });
    await access(candidateA.root);

    const crashed = await createPublicTree(buildDir, [
      { path: "index.html", contents: "crashed" },
      { path: "client.js", contents: "crashed client" },
    ]);
    await writeFile(crashed.lease.path, `${JSON.stringify({ tree: path.basename(crashed.root), pid: 99999999, token: crashed.lease.token })}\n`);
    await cleanupPublicTrees(buildDir, { keepRoots: [candidateA.root] });
    await assert.rejects(access(crashed.root), (error) => error.code === "ENOENT");
    await access(candidateA.root);
  });
});

test("cleanup keeps the active and previous public trees without counting metadata directories", async () => {
  await withTempDir(async (buildDir) => {
    const treesDir = path.join(buildDir, ".public-trees");
    const activeA = await createPublicTree(buildDir, [
      { path: "index.html", contents: "A" },
      { path: "client.js", contents: "client A" },
    ]);
    await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(activeA.root) })}\n`);
    await releasePublicTreeLease(activeA);
    const activeB = await createPublicTree(buildDir, [
      { path: "index.html", contents: "B" },
      { path: "client.js", contents: "client B" },
    ]);
    await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(activeB.root) })}\n`);
    await releasePublicTreeLease(activeB);
    await cleanupPublicTrees(buildDir);
    await access(activeA.root);
    await access(activeB.root);

    const activeC = await createPublicTree(buildDir, [
      { path: "index.html", contents: "C" },
      { path: "client.js", contents: "client C" },
    ]);
    await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(activeC.root) })}\n`);
    await releasePublicTreeLease(activeC);
    await cleanupPublicTrees(buildDir);
    await assert.rejects(access(activeA.root), (error) => error.code === "ENOENT");
    await access(activeB.root);
    await access(activeC.root);
  });
});

test("unsafe or missing active references fail closed without deleting public trees", async () => {
  await withTempDir(async (buildDir) => {
    const tree = await createPublicTree(buildDir, [
      { path: "index.html", contents: "active" },
      { path: "client.js", contents: "active client" },
    ]);
    const treesDir = path.join(buildDir, ".public-trees");
    await releasePublicTreeLease(tree);
    const symlinkName = `999-${Date.now()}-aaaaaaaaaaaaaaaa`;
    const fileName = `998-${Date.now()}-bbbbbbbbbbbbbbbb`;
    await symlink(tree.root, path.join(treesDir, symlinkName));
    await writeFile(path.join(treesDir, fileName), "not a directory");
    const invalidNames = ["", ".", "..", ".leases", `997-${Date.now()}-cccccccccccccccc`, symlinkName, fileName];
    for (const invalidName of invalidNames) {
      await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: invalidName })}\n`);
      await assert.rejects(cleanupPublicTrees(buildDir), /Public tree cleanup degraded/);
      await access(tree.root);
      await access(path.join(treesDir, symlinkName));
      await access(path.join(treesDir, fileName));
    }
  });
});

test("lease and lock ownership rejects PID reuse and non-positive owners without stealing a matching owner", async () => {
  await withTempDir(async (buildDir) => {
    const active = await createPublicTree(buildDir, [
      { path: "index.html", contents: "active" },
      { path: "client.js", contents: "active client" },
    ]);
    const treesDir = path.join(buildDir, ".public-trees");
    await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(active.root) })}\n`);
    await releasePublicTreeLease(active);
    const leasesDir = path.join(treesDir, ".leases");
    const abandoned = [
      { name: `991-${Date.now()}-aaaaaaaaaaaaaaaa`, pid: process.pid, processStart: "forged:start" },
      { name: `992-${Date.now()}-bbbbbbbbbbbbbbbb`, pid: 0, processStart: "forged:start" },
      { name: `993-${Date.now()}-cccccccccccccccc`, pid: -1, processStart: "forged:start" },
    ];
    for (const owner of abandoned) {
      const root = path.join(treesDir, owner.name);
      await mkdir(root);
      await writeFile(path.join(root, "index.html"), "abandoned");
      await writeFile(path.join(root, "client.js"), "abandoned client");
      await writeFile(path.join(leasesDir, `${owner.name}.json`), `${JSON.stringify({
        tree: owner.name,
        pid: owner.pid,
        processStart: owner.processStart,
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
        token: `token-${owner.name}`,
      })}\n`);
    }
    await cleanupPublicTrees(buildDir);
    for (const owner of abandoned) await assert.rejects(access(path.join(treesDir, owner.name)), (error) => error.code === "ENOENT");
    await access(active.root);

    const processStart = await getProcessStartIdentity(process.pid);
    assert.ok(processStart, "Expected a process-start identity on supported macOS/Linux.");
    const lockDir = path.join(treesDir, ".lifecycle-lock");
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, processStart: "forged:start", createdAt: Date.now(), heartbeatAt: Date.now(), token: "forged-lock" })}\n`);
    await cleanupPublicTrees(buildDir);

    await mkdir(lockDir);
    await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, processStart, createdAt: Date.now(), heartbeatAt: Date.now(), token: "matching-lock" })}\n`);
    const waitingCleanup = cleanupPublicTrees(buildDir);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await access(lockDir);
    await rm(lockDir, { recursive: true });
    await waitingCleanup;
    await access(active.root);
  });
});

test("Darwin process identity forces a locale-stable environment and canonical result", async () => {
  const calls = [];
  const execute = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: "Fri Jul 11 09:08:07 2026\n" };
  };
  const previousLocale = process.env.LC_ALL;
  try {
    process.env.LC_ALL = "fr_FR.UTF-8";
    const frenchParent = await getProcessStartIdentity(process.pid, { platform: "darwin", execFile: execute });
    process.env.LC_ALL = "de_DE.UTF-8";
    const germanParent = await getProcessStartIdentity(process.pid, { platform: "darwin", execFile: execute });
    assert.equal(frenchParent, "darwin:2026-07-11T09:08:07");
    assert.equal(germanParent, frenchParent);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.file, "/bin/ps");
      assert.deepEqual(call.args, ["-o", "lstart=", "-p", String(process.pid)]);
      assert.equal(call.options.env.LC_ALL, "C");
      assert.equal(call.options.env.LANG, "C");
    }
  } finally {
    if (previousLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previousLocale;
  }
});

test("unverified ownership uses bounded heartbeats and an old lock token cannot remove its successor", async () => {
  await withTempDir(async (buildDir) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      const treesDir = path.join(buildDir, ".public-trees");
      await mkdir(path.join(treesDir, ".leases"), { recursive: true });
      const now = Date.now();
      const cases = [
        { prefix: 981, heartbeatAt: now, survives: true },
        { prefix: 982, heartbeatAt: now - 30_001, survives: false },
        { prefix: 983, heartbeatAt: now + 60_000, survives: false },
        { prefix: 984, heartbeatAt: "malformed", survives: false },
      ];
      for (const item of cases) {
        item.name = `${item.prefix}-${now}-aaaaaaaaaaaaaaaa`;
        const root = path.join(treesDir, item.name);
        await mkdir(root);
        await writeFile(path.join(root, "index.html"), item.name);
        await writeFile(path.join(root, "client.js"), item.name);
        await writeFile(path.join(treesDir, ".leases", `${item.name}.json`), `${JSON.stringify({
          tree: item.name,
          pid: child.pid,
          processStart: null,
          createdAt: now - 60_000,
          heartbeatAt: item.heartbeatAt,
          token: `token-${item.name}`,
        })}\n`);
      }
      await cleanupPublicTrees(buildDir, { maxCompleted: 0, now: () => now });
      for (const item of cases) {
        if (item.survives) await access(path.join(treesDir, item.name));
        else await assert.rejects(access(path.join(treesDir, item.name)), (error) => error.code === "ENOENT");
      }

      const disposable = path.join(treesDir, "not-a-candidate");
      await mkdir(disposable);
      const lockDir = path.join(treesDir, ".lifecycle-lock");
      await assert.rejects(
        cleanupPublicTrees(buildDir, {
          maxCompleted: 0,
          fault: (_event, entryPath) => {
            if (entryPath !== disposable) return;
            rmSync(lockDir, { recursive: true, force: true });
            mkdirSync(lockDir);
            writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({ token: "successor-token" })}\n`);
          },
        }),
        /Public tree lock ownership changed/,
      );
      assert.equal(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")).token, "successor-token");
      await rm(lockDir, { recursive: true, force: true });
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("heartbeat publication remains atomic across a concurrent ownership cleanup", async () => {
  await withTempDir(async (buildDir) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      const treesDir = path.join(buildDir, ".public-trees");
      const leasesDir = path.join(treesDir, ".leases");
      const heartbeatsDir = path.join(treesDir, ".owner-heartbeats");
      await mkdir(leasesDir, { recursive: true });
      const now = Date.now();
      const treeName = `971-${now}-aaaaaaaaaaaaaaaa`;
      const treeRoot = path.join(treesDir, treeName);
      const token = `token-${treeName}`;
      const leasePath = path.join(leasesDir, `${treeName}.json`);
      await mkdir(treeRoot);
      await writeFile(path.join(treeRoot, "index.html"), "atomic");
      await writeFile(path.join(treeRoot, "client.js"), "atomic client");
      await writeFile(leasePath, `${JSON.stringify({
        tree: treeName,
        pid: child.pid,
        processStart: null,
        createdAt: now - 60_000,
        heartbeatAt: now - 20_000,
        token,
      })}\n`);
      await publishOwnerHeartbeat(leasePath, token, now - 10_000);
      const finalPath = path.join(heartbeatsDir, `${token}.json`);

      let signalTempWritten;
      const tempWritten = new Promise((resolve) => { signalTempWritten = resolve; });
      let allowRename;
      const renameAllowed = new Promise((resolve) => { allowRename = resolve; });
      const publishing = publishOwnerHeartbeat(leasePath, token, now, {
        afterTempWrite: () => {
          signalTempWritten();
          return renameAllowed;
        },
      });
      await tempWritten;
      assert.deepEqual(JSON.parse(await readFile(finalPath, "utf8")), { token, heartbeatAt: now - 10_000 });
      const inFlightTemps = (await readdir(heartbeatsDir)).filter((entry) => entry.endsWith(".tmp"));
      assert.equal(inFlightTemps.length, 1);

      const abandonedTemp = path.join(heartbeatsDir, "abandoned.tmp");
      const futureTemp = path.join(heartbeatsDir, "future.tmp");
      const youngTemp = path.join(heartbeatsDir, "young.tmp");
      await writeFile(abandonedTemp, "partial");
      await writeFile(futureTemp, "partial");
      await writeFile(youngTemp, "partial");
      const staleTime = new Date(now - 40_000);
      await utimes(abandonedTemp, staleTime, staleTime);
      const futureTime = new Date(now + 60_000);
      await utimes(futureTemp, futureTime, futureTime);
      await cleanupPublicTrees(buildDir, { maxCompleted: 0, now: () => now });
      await access(treeRoot);
      await assert.rejects(access(abandonedTemp), (error) => error.code === "ENOENT");
      await assert.rejects(access(futureTemp), (error) => error.code === "ENOENT");
      await access(youngTemp);
      await access(path.join(heartbeatsDir, inFlightTemps[0]));

      allowRename();
      await publishing;
      assert.deepEqual(JSON.parse(await readFile(finalPath, "utf8")), { token, heartbeatAt: now });
      await assert.rejects(access(path.join(heartbeatsDir, inFlightTemps[0])), (error) => error.code === "ENOENT");

      let signalObsoleteTemp;
      const obsoleteTempWritten = new Promise((resolve) => { signalObsoleteTemp = resolve; });
      let allowObsoleteRename;
      const obsoleteRenameAllowed = new Promise((resolve) => { allowObsoleteRename = resolve; });
      const obsoletePublication = publishOwnerHeartbeat(leasePath, token, now + 1_000, {
        afterTempWrite: () => {
          signalObsoleteTemp();
          return obsoleteRenameAllowed;
        },
      });
      await obsoleteTempWritten;
      const successorToken = `successor-${treeName}`;
      await writeFile(leasePath, `${JSON.stringify({
        tree: treeName,
        pid: child.pid,
        processStart: null,
        createdAt: now,
        heartbeatAt: now,
        token: successorToken,
      })}\n`);
      await publishOwnerHeartbeat(leasePath, successorToken, now);
      allowObsoleteRename();
      await assert.rejects(obsoletePublication, /Public tree ownership changed/);
      assert.deepEqual(JSON.parse(await readFile(path.join(heartbeatsDir, `${successorToken}.json`), "utf8")), {
        token: successorToken,
        heartbeatAt: now,
      });
      assert.deepEqual(JSON.parse(await readFile(finalPath, "utf8")), { token, heartbeatAt: now });

      const crashedName = `972-${now}-bbbbbbbbbbbbbbbb`;
      const crashedRoot = path.join(treesDir, crashedName);
      const crashedToken = `token-${crashedName}`;
      await mkdir(crashedRoot);
      await writeFile(path.join(crashedRoot, "index.html"), "crashed");
      await writeFile(path.join(crashedRoot, "client.js"), "crashed client");
      await writeFile(path.join(leasesDir, `${crashedName}.json`), `${JSON.stringify({
        tree: crashedName,
        pid: child.pid,
        processStart: null,
        createdAt: now - 60_000,
        heartbeatAt: now - 20_000,
        token: crashedToken,
      })}\n`);
      await writeFile(path.join(heartbeatsDir, `${crashedToken}.json`), "{\"token\":");
      await cleanupPublicTrees(buildDir, { maxCompleted: 0, now: () => now });
      await assert.rejects(access(crashedRoot), (error) => error.code === "ENOENT");
      await access(treeRoot);
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("legacy Bundle rollback restores every recoverable file and preserves failed backups", async () => {
  await withTempDir(async (buildDir) => {
    const server = path.join(buildDir, "server.mjs");
    const client = path.join(buildDir, "client.js");
    await writeFile(server, "old server");
    await writeFile(client, "old client");

    await assert.rejects(
      publishLegacyBundles(
        buildDir,
        [
          { target: server, contents: "new server" },
          { target: client, contents: "new client" },
        ],
        {
          fault: (event, index) => {
            if (event === "before-publish" && index === 1) throw new Error("injected publish failure");
            if (event === "before-restore" && index === 0) throw new Error("injected restore failure");
          },
        },
      ),
      (error) => error.message === "Legacy Bundle recovery is incomplete." && error.diagnostics.failedFiles === 1,
    );

    assert.equal(await readFile(client, "utf8"), "old client");
    const recoveryDirName = (await readdir(buildDir)).find((name) => name.startsWith(".legacy-staging-"));
    assert.ok(recoveryDirName);
    assert.equal(await readFile(path.join(buildDir, recoveryDirName, "backup-0"), "utf8"), "old server");
  });
});

test("normalized public trees reject symlinks and Unicode normalization collisions", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "index.html"), "<h1>safe</h1>");
    await symlink(path.join(root, "index.html"), path.join(root, "linked.html"));
    await assert.rejects(validatePublicTree(root), /Invalid public tree/);

    await assert.rejects(
      createPublicTree(root, [
        { path: "index.html", contents: "<h1>safe</h1>" },
        { path: "assets/caf\u00e9.js", contents: "one" },
        { path: "assets/cafe\u0301.js", contents: "two" },
      ]),
      (error) => /normalization collision/.test(error.hint),
    );

    await assert.rejects(
      createPublicTree(root, [
        { path: "index.html", contents: "<h1>safe</h1>" },
        { path: "assets/caf\u00e9/a.js", contents: "one" },
        { path: "assets/cafe\u0301/b.js", contents: "two" },
      ]),
      (error) => /normalization collision/.test(error.hint),
    );
    await assert.rejects(access(path.join(root, ".public-trees")), (error) => error.code === "ENOENT");
  });
});

test("runtime infrastructure consumes only the normalized public tree contract", async () => {
  const infrastructureFiles = [
    "src/templates/server-bundle-template.ts",
    "src/cli/host-request-builders.ts",
    "src/cli/sporades-host-helper.ts",
    "src/cli/host-helper-release-files.ts",
  ];
  const infrastructure = await Promise.all(
    infrastructureFiles.map(async (file) => [file, await readFile(path.resolve(file), "utf8")]),
  );

  for (const [file, source] of infrastructure) {
    assert.equal(source.includes("runtimeUsesLegacyPublicFiles"), false, file);
    assert.equal(source.includes('container: "/app/client.js"'), false, file);
    assert.equal(source.includes('container: "/app/index.html"'), false, file);
    assert.equal(source.includes('const legacyFiles = publicFiles.length === 0'), false, file);
  }

  const superseded = await readFile(path.resolve("docs/adr/0010-user-owned-index-html.md"), "utf8");
  const active = await readFile(path.resolve("docs/adr/0032-user-owned-html-builds-to-a-normalized-public-tree.md"), "utf8");
  assert.match(superseded, /^Status: Superseded by ADR-0032\.$/m);
  assert.match(active, /^Status: Accepted\.$/m);
});

test("the shared public-tree contract admits nested assets and rejects ambiguous release paths", () => {
  assert.equal(normalizePublicTreePath("assets/fonts/capsule.woff2"), "assets/fonts/capsule.woff2");
  assert.equal(publicTreePathFromRequest("/assets/chunks/app.js"), "assets/chunks/app.js");
  for (const unsafe of ["../escape.js", "assets/../escape.js", "/absolute.js", "assets\\escape.js", "assets//escape.js"]) {
    assert.equal(normalizePublicTreePath(unsafe), null, unsafe);
  }
  for (const unsafe of ["/%2e%2e/escape.js", "/assets%2fescape.js", "/assets%5cescape.js", "/%252e%252e/escape.js"]) {
    assert.equal(publicTreePathFromRequest(unsafe), null, unsafe);
  }

  assert.deepEqual(validatePublicTreeFileSet([
    { path: "index.html", size: 128 },
    { path: "assets/chunks/app.js", size: 256 },
    { path: "assets/fonts/capsule.woff2", size: 512 },
  ]), { ok: true, fileCount: 3, totalBytes: 896 });
  assert.deepEqual(validatePublicTreeFileSet([
    { path: "index.html", size: 1 },
    { path: "assets/caf\u00e9.js", size: 1 },
    { path: "assets/cafe\u0301.js", size: 1 },
  ]), { ok: false, reason: "collision" });

  const prefixCollisions = [
    ["assets/caf\u00e9/a.js", "assets/cafe\u0301/b.js"],
    ["assets/icons/caf\u00e9/dark/a.js", "assets/icons/cafe\u0301/light/b.js"],
    ["assets/caf\u00e9", "assets/cafe\u0301/a.js"],
    ["assets/cafe\u0301/a.js", "assets/caf\u00e9"],
  ];
  for (const [first, second] of prefixCollisions) {
    assert.deepEqual(validatePublicTreeFileSet([
      { path: "index.html", size: 1 },
      { path: first, size: 1 },
      { path: second, size: 1 },
    ]), { ok: false, reason: "collision" }, `${first} <> ${second}`);
  }
});
