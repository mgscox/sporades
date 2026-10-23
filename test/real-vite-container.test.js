import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { installPrerenderFixture } from "./support/prerender-capsule.js";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const enabled = process.env.SPORADES_REAL_VITE_CONTAINER === "1";

async function runCli(args, cwd) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: process.env,
      timeout: 240_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) };
  }
}

function lastJsonLine(output) {
  return JSON.parse(output.trim().split("\n").at(-1));
}

async function fetchEventually(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } while (Date.now() < deadline);
  throw lastError;
}

async function guestbookRequest(baseUrl, message) {
  const page = await fetch(baseUrl, { headers: { "sec-fetch-dest": "document" } });
  const token = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(token, "served page carries a WebSocket connection token");
  const url = new URL("/__sporades/ws", baseUrl.replace("http:", "ws:"));
  url.searchParams.set("connectionToken", token);
  const socket = new WebSocket(url, { origin: baseUrl });
  // Opening/request waits report failures; timeout cleanup may emit another error.
  socket.on("error", () => {});
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(10_000) });
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Guestbook request timed out")), 10_000);
      socket.addEventListener("message", (event) => {
        const reply = JSON.parse(event.data);
        if (reply.id === message.id) { clearTimeout(timeout); resolve(reply); }
      });
      socket.addEventListener("error", (event) => { clearTimeout(timeout); reject(event.error ?? new Error("Guestbook socket failed")); }, { once: true });
    });
    socket.send(JSON.stringify(message));
    const reply = await response;
    assert.equal(reply.error, null, JSON.stringify(reply));
    return reply.data;
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((resolve) => socket.once("close", resolve));
      const timeout = setTimeout(() => socket.terminate(), 1_000);
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close();
      try { await closed; } finally { clearTimeout(timeout); }
    }
  }
}

