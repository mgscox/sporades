import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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

for (const { framework, template } of [
  { framework: "react", template: "blank" },
  { framework: "preact", template: "blank" },
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
]) test(`real Container serves a complete ${framework} Vite ${template} public tree from the actual Base image`, {
  skip: enabled ? false : "Set SPORADES_REAL_VITE_CONTAINER=1 to run the disposable Docker acceptance test.",
  timeout: 300_000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-real-vite-container-"));
  const projectName = `real-${framework}-${template}-vite-container`;
  const projectDir = path.join(root, projectName);
  let deployAttempted = false;
  try {
    const docker = await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 30_000 });
    assert.match(docker.stdout.trim(), /^\d+\./, docker.stderr);

    const created = await runCli([
      "create", projectName, "--template", template, "--framework", framework, "--toolchain", "vite",
      "--no-install", "--no-git", "--json",
    ], root);
    assert.equal(created.code, 0, created.stderr);
    await execFileAsync("npm", ["install", ...(["vue", "svelte"].includes(framework) ? [] : ["--omit=dev"]), "--ignore-scripts", "--package-lock=false"], {
      cwd: projectDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (["preact", "vue", "svelte"].includes(framework)) {
      await assert.rejects(access(path.join(projectDir, "node_modules", "react")), (error) => error.code === "ENOENT");
      await assert.rejects(access(path.join(projectDir, "node_modules", "react-dom")), (error) => error.code === "ENOENT");
      const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
      assert.equal(packageJson.dependencies[framework], { preact: "^10.25.0", vue: "^3.5.13", svelte: "^5.0.0" }[framework]);
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
    }
    await writeFile(path.join(projectDir, ".env"), "VITE_REAL_CONTAINER_LEAK=browser-secret-must-not-ship\n");
    await writeFile(path.join(projectDir, ".env.sporades.server"), `${template === "photo-library" ? "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n" : ""}SERVER_REAL_CONTAINER_LEAK=server-secret-must-not-ship\n`);
    const clientPath = path.join(projectDir, "client", ["vue", "svelte"].includes(framework) ? "index.ts" : "index.tsx");
    await writeFile(
      clientPath,
      `${await readFile(clientPath, "utf8")}\nconsole.log(import.meta.env.VITE_REAL_CONTAINER_LEAK);\n`,
    );

    deployAttempted = true;
    const deployed = await runCli(["deploy", "--json"], projectDir);
    assert.equal(deployed.code, 0, deployed.stderr);
    const deployment = lastJsonLine(deployed.stdout);
    assert.equal(deployment.ok, true, JSON.stringify(deployment));
    const url = deployment.data.url;
    assert.match(url, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    const inspectedImage = await execFileAsync("docker", ["inspect", "--format", "{{.Config.Image}}", binding.containerId], { timeout: 30_000 });
    assert.equal(inspectedImage.stdout.trim(), "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine");
    const paths = binding.clientRelease.paths;
    const representatives = {
      html: "index.html",
      js: paths.find((file) => /^assets\/index-[^/]+\.js$/.test(file)),
      css: paths.find((file) => /^assets\/index-[^/]+\.css$/.test(file)),
      svg: paths.find((file) => /^assets\/sporades-mark-[^/]+\.svg$/.test(file)),
      map: paths.find((file) => /^assets\/index-[^/]+\.js\.map$/.test(file)),
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
    assert.match(output, ["vue", "svelte"].includes(framework) ? {
      blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/,
      "photo-library": /Photo Library/, campfire: /Campfire/,
    }[template] : template === "todo" ? /Sporades Todos/ : /Blank Sporades Capsule/);
    assert.doesNotMatch(output, /browser-secret-must-not-ship|server-secret-must-not-ship/);
    assert.doesNotMatch(output, /\/@vite\/client|react-refresh|vite\/hmr/i);
    assert.equal((await fetchEventually(`${url}/client.js`)).status, 404);
    t.diagnostic(JSON.stringify({ framework, template, baseImage: inspectedImage.stdout.trim(), url, fetched, clientJsStatus: 404 }));
  } finally {
    if (deployAttempted) await runCli(["deploy", "remove", "--json"], projectDir).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