async function verifyGuestbookRestart(url, containerId, t) {
  const inspect = JSON.parse((await execFileAsync("docker", ["inspect", containerId], { timeout: 30_000 })).stdout)[0];
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.ok(inspect.HostConfig.CapDrop.includes("ALL"));
  assert.ok(inspect.HostConfig.SecurityOpt.some((option) => option.startsWith("no-new-privileges")));
  assert.ok(inspect.HostConfig.Tmpfs["/tmp"].includes("noexec"));
  assert.equal(inspect.Mounts.find((mount) => mount.Destination === "/app/data").RW, true);
  assert.equal(inspect.Mounts.find((mount) => mount.Destination === "/app/server.mjs").RW, false);
  const runtime = await execFileAsync("docker", ["exec", containerId, "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { writeFileSync, readFileSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    assert.equal(process.version, 'v24.22.1');
    assert.equal(process.getuid(), ${process.getuid()});
    assert.equal(process.getgid(), ${process.getgid()});
    assert.throws(() => writeFileSync('/app/server.mjs', 'must-not-write'));
    assert.throws(() => writeFileSync('/root-write-probe', 'must-not-write'));
    writeFileSync('/app/data/node24-probe', 'persistent');
    assert.equal(readFileSync('/app/data/node24-probe', 'utf8'), 'persistent');
    console.log(JSON.stringify({ node: process.version, uid: process.getuid(), sqlite: typeof DatabaseSync }));
  `], { timeout: 30_000 });
  const body = "Node 24 LTS persistence probe";
  await guestbookRequest(url, { id: "sign", type: "mutation.run", mutation: "sign", args: [body] });
  const entries = await guestbookRequest(url, { id: "before", type: "query.subscribe", query: "entries" });
  assert.equal(entries.filter((entry) => entry.body === body).length, 1);
  await execFileAsync("docker", ["restart", containerId], { timeout: 30_000 });
  assert.equal((await fetchEventually(url)).status, 200);
  const persisted = await guestbookRequest(url, { id: "after", type: "query.subscribe", query: "entries" });
  assert.deepEqual(persisted, entries, "SQLite entries survive container restart");
  const marker = await execFileAsync("docker", ["exec", containerId, "cat", "/app/data/node24-probe"], { timeout: 30_000 });
  assert.equal(marker.stdout, "persistent");
  t.diagnostic(JSON.stringify({ runtime: JSON.parse(runtime.stdout), sqliteRestart: "passed", hardening: "passed" }));
}

for (const { framework, template, toolchain } of [
  { framework: "react", template: "blank" },
  { framework: "preact", template: "blank" },
  { framework: "lit", template: "blank" },
  { framework: "lit", template: "todo" },
  { framework: "lit", template: "guestbook" },
  { framework: "lit", template: "photo-library" },
  { framework: "lit", template: "campfire" },
  { framework: "solid", template: "blank" },
  { framework: "solid", template: "todo" },
  { framework: "solid", template: "guestbook" },
  { framework: "solid", template: "photo-library" },
  { framework: "solid", template: "campfire" },
  { framework: "vue", template: "blank" },
  { framework: "vue", template: "todo" },
  { framework: "vue", template: "guestbook" },
  { framework: "vue", template: "photo-library" },
  { framework: "vue", template: "campfire" },
  { framework: "svelte", template: "blank" },
  { framework: "svelte", template: "todo" },
  { framework: "svelte", template: "guestbook" },
  { framework: "svelte", template: "photo-library" },
  { framework: "svelte", template: "campfire" },
  { framework: "inferno", template: "blank", toolchain: "esbuild" },
  { framework: "inferno", template: "todo", toolchain: "esbuild" },
  { framework: "inferno", template: "guestbook", toolchain: "esbuild" },
  { framework: "inferno", template: "photo-library", toolchain: "esbuild" },
  { framework: "inferno", template: "campfire", toolchain: "esbuild" },
  { framework: "inferno", template: "guestbook", toolchain: "vite" },
  { framework: "inferno", template: "photo-library", toolchain: "vite" },
  { framework: "inferno", template: "campfire", toolchain: "vite" },
]) test(`real Container serves a complete ${framework} ${toolchain ?? "vite"} ${template} public tree from the actual Base image`, {
  skip: enabled ? false : "Set SPORADES_REAL_VITE_CONTAINER=1 to run the disposable Docker acceptance test.",
  timeout: 300_000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-real-vite-container-"));
  const selectedToolchain = toolchain ?? "vite";
  const projectName = `real-${framework}-${template}-vite-container`;
  const projectDir = path.join(root, projectName);
  let deployAttempted = false;
  let deploySucceeded = false;
  try {
    const docker = await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 30_000 });
    assert.match(docker.stdout.trim(), /^\d+\./, docker.stderr);

    const created = await runCli([
      "create", projectName, "--template", template, "--framework", framework, "--toolchain", selectedToolchain,
      "--no-install", "--no-git", "--json",
    ], root);
    assert.equal(created.code, 0, created.stderr);
    await execFileAsync("npm", ["install", ...(["lit", "solid", "vue", "svelte"].includes(framework) ? [] : ["--omit=dev"]), "--ignore-scripts", "--package-lock=false"], {
      cwd: projectDir,
      // npm run may export the repository's allowScripts as CLI config. A child
      // project install rejects that setting; retain --ignore-scripts explicitly.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts")),
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (["preact", "inferno", "lit", "solid", "vue", "svelte"].includes(framework)) {
      await assert.rejects(access(path.join(projectDir, "node_modules", "react")), (error) => error.code === "ENOENT");
      await assert.rejects(access(path.join(projectDir, "node_modules", "react-dom")), (error) => error.code === "ENOENT");
      const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
      assert.equal(packageJson.dependencies[framework === "solid" ? "solid-js" : framework], { preact: "^10.25.0", inferno: "^9.1.0", lit: "^3.2.1", solid: "^1.9.0", vue: "^3.5.13", svelte: "^5.0.0" }[framework]);
      if (framework === "vue") assert.equal(packageJson.devDependencies["@vue/compiler-sfc"], "^3.5.13");
      assert.equal(packageJson.dependencies.react, undefined);
      assert.equal(packageJson.dependencies["react-dom"], undefined);
      if (framework === "vue") {
        assert.equal(packageJson.devDependencies["@vitejs/plugin-vue"], "^5.2.4");
        await access(path.join(projectDir, "node_modules", "@vitejs", "plugin-vue", "package.json"));
        await access(path.join(projectDir, "node_modules", "@vue", "compiler-sfc", "package.json"));
        const sporadesPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
        assert.equal(sporadesPackage.dependencies["@vitejs/plugin-vue"], undefined);
        assert.equal(sporadesPackage.dependencies["@vue/compiler-sfc"], undefined);
      }
      if (framework === "svelte") {
        assert.equal(packageJson.devDependencies["@sveltejs/vite-plugin-svelte"], "^5.1.1");
        assert.equal(packageJson.dependencies.svelte, "^5.0.0");
        const sporadesPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
        assert.equal(sporadesPackage.dependencies.svelte, undefined);
        assert.equal(sporadesPackage.dependencies["@sveltejs/vite-plugin-svelte"], undefined);
      }
      if (framework === "solid") {
        assert.equal(packageJson.devDependencies["vite-plugin-solid"], "^2.11.0");
        await access(path.join(projectDir, "node_modules", "vite-plugin-solid", "package.json"));
        await access(path.join(projectDir, "node_modules", "solid-js", "package.json"));
        const sporadesPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
        assert.equal(sporadesPackage.dependencies["solid-js"], undefined);
        assert.equal(sporadesPackage.dependencies["vite-plugin-solid"], undefined);
      }
      if (framework === "lit") {
        await access(path.join(projectDir, "node_modules", "lit", "package.json"));
        const sporadesPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
        assert.equal(sporadesPackage.dependencies.lit, undefined);
      }
    }
    await writeFile(path.join(projectDir, ".env"), "VITE_REAL_CONTAINER_LEAK=browser-secret-must-not-ship\n");
    await writeFile(path.join(projectDir, ".env.sporades.server"), `${template === "photo-library" ? "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n" : ""}SERVER_REAL_CONTAINER_LEAK=server-secret-must-not-ship\n`);
    const clientPath = path.join(projectDir, "client", ["lit", "vue", "svelte"].includes(framework) ? "index.ts" : "index.tsx");
    if (selectedToolchain === "vite") await writeFile(
      clientPath,
      `${await readFile(clientPath, "utf8")}\nconsole.log(import.meta.env.VITE_REAL_CONTAINER_LEAK);\n`,
    );

    const prerenderFixture = framework === "react" && template === "blank" && selectedToolchain === "vite";
    if (prerenderFixture) await installPrerenderFixture(projectDir);
    deployAttempted = true;
    const deployed = await runCli(["deploy", "--json"], projectDir);
    assert.equal(deployed.code, 0, deployed.stderr);
    const deployment = lastJsonLine(deployed.stdout);
    assert.equal(deployment.ok, true, JSON.stringify(deployment));
    deploySucceeded = true;
    const url = deployment.data.url;
    assert.match(url, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    const inspectedImage = await execFileAsync("docker", ["inspect", "--format", "{{.Config.Image}}", binding.containerId], { timeout: 30_000 });
    assert.equal(inspectedImage.stdout.trim(), "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine");
    const paths = binding.clientRelease.paths;
    const representatives = {
      html: "index.html",
      js: paths.find((file) => selectedToolchain === "esbuild" ? file === "client.js" : /^assets\/index-[^/]+\.js$/.test(file)),
      css: paths.find((file) => selectedToolchain === "esbuild" ? file === "assets/client.css" : /^assets\/index-[^/]+\.css$/.test(file)),
      svg: paths.find((file) => /^assets\/sporades-mark-[^/]+\.svg$/.test(file)),
      map: paths.find((file) => selectedToolchain === "esbuild" ? file === "client.js.map" : /^assets\/index-[^/]+\.js\.map$/.test(file)),
    };
    const fetched = {};
    for (const [kind, publicPath] of Object.entries(representatives)) assert.ok(publicPath, `missing ${kind}: ${JSON.stringify(paths)}`);

    const expectedMime = {
      html: /^text\/html\b/,
      js: /^(?:text|application)\/javascript\b/,
      css: /^text\/css\b/,
      svg: /^image\/svg\+xml\b/,
      map: /^application\/json\b/,
    };
    const bodies = [];
    for (const [kind, publicPath] of Object.entries(representatives)) {
      const response = await fetchEventually(`${url}/${publicPath}`);
      assert.equal(response.status, 200, `${kind} ${publicPath}`);
      assert.match(response.headers.get("content-type") ?? "", expectedMime[kind], `${kind} ${publicPath}`);
      const body = await response.text();
      assert(body.length > 0, `${kind} ${publicPath} returned no bytes`);
      bodies.push(body);
      fetched[kind] = { path: publicPath, bytes: Buffer.byteLength(body), mime: response.headers.get("content-type") };
    }
    const output = bodies.join("\n");
    if (prerenderFixture) {
      assert.match(bodies[0], /<main id="prerender-static">Useful before JavaScript<\/main>/);
      assert.match(bodies[0], /Static fallback remains/);
      assert.doesNotMatch(bodies[0], /\/client\.js/);
      for (const publicPath of paths) {
        const response = await fetchEventually(`${url}/${publicPath}`);
        assert.equal(response.status, 200, publicPath);
        const body = await response.text();
        assert.doesNotMatch(body, /(?:server|project)-env-prerender-must-not-ship|\/@vite\/client|vite\/hmr/i);
      }
    }
    assert.match(output, ["lit", "solid", "vue", "svelte", "inferno"].includes(framework) ? {
      blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/,
      "photo-library": /Photo Library/, campfire: /Campfire/,
    }[template] : template === "todo" ? /Sporades Todos/ : /Blank Sporades Capsule/);
    assert.doesNotMatch(output, /browser-secret-must-not-ship|server-secret-must-not-ship/);
    assert.doesNotMatch(output, /\/@vite\/client|react-refresh|vite\/hmr/i);
    assert.doesNotMatch(output, /dev\.refresh\.(?:subscribe|ready|received)/, "Base-image client output omits Dev refresh protocol");
    if (["solid", "lit", "inferno"].includes(framework)) assert.doesNotMatch(output, /react-dom|react\/jsx-runtime|node_modules\/react/);
    const clientJsStatus = (await fetchEventually(`${url}/client.js`)).status;
    assert.equal(clientJsStatus, selectedToolchain === "esbuild" ? 200 : 404);
    // One built-in template covers browser assets, real mutations, SQLite and restart.
    if (framework === "lit" && template === "guestbook") await verifyGuestbookRestart(url, binding.containerId, t);
    t.diagnostic(JSON.stringify({ framework, template, baseImage: inspectedImage.stdout.trim(), url, fetched, clientJsStatus }));
  } finally {
    if (deployAttempted) {
      const removed = await runCli(["deploy", "remove", "--json"], projectDir).catch(() => null);
      if (["solid", "lit", "inferno"].includes(framework) && deploySucceeded) {
        assert.equal(removed?.code, 0, removed?.stderr ?? "Solid Base-image cleanup did not complete.");
        t.diagnostic(JSON.stringify({ framework, template, cleanup: "container-removed" }));
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
