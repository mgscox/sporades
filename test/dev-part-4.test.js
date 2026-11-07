import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { access, chmod, lstat, mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseNpmPackJson } from "../scripts/npm-pack-json.mjs";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

import { withFakeS3CompatibleService } from "./support/fake-s3-compatible-service.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";
import { installProjectVueToolchain } from "./support/project-vue-toolchain.js";
import { installProjectSvelteToolchain } from "./support/project-svelte-toolchain.js";
import { installProjectSolidToolchain } from "./support/project-solid-toolchain.js";
import { installProjectLitToolchain } from "./support/project-lit-toolchain.js";
import { installProjectInfernoToolchain } from "./support/project-inferno-toolchain.js";
import { installProjectTailwindToolchain } from "./support/project-tailwind-toolchain.js";
import { CLIENT_CAPABILITIES } from "../dist/client-capabilities.js";
import { installPrerenderFixture } from "./support/prerender-capsule.js";
import { mountLitTemplate } from "./support/lit-template-harness.js";
import { mountSvelteTemplate } from "./support/svelte-template-harness.js";
import { mountSolidTemplate } from "./support/solid-template-harness.js";
import { mountVueTemplate } from "./support/vue-template-harness.js";
import { mountInfernoTemplate } from "./support/inferno-template-harness.js";
import { createBundle } from "../dist/bundle-pipeline.js";
import { buildClientToolchain } from "../dist/client-toolchain.js";
import { cleanupPublicTrees, discardPublicTree } from "../dist/public-tree.js";

// The Dev regression suite is split across files for independent desk workers.
import {
  repoRoot,
  cliPath,
  TEAM_RUNTIME_TABLES,
  withTempDir,
  snapshotProjectTree,
  runCliFrom,
  runCli,
  startCli,
  packCandidateInto,
  installPackedCandidateCli,
  installFakeDocker,
  rawHttpResponse,
  waitForJsonLine,
  waitForJsonEvent,
  installFakeReact,
  installFakePreact,
  installVue,
  installSvelte,
  sessionState,
  createSolidTemplate,
  campfireHarnessState,
  createLitTemplate,
  runProjectTsc,
  createInfernoTemplate,
  litCampfireState,
  withFakeGoogleServer,
  withFakeFacebookServer,
  openSocket,
  subscribeDevRefresh,
  openSocketWithHeaders,
  readSocketMessage,
  captureSocketMessages,
  closeSocketGracefully,
  openWebSocket,
  waitForSocketMessage
} from "./support/dev-fixture.js";



test("Vite build diagnostics redact filesystem-equivalent NFC and NFD project paths", async (t) => {
  const nfcName = "é-normalized-app";
  const nfdName = nfcName.normalize("NFD");
  const nfcProjectDir = path.join(process.cwd(), nfcName);
  const nfdProjectDir = path.join(process.cwd(), nfdName);
  await assert.rejects(access(nfcProjectDir), (error) => error.code === "ENOENT");
  await assert.rejects(access(nfdProjectDir), (error) => error.code === "ENOENT");
  try {
    await mkdir(path.join(nfcProjectDir, "client"), { recursive: true });
    const [nfcStat, nfdStat] = await Promise.all([lstat(nfcProjectDir), lstat(nfdProjectDir).catch(() => null)]);
    const normalizationEquivalent = Boolean(nfdStat && nfcStat.dev === nfdStat.dev && nfcStat.ino === nfdStat.ino);
    if (process.platform === "darwin") assert.equal(normalizationEquivalent, true, "APFS must resolve the alternate normalization spelling to the same project");
    else if (!normalizationEquivalent) t.diagnostic("Filesystem does not alias normalization-equivalent names; redaction behavior remains covered.");

    const nfcAbsoluteSource = path.join(nfcProjectDir, "client", "index.tsx");
    const nfdAbsoluteSource = path.join(nfdProjectDir, "client", "index.tsx");
    const nfcIndexHtml = path.join(nfcProjectDir, "index.html");
    await writeFile(nfcAbsoluteSource, "export {}\n");
    await writeFile(nfcIndexHtml, '<script type="module" src="/client/index.tsx"></script>\n');
    const nfcRelativeSource = `${nfcName}/client/index.tsx`;
    const nfdRelativeSource = `${nfdName}/client/index.tsx`;
    const nfcWindowsAbsolute = nfcAbsoluteSource.replaceAll("/", "\\");
    const nfdWindowsAbsolute = nfdAbsoluteSource.replaceAll("/", "\\");
    const nfcWindowsRelative = nfcRelativeSource.replaceAll("/", "\\");
    const nfdWindowsRelative = nfdRelativeSource.replaceAll("/", "\\");
    const adjacentProse = `café${nfcRelativeSource}|e\u0301${nfdRelativeSource}`;
    const diagnostic = [
      `adjacent=${adjacentProse}`,
      `nfc-absolute=${nfcAbsoluteSource}?mode=build`,
      `nfd-absolute=${nfdAbsoluteSource}:4:2`,
      `nfc-windows-absolute=${nfcWindowsAbsolute}:5:3`,
      `nfd-windows-absolute=${nfdWindowsAbsolute}?mode=build`,
      `nfc-relative=(${nfcRelativeSource}:6:4)`,
      `nfd-relative=?file=${nfdRelativeSource}`,
      `nfc-windows-relative='${nfcWindowsRelative}'`,
      `nfd-windows-relative= ${nfdWindowsRelative}`,
    ].join("; ");
    await writeFile(path.join(nfcProjectDir, "vite.config.mjs"), `throw new Error(${JSON.stringify(diagnostic)});\n`);

    await assert.rejects(
      buildClientToolchain({
        projectDir: nfcProjectDir,
        frameworkConfig: { framework: "react", entry: "index.tsx", loader: "tsx", jsxImportSource: "react", jsxRuntimeImport: "react/jsx-runtime" },
        toolchain: "vite",
        clientSource: "export {}\n",
        clientSourcePath: nfcAbsoluteSource,
        indexHtml: await readFile(nfcIndexHtml, "utf8"),
        indexHtmlPath: nfcIndexHtml,
      }),
      (error) => {
        assert.equal(error.message.includes(`adjacent=${adjacentProse}`), true);
        assert.match(error.message, /nfc-absolute=<project>\/client\/index\.tsx\?mode=build/);
        assert.match(error.message, /nfd-absolute=<project>\/client\/index\.tsx:4:2/);
        assert.match(error.message, /nfc-windows-absolute=<project>\\client\\index\.tsx:5:3/);
        assert.match(error.message, /nfd-windows-absolute=<project>\\client\\index\.tsx\?mode=build/);
        assert.match(error.message, /nfc-relative=\(<project>\/client\/index\.tsx:6:4\)/);
        assert.match(error.message, /nfd-relative=\?file=<project>\/client\/index\.tsx/);
        assert.match(error.message, /nfc-windows-relative='<project>\\client\\index\.tsx'/);
        assert.match(error.message, /nfd-windows-relative= <project>\\client\\index\.tsx/);
        return true;
      },
    );
  } finally {
    await rm(nfcProjectDir, { recursive: true, force: true });
  }
});


test("every admitted Inferno template passes its emitted strict TypeScript project", async () => {
  for (const toolchain of ["esbuild", "vite"]) for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) await withTempDir(async (dir) => {
    const projectDir = await createInfernoTemplate(dir, `inferno-${toolchain}-strict-${template}`, template, { toolchain });
    const result = await runProjectTsc(projectDir);
    assert.equal(result.code, 0, `${toolchain}/${template}\n${result.stdout}\n${result.stderr}`);
  });
});


test("installed CLI ships OAuth-only sign-in selection across every demo framework", async () => {
  await withTempDir(async (dir) => {
    const { tarballPath } = await packCandidateInto(dir);
    const installed = await installPackedCandidateCli(dir, tarballPath);
    for (const framework of ["react", "preact", "inferno", "lit", "solid", "svelte", "vue"]) {
      for (const template of ["todo", "guestbook", "photo-library"]) {
        const name = `${framework}-${template}-signin`;
        const created = await runCliFrom(installed.cliPath, ["create", name, "--framework", framework, "--template", template, "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr || created.stdout);
        const entry = { vue: "App.vue", svelte: "App.svelte", solid: "App.tsx", lit: "index.ts" }[framework] ?? "index.tsx";
        const source = await readFile(path.join(dir, name, "client", entry), "utf8");
        if (framework === "vue") {
          const { parse, compileScript } = await import("@vue/compiler-sfc");
          const parsed = parse(source);
          assert.deepEqual(parsed.errors, [], `${framework}/${template}`);
          compileScript(parsed.descriptor, { id: name, inlineTemplate: true });
        }
        // Parity contract for shipped templates; mounted controls are tested below.
        const compact = source.replace(/\s+/g, "").replace(/'/g, '"');
        assert.match(compact, /\["google","microsoft","apple","facebook"\]\.includes\(provider\)&&state\.enabled&&state\.configured&&state\.runtimeAvailable/, `${framework}/${template}`);
        assert.doesNotMatch(compact, /\.filter\(\(\[,state\]\)=>state\.enabled/, `${framework}/${template}`);
      }
    }
  });
});


test("real Lit Campfire restores consent, publishes TTL activity, and disconnects exact ownership", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createLitTemplate(dir, "lit-campfire-behavior", "campfire");
    const calls = [], state = litCampfireState(calls), harness = await mountLitTemplate(projectDir, state);
    try {
      state.session.publish({ ...sessionState(), loading: false, auth: { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false, isAuthenticated: true } }); await harness.settle();
      assert(calls.some(([name]) => name === "preferences.get"));
      assert(calls.some(([name, value]) => name === "journey.set" && value.status === "reading" && value.ttlSeconds === 12));
      assert.equal(harness.find('input[type="checkbox"]').checked, true);
      [...harness.element.shadowRoot.querySelectorAll("button")].find((button) => button.textContent.includes("👍")).dispatchEvent(new harness.window.Event("click", { bubbles: true })); await harness.settle();
      assert(calls.some(([name, value]) => name === "toggleReaction" && value.messageId === "m1" && value.kind === "up"));
      assert(calls.some(([name, value]) => name === "journey.set" && value.status === "liked" && value.ttlSeconds === 8));
      state.publishJourney({ data: { type: "snapshot", states: [{ sessionId: "p1", userId: "porthos", status: "reading", metadata: { channel: "ideas" } }] } }); await harness.settle();
      assert.match(harness.text(), /A Musketeer is reading #ideas/);
      const input = harness.find("#message"); input.value = "Protect the crown"; input.dispatchEvent(new harness.window.Event("input", { bubbles: true })); await harness.settle();
      assert.equal(harness.find("form button").disabled, false);
      assert(calls.some(([name, value]) => name === "journey.set" && value.status === "typing" && value.ttlSeconds === 4));
      harness.find("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true, cancelable: true })); await harness.settle();
      assert(calls.some(([name, value]) => name === "sendMessage" && value.body === "Protect the crown"));
      assert(calls.some(([name, value]) => name === "journey.set" && value.status === "posted" && value.ttlSeconds === 8));
      const share = harness.find('input[type="checkbox"]'); share.checked = false; share.dispatchEvent(new harness.window.Event("change", { bubbles: true })); await harness.settle();
      assert(calls.some(([name, value]) => name === "preferences.update" && value.campfireShareActivity === false));
      await harness.disconnect();
      assert(calls.some(([name]) => name === "journey.unsubscribe"));
      assert.equal(state.queries.messagesGeneral.counts.stops, 1); assert.equal(state.session.counts.stops, 1);
    } finally { await harness.unmount(); }
  });
});


test("real Lit Campfire stale preference restore retires deferred activity without successor mutation", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createLitTemplate(dir, "lit-campfire-race", "campfire");
    const calls = []; let currentUser, releaseFirstSet, markFirstSet; const firstSet = new Promise((resolve) => { markFirstSet = resolve; }); let setCount = 0;
    const state = litCampfireState(calls, { async set(value) { calls.push(["journey.set", value, currentUser]); if (++setCount === 1) { markFirstSet(); await new Promise((resolve) => { releaseFirstSet = resolve; }); } return { data: null, error: null }; } });
    state.preferences.get = async () => { calls.push(["preferences.get", currentUser]); return { data: { preferences: { campfireShareActivity: currentUser === "athos-user" } }, error: null }; };
    const harness = await mountLitTemplate(projectDir, state);
    try {
      currentUser = "athos-user"; state.session.publish({ ...sessionState(), loading: false, auth: { userId: currentUser, provider: "email", isGuest: false, isAuthenticated: true } }); await firstSet;
      currentUser = "porthos-user"; state.session.publish({ ...sessionState(), loading: false, auth: { userId: currentUser, provider: "email", isGuest: false, isAuthenticated: true } }); await harness.settle();
      const disables = calls.filter(([name]) => name === "journey.disable").length; releaseFirstSet(); await harness.settle();
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, disables + 1);
      assert.equal(harness.find('input[type="checkbox"]').checked, false);
      assert.equal(calls.filter(([name, _value, owner]) => name === "journey.set" && owner === "porthos-user").length, 0);
      assert(calls.some(([name, owner]) => name === "preferences.get" && owner === "porthos-user"));
    } finally { await harness.unmount(); }
  });
});


test("sporades dev generates owned Compose for declared database Capsule services", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir);

    await withFakeLibsqlService(path.join(dir, "dev-libsql.db"), async ({ url: serviceUrl }) => {
      const servicePort = new URL(serviceUrl).port;
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: { ...docker.env, FAKE_DOCKER_SERVICE_PORT: String(servicePort) },
      });
      try {
        const starting = await waitForJsonLine(child);
        assert.deepEqual(starting, {
          ok: true,
          data: {
            event: "service",
            service: "database",
            status: "starting",
            engine: "libsql",
            statePath: path.join(".sporades", "services", "database"),
          },
          error: null,
        });
        const ready = await waitForJsonEvent(child, (event) => event.data?.event === "service" && event.data.status === "ready");
        assert.equal(ready.ok, true);
        assert.deepEqual(ready.data, {
          event: "service",
          service: "database",
          status: "ready",
          engine: "libsql",
          statePath: path.join(".sporades", "services", "database"),
          host: "127.0.0.1",
          port: Number(servicePort),
        });
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        assert.equal(started.ok, true);

        const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
        assert.match(compose, /# Sporades-owned runtime state/);
        assert.match(compose, /sporades-todo-island-database:/);
        assert.match(compose, /127\.0\.0\.1::8080/);
        assert.match(compose, /todo-island\/\.sporades\/services\/database\:\/var\/lib\/sqld:rw"/);
        const calls = await docker.calls();
        assert.equal(calls.length, 3);
        assert.deepEqual(calls[0].args.slice(0, 4), ["compose", "-p", "sporades-todo-island-services", "-f"]);
        assert.match(calls[0].args[4], /todo-island\/\.sporades\/compose\/capsule-services\.compose\.yml$/);
        assert.deepEqual(calls[0].args.slice(5), ["up", "--detach", "--remove-orphans"]);
        assert.deepEqual(calls[1].args.slice(5), ["ps", "--format", "json", "sporades-todo-island-database"]);
        assert.deepEqual(calls[2].args.slice(5), ["port", "sporades-todo-island-database", "8080"]);
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("sporades dev bundles and serves the default blank React capsule", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "blank-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    assert.deepEqual(JSON.parse(createResult.stdout).data.template, "blank");

    const projectDir = path.join(dir, "blank-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);

      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(started.data.event, "started");

      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.match(serverBundle, /blank-island/);
      assert.match(clientBundle, /Blank Sporades Capsule/);
      assert.doesNotMatch(clientBundle, /Sporades Todos|useQuery|useMutation/);
      assert.doesNotMatch(clientBundle, /stripe/i);

      socket = await openWebSocket(started.data.url.replace("http://", "ws://") + "/__sporades/ws");
      socket.send(JSON.stringify({ id: "payment-job", type: "query.subscribe", query: "paymentJob", args: ["not-a-known-job"] }));
      const paymentJob = await waitForSocketMessage(socket, (message) => message.type === "query.result" && message.id === "payment-job");
      assert.ok(paymentJob.data == null);
      assert.ok(paymentJob.error == null);

      const dormantCallback = await fetch(`${started.data.url}/stripe/webhook`, { method: "POST", body: "{}" });
      assert.equal(dormantCallback.status, 404);

      const html = await (await fetch(`${started.data.url}/`)).text();
      assert.match(html, /<div id="app"><\/div>/);
    } finally {
      await closeSocketGracefully(socket);
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("activated Stripe rejects legacy plaintext server env before publishing a Bundle", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "sealed-stripe", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "sealed-stripe");
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.payments.stripe = {
      enabled: true,
      secretKeyEnv: "STRIPE_SECRET_KEY",
      webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
      publicOrigin: "https://payments.example.test",
      callbackPath: "/stripe/webhook",
      apiVersion: "2026-08-26.dahlia",
      livemode: false,
      requestTimeoutMs: 10_000,
    };
    await writeFile(path.join(projectDir, ".env.sporades.server"), "STRIPE_SECRET_KEY=sk_test_plaintext_fixture\nSTRIPE_WEBHOOK_SECRET=whsec_plaintext_fixture\n");

    await assert.rejects(createBundle(projectDir, config), (error) => {
      assert.equal(error.code, "INVALID_STRIPE_PAYMENTS_CONFIG");
      assert.match(error.hint, /sporades env set/i);
      assert.doesNotMatch(`${error.message}\n${error.hint}`, /plaintext_fixture/);
      return true;
    });
    await assert.rejects(access(path.join(projectDir, ".sporades", "build", "server.mjs")), (error) => error.code === "ENOENT");
  });
});


test("Preact configuration without a toolchain preserves the esbuild client default", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "preact-default", "--framework", "preact", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "preact-default");
    await installFakePreact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    delete config.client.toolchain;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const bundle = await createBundle(projectDir, config, { publishLegacy: false });
    try {
      assert.match(await readFile(bundle.staticFiles.clientBundle, "utf8"), /JSX import source: preact/);
      assert.match(await readFile(bundle.staticFiles.indexHtml, "utf8"), /src="\/client\.js"/);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});


test("Vue Vite compiles native SFCs into an isolated normalized public tree", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "vue-todo-build", "--template", "todo", "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vue-todo-build");
    await installVue(projectDir);
    await writeFile(path.join(projectDir, ".env"), "VITE_VUE_LEAK=vue-browser-secret\n");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "VUE_SERVER_ONLY=vue-server-secret\n");
    await writeFile(path.join(projectDir, "vite.config.ts"), 'export default { plugins: [{ name: "vue-vite-config-loaded" }] };\n');
    await writeFile(path.join(projectDir, "postcss.config.mjs"), 'throw new Error("vue-postcss-config-loaded");\n');
    const entryPath = path.join(projectDir, "client", "index.ts");
    await writeFile(entryPath, `${await readFile(entryPath, "utf8")}\nconsole.log(import.meta.env.VITE_VUE_LEAK);\n`);
    const appSource = await readFile(path.join(projectDir, "client", "App.vue"), "utf8");
    assert.match(appSource, /useQuery\("todos"\)/);
    assert.match(appSource, /<style scoped>/);
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    const bundle = await createBundle(projectDir, config, { publishLegacy: false });
    try {
      const files = Object.keys(await snapshotProjectTree(bundle.staticFiles.publicDir)).filter((file) => !file.endsWith("/"));
      assert(files.includes("index.html"), JSON.stringify(files));
      assert(files.some((file) => /^assets\/index-[^/]+\.js$/.test(file)));
      assert(files.some((file) => /^assets\/index-[^/]+\.css$/.test(file)));
      assert(files.some((file) => /^assets\/sporades-mark-[^/]+\.svg$/.test(file)));
      assert(files.some((file) => file.endsWith(".js.map")));
      assert.equal(files.includes("client.js"), false);
      const output = (await Promise.all(files.map((file) => readFile(path.join(bundle.staticFiles.publicDir, file), "utf8")))).join("\n");
      assert.match(output, /Sporades Todos/);
      assert.doesNotMatch(output, /vue-(?:browser|server)-secret|vue-(?:vite|postcss)-config-loaded/);
      assert.doesNotMatch(output, /\/@vite\/client|react-refresh|vite\/hmr/i);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});


test("Solid Campfire stale preference restore retires deferred activity without touching successor state", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createSolidTemplate(dir, "solid-campfire-race", "campfire");
    const calls = [];
    let releaseFirstSet, firstSetStarted;
    const firstSet = new Promise((resolve) => { firstSetStarted = resolve; });
    let setCount = 0;
    const state = campfireHarnessState(calls, { async set(value) {
      const userId = globalThis.__SPORADES_SOLID_TEMPLATE_HARNESS__.controls.session.value.auth?.userId;
      calls.push(["journey.set", value, userId]);
      if (++setCount === 1) { firstSetStarted(); await new Promise((resolve) => { releaseFirstSet = resolve; }); }
      return { data: null, error: null };
    } });
    state.preferences.get = async () => {
      const userId = globalThis.__SPORADES_SOLID_TEMPLATE_HARNESS__.controls.session.value.auth?.userId;
      calls.push(["preferences.get", userId]);
      return { data: { preferences: { campfireShareActivity: userId === "athos-user" } }, error: null };
    };
    const harness = await mountSolidTemplate(projectDir, state);
    try {
      harness.setSession({ ...sessionState(), auth: { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false, isAuthenticated: true } });
      await firstSet;
      harness.setSession({ ...sessionState(), auth: { userId: "porthos-user", provider: "email", displayName: "Porthos", isGuest: false, isAuthenticated: true } });
      await harness.settle();
      const disables = calls.filter(([name]) => name === "journey.disable").length;
      releaseFirstSet();
      await harness.settle();
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, disables + 1);
      assert.equal(harness.find('input[type="checkbox"]').checked, false);
      assert.equal(calls.filter(([name, _value, userId]) => name === "journey.set" && userId === "porthos-user").length, 0);
      assert(calls.some(([name, userId]) => name === "preferences.get" && userId === "porthos-user"));
    } finally { await harness.unmount(); }
  });
});


test("Svelte Vite fails closed for missing, unsupported, unloadable, and external project compiler packages", async () => {
  for (const scenario of ["missing", "version", "load", "external"]) {
    await withTempDir(async (dir) => {
      const created = await runCli(["create", `svelte-compiler-${scenario}`, "--framework", "svelte", "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(created.code, 0, created.stderr);
      const projectDir = path.join(dir, `svelte-compiler-${scenario}`);
      if (scenario !== "missing") await installSvelte(projectDir);
      const pluginDir = path.join(projectDir, "node_modules", "@sveltejs", "vite-plugin-svelte");
      if (scenario === "version" || scenario === "load") {
        await rm(pluginDir, { recursive: true, force: true });
        await mkdir(pluginDir, { recursive: true });
        await writeFile(path.join(pluginDir, "package.json"), `${JSON.stringify({
          name: "@sveltejs/vite-plugin-svelte", version: scenario === "version" ? "6.0.0" : "5.1.1", type: "module",
          exports: { ".": { import: { default: "./index.js" } } },
        })}\n`);
        await writeFile(path.join(pluginDir, "index.js"), 'throw new Error("svelte-project-plugin-load-failure");\n');
      } else if (scenario === "external") {
        await rm(pluginDir, { recursive: true, force: true });
        await symlink(path.join(repoRoot, "node_modules", "@sveltejs", "vite-plugin-svelte"), pluginDir);
      }
      const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
      await assert.rejects(createBundle(projectDir, config), (error) => {
        assert.equal(error.phase, "client");
        assert.equal(error.framework, "svelte");
        assert.equal(error.toolchain, "vite");
        assert.match(error.hint, /npm install.*vite-plugin-svelte.*svelte/i);
        if (scenario === "missing") assert.match(error.message, /node_modules.*real directory/i);
        if (scenario === "version") assert.match(error.message, /does not support.*vite-plugin-svelte version/i);
        if (scenario === "load") assert.match(error.message, /could not load project-owned.*svelte-project-plugin-load-failure/i);
        if (scenario === "external") assert.match(error.message, /could not resolve project-owned.*vite-plugin-svelte/i);
        assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostics: error.diagnostics }), new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      });
    });
  }
});


test("sporades dev owns Preact Vite failure recovery and full-page refresh", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(
      ["create", "preact-vite-dev", "--framework", "preact", "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "preact-vite-dev");
    await installFakePreact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);
      await subscribeDevRefresh(socket);
      const chunkPath = path.join(projectDir, "client", "vite-scaffold.ts");
      const firstRefresh = readSocketMessage(socket);
      await writeFile(chunkPath, 'export const viteScaffoldLabel = "Sporades Preact/Vite rebuilt";\n');
      const rebuilt = await waitForJsonEvent(child, (event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(rebuilt.data.build, { phase: "client", framework: "preact", toolchain: "vite" });
      assert.equal((await firstRefresh).type, "refresh");
      const withoutConnectionToken = (html) => html.replace(/window\.__SPORADES_CONNECTION_TOKEN="[^"]+"/, 'window.__SPORADES_CONNECTION_TOKEN="<token>"');
      const lastGoodHtml = withoutConnectionToken(await (await fetch(started.data.url)).text());

      await writeFile(chunkPath, "export const = ;\n");
      const failed = await waitForJsonEvent(child, (event) => !event.ok && event.data?.event === "rebuild");
      assert.deepEqual(failed.data.build, { phase: "client", framework: "preact", toolchain: "vite" });
      assert.match(failed.error.message, /Client bundle failed/);
      assert.match(failed.error.hint, /Preact\/Vite client source/);
      assert(JSON.stringify(failed).length < 4096);
      assert.equal(withoutConnectionToken(await (await fetch(started.data.url)).text()), lastGoodHtml);

      const recoveredRefresh = readSocketMessage(socket);
      await writeFile(chunkPath, 'export const viteScaffoldLabel = "Sporades Preact/Vite recovered";\n');
      const recovered = await waitForJsonEvent(child, (event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(recovered.data.build, { phase: "client", framework: "preact", toolchain: "vite" });
      assert.equal((await recoveredRefresh).type, "refresh");
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev bundles and serves a scaffolded Preact photo library capsule", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(
      ["create", "photos-island", "--template", "photo-library", "--framework", "preact", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "photos-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakePreact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      assert.equal(started.ok, true, JSON.stringify(started.error));
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.match(clientBundle, /Photo Library/);
      assert.match(clientBundle, /My library/);
      assert.match(clientBundle, /runtimeAvailable/);
      assert.doesNotMatch(clientBundle, /react-dom|better-auth|googleapis|gapi|accounts\.google/);

      const rootResponse = await fetch(started.data.url);
      assert.equal(rootResponse.status, 200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("a scaffolded photo library stores uploads, public gallery rows, and Google-owned private library rows", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(
      ["create", "photos-island", "--template", "photo-library", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "photos-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = {
      mode: "google",
      google: {
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n");
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let anonymousSocket;
    let googleSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      async function waitForPhotoMessage(socket, label, predicate) {
        try {
          return await waitForSocketMessage(socket, predicate);
        } catch (error) {
          throw new Error(`${label}: ${error.message}`);
        }
      }

      // The scaffolded capsule schedules `timestampPhotoNames` on `* * * * *`, and that job rewrites
      // every photo's title and fileName with an `HH:MM ` prefix. This test is about which rows a
      // gallery query returns, not about what the timestamp job does to them — so a run that happens
      // to cross a minute boundary used to fail here with `'08:11 Shoreline'` against `'Shoreline'`.
      // Reading the titles back without the prefix keeps the assertions about gallery membership and
      // leaves the scaffold's scheduling demonstration alone.
      const photoTitles = (rows) => rows.map((photo) => String(photo.title).replace(/^\d{2}:\d{2}\s+/, ""));

      async function uploadImage(socket, id, name, body) {
        socket.send(
          JSON.stringify({
            id: `${id}-upload-url`,
            type: "file.uploadUrl",
            file: { name, type: "image/png", size: body.length },
          }),
        );
        const uploadUrl = await waitForPhotoMessage(socket, `${id} upload URL`, (message) => message.id === `${id}-upload-url`);
        assert.equal(uploadUrl.error, null);
        const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, started.data.url), {
          method: uploadUrl.data.method,
          body,
        });
        assert.equal(uploadResponse.status, 200);
        const uploaded = await uploadResponse.json();
        assert.equal(uploaded.ok, true);
        return uploaded.data.file;
      }

      anonymousSocket = await openSocket(started.data.url);
      anonymousSocket.send(JSON.stringify({ id: "anon-auth", type: "auth.get" }));
      const anonymousAuth = await waitForPhotoMessage(anonymousSocket, "anonymous auth", (message) => message.id === "anon-auth");
      assert.equal(anonymousAuth.data.auth.provider, "anonymous");

      anonymousSocket.send(JSON.stringify({ id: "anon-public", type: "query.subscribe", query: "publicPhotos" }));
      assert.deepEqual((await waitForPhotoMessage(anonymousSocket, "anonymous public initial", (message) => message.id === "anon-public")).data, []);
      anonymousSocket.send(JSON.stringify({ id: "anon-personal", type: "query.subscribe", query: "personalPhotos" }));
      assert.deepEqual((await waitForPhotoMessage(anonymousSocket, "anonymous personal initial", (message) => message.id === "anon-personal")).data, []);

      const anonymousFile = await uploadImage(anonymousSocket, "anon", "shore.png", "anonymous-image");
      anonymousSocket.send(
        JSON.stringify({
          id: "anon-url",
          type: "file.publicUrl.create",
          fileId: anonymousFile.id,
          options: { noExpiry: true },
        }),
      );
      const anonymousPublicUrl = await waitForPhotoMessage(anonymousSocket, "anonymous public URL", (message) => message.id === "anon-url");
      assert.equal(anonymousPublicUrl.error, null);
      const anonymousGalleryPromise = waitForPhotoMessage(
        anonymousSocket,
        "anonymous gallery refresh",
        (message) => message.id === "anon-public" && message.data.length === 1,
      );
      anonymousSocket.send(
        JSON.stringify({
          id: "anon-record",
          type: "mutation.run",
          mutation: "recordPhoto",
          args: [{ title: "Shoreline", file: anonymousFile, isPublic: false, publicUrl: anonymousPublicUrl.data.publicUrl }],
        }),
      );
      assert.equal((await waitForPhotoMessage(anonymousSocket, "anonymous record", (message) => message.id === "anon-record")).error, null);
      const anonymousGallery = await anonymousGalleryPromise;
      assert.deepEqual(
        anonymousGallery.data.map((photo) => ({
          title: photoTitles([photo])[0],
          isPublic: photo.isPublic,
          imageUrl: photo.imageUrl,
          fileId: photo.fileId,
        })),
        [
          {
            title: "Shoreline",
            isPublic: true,
            imageUrl: anonymousPublicUrl.data.publicUrl.url,
            fileId: anonymousFile.id,
          },
        ],
      );

      const simulated = await runCli(
        [
          "auth",
          "as",
          "google",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const googleToken = JSON.parse(simulated.stdout).data.localStorage.value;
      googleSocket = await openSocket(started.data.url, googleToken);
      googleSocket.send(JSON.stringify({ id: "google-auth", type: "auth.get" }));
      const googleAuth = await waitForPhotoMessage(googleSocket, "google auth", (message) => message.id === "google-auth");
      assert.equal(googleAuth.data.auth.provider, "google");

      googleSocket.send(JSON.stringify({ id: "google-public", type: "query.subscribe", query: "publicPhotos" }));
      const googleInitialGallery = await waitForPhotoMessage(googleSocket, "google gallery initial", (message) => message.id === "google-public");
      assert.deepEqual(photoTitles(googleInitialGallery.data), ["Shoreline"]);
      googleSocket.send(JSON.stringify({ id: "google-personal", type: "query.subscribe", query: "personalPhotos" }));
      assert.deepEqual((await waitForPhotoMessage(googleSocket, "google personal initial", (message) => message.id === "google-personal")).data, []);

      const googleFile = await uploadImage(googleSocket, "google", "cove.png", "google-image");
      const privateLibraryPromise = waitForPhotoMessage(
        googleSocket,
        "google private library refresh",
        (message) => message.id === "google-personal" && message.data.length === 1,
      );
      googleSocket.send(
        JSON.stringify({
          id: "google-record",
          type: "mutation.run",
          mutation: "recordPhoto",
          args: [{ title: "Hidden cove", file: googleFile, isPublic: false, publicUrl: null }],
        }),
      );
      assert.equal((await waitForPhotoMessage(googleSocket, "google record", (message) => message.id === "google-record")).error, null);
      const privateLibrary = await privateLibraryPromise;
      const googlePhoto = privateLibrary.data[0];
      assert.deepEqual(photoTitles([googlePhoto]), ["Hidden cove"]);
      assert.equal(googlePhoto.status, "private");
      assert.equal(googlePhoto.isPublic, false);
      assert.equal(googlePhoto.imageUrl, "");

      googleSocket.send(
        JSON.stringify({
          id: "google-url",
          type: "file.publicUrl.create",
          fileId: googleFile.id,
          options: { noExpiry: true },
        }),
      );
      const googlePublicUrl = await waitForPhotoMessage(googleSocket, "google public URL", (message) => message.id === "google-url");
      assert.equal(googlePublicUrl.error, null);
      googleSocket.send(
        JSON.stringify({
          id: "publish-url",
          type: "mutation.run",
          mutation: "updatePhotoImageUrl",
          args: [googlePhoto.id, googlePublicUrl.data.publicUrl.url],
        }),
      );
      assert.equal((await waitForPhotoMessage(googleSocket, "publish image URL", (message) => message.id === "publish-url")).error, null);
      googleSocket.send(
        JSON.stringify({
          id: "publish-url-id",
          type: "mutation.run",
          mutation: "updatePhotoPublicUrlId",
          args: [googlePhoto.id, googlePublicUrl.data.publicUrl.id],
        }),
      );
      assert.equal((await waitForPhotoMessage(googleSocket, "publish public URL id", (message) => message.id === "publish-url-id")).error, null);
      const publicLibraryPromise = waitForPhotoMessage(
        googleSocket,
        "google public library refresh",
        (message) => message.id === "google-personal" && message.data.some((photo) => photo.status === "public"),
      );
      googleSocket.send(
        JSON.stringify({
          id: "publish",
          type: "mutation.run",
          mutation: "updatePhotoIsPublic",
          args: [googlePhoto.id, true],
        }),
      );
      assert.equal((await waitForPhotoMessage(googleSocket, "publish visibility", (message) => message.id === "publish")).error, null);
      const publicLibrary = await publicLibraryPromise;
      assert.equal(publicLibrary.data[0].status, "public");
      googleSocket.send(JSON.stringify({ id: "google-public-after-publish", type: "query.subscribe", query: "publicPhotos" }));
      const expandedGallery = await waitForPhotoMessage(
        googleSocket,
        "google expanded gallery refresh",
        (message) => message.id === "google-public-after-publish",
      );
      assert.deepEqual(photoTitles(expandedGallery.data).toSorted(), ["Hidden cove", "Shoreline"]);

      const hiddenLibraryPromise = waitForPhotoMessage(
        googleSocket,
        "google hidden library refresh",
        (message) => message.id === "google-personal" && message.data.some((photo) => photo.status === "private"),
      );
      googleSocket.send(
        JSON.stringify({
          id: "hide",
          type: "mutation.run",
          mutation: "updatePhotoIsPublic",
          args: [googlePhoto.id, false],
        }),
      );
      assert.equal((await waitForPhotoMessage(googleSocket, "hide visibility", (message) => message.id === "hide")).error, null);
      const hiddenLibrary = await hiddenLibraryPromise;
      assert.equal(hiddenLibrary.data[0].status, "private");
      googleSocket.send(JSON.stringify({ id: "google-public-after-hide", type: "query.subscribe", query: "publicPhotos" }));
      const reducedGallery = await waitForPhotoMessage(
        googleSocket,
        "google reduced gallery refresh",
        (message) => message.id === "google-public-after-hide",
      );
      assert.deepEqual(photoTitles(reducedGallery.data), ["Shoreline"]);
    } finally {
      anonymousSocket?.close();
      googleSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev --public makes the relaxed CORS posture visible", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "public-dev-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "public-dev-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--public", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      assert.equal(started.data.security.cors.publicDev, true);
      assert.deepEqual(started.data.security.cors.allowedOrigins, ["*"]);

      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      assert.equal(session.publicDev, true);
      assert.equal(session.security.cors.publicDev, true);
      assert.deepEqual(session.security.cors.allowedOrigins, ["*"]);

      const response = await fetch(started.data.url, {
        headers: { origin: "https://demo.example.test" },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev endpoints resolve an existing anonymous session from the Sporades session token", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "endpoint-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { Boolean, capsule, endpoint, String, table } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },

  endpoints: {
    addTodo: endpoint({ method: "POST", path: "/integrations/todos" }, (ctx) => {
      ctx.db.todos.insert({
        text: ctx.request.body.text,
        done: false,
        ownerId: ctx.auth.userId,
      });

      return {
        status: 200,
        body: {
          auth: ctx.auth,
          rows: ctx.db.todos.where("ownerId", ctx.auth.userId).all(),
        },
      };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const authResult = await readSocketMessage(socket);

      const endpointResponse = await fetch(`${started.data.url}/integrations/todos`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sporades-session-token": authResult.data.sessionToken,
        },
        body: JSON.stringify({ text: "Owned by endpoint auth" }),
      });
      assert.equal(endpointResponse.status, 200);
      const result = await endpointResponse.json();
      assert.deepEqual(result.auth, authResult.data.auth);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].text, "Owned by endpoint auth");
      assert.equal(result.rows[0].ownerId, authResult.data.auth.userId);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev streams rebuild success events and serves the rebuilt client bundle", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      const clientPath = path.join(projectDir, "client", "index.tsx");
      const originalClient = await readFile(clientPath, "utf8");
      const changedAt = Date.now();
      await writeFile(clientPath, originalClient.replace("Sporades Todos", "Sporades Rebuilt Todos"));

      const rebuilt = await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );
      assert.ok(Date.now() - changedAt >= 90);
      assert.equal(rebuilt.error, null);
      assert.equal(rebuilt.data.port, started.data.port);
      assert.deepEqual(rebuilt.data.build, { phase: "client", framework: "react", toolchain: "esbuild" });

      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      assert.match(await clientResponse.text(), /Sporades Rebuilt Todos/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev builds and rebuilds the Vanilla TypeScript client without framework dependencies", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(
      ["create", "vanilla-island", "--template", "blank", "--framework", "vanilla", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "vanilla-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      const firstBundle = await (await fetch(`${started.data.url}/client.js`)).text();
      assert.match(firstBundle, /Vanilla Sporades/);
      assert.doesNotMatch(firstBundle, /react-dom|preact\/hooks/);

      const clientPath = path.join(projectDir, "client", "index.ts");
      const originalClient = await readFile(clientPath, "utf8");
      await writeFile(clientPath, originalClient.replace("Vanilla Sporades", "Rebuilt Vanilla Sporades"));
      const rebuilt = await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );
      assert.deepEqual(rebuilt.data.build, { phase: "client", framework: "vanilla", toolchain: "esbuild" });
      assert.match(await (await fetch(`${started.data.url}/client.js`)).text(), /Rebuilt Vanilla Sporades/);

      await rm(clientPath);
      const failed = await waitForJsonEvent(
        child,
        (event) => !event.ok && event.data.event === "rebuild" && event.data.status === "failed",
      );
      assert.match(failed.error.message, /Missing client entry: client\/index\.ts/);
      assert.deepEqual(failed.data.build, { phase: "client", framework: "vanilla", toolchain: "esbuild" });
      assert.doesNotMatch(JSON.stringify(failed), /SECRET_TOKEN|server-only/);
      assert.match(await (await fetch(`${started.data.url}/client.js`)).text(), /Rebuilt Vanilla Sporades/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev preserves Json field values through endpoints and WebSocket queries", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "json-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "json-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint, Json, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "json-island",

  schema: {
    notes: table({
      text: String(),
      meta: Json().default({ tags: [], archived: false }),
      ownerId: String(),
    }),
  },

  queries: {
    notes: query((ctx) =>
      ctx.db.notes
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    ),
  },

  mutations: {
    addNote: mutation((ctx, text: string, meta: unknown) => {
      ctx.db.notes.insert({ text, meta, ownerId: ctx.auth.userId });
    }),
    updateNoteMeta: mutation((ctx, id: string, meta: unknown) => {
      ctx.db.notes.update(id, { meta });
    }),
  },

  endpoints: {
    seed: endpoint({ method: "POST", path: "/seed" }, (ctx) => ({
      status: 200,
      body: ctx.db.notes.insert({
        text: ctx.request.body.text,
        meta: ctx.request.body.meta,
        ownerId: ctx.auth.userId,
      }),
    })),
    query: endpoint({ method: "GET", path: "/query" }, (ctx) => ({
      status: 200,
      body: {
        userId: ctx.auth.userId,
        query: ctx.request.query,
      },
    })),
    invalid: endpoint({ method: "POST", path: "/invalid-json" }, (ctx) => {
      ctx.db.notes.insert({
        text: "bad",
        meta: () => "not JSON",
        ownerId: ctx.auth.userId,
      });
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      const meta = {
        tags: ["agent", "json"],
        flags: { reviewed: true, score: 4.5 },
        values: [null, false, 7, "seven"],
      };
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
      const auth = await readSocketMessage(socket);
      const sessionToken = auth.data.sessionToken;

      const queryOnlyResponse = await fetch(`${started.data.url}/query?sessionToken=${encodeURIComponent(sessionToken)}&keep=1`);
      assert.equal(queryOnlyResponse.status, 200);
      const queryOnly = await queryOnlyResponse.json();
      assert.notEqual(queryOnly.userId, auth.data.auth.userId);
      assert.deepEqual(queryOnly.query, { keep: "1" });

      const headerQueryResponse = await fetch(`${started.data.url}/query?sessionToken=${encodeURIComponent(sessionToken)}&keep=1`, {
        headers: { "x-sporades-session-token": sessionToken },
      });
      assert.equal(headerQueryResponse.status, 200);
      assert.deepEqual(await headerQueryResponse.json(), {
        userId: auth.data.auth.userId,
        query: { keep: "1" },
      });

      const seedResponse = await fetch(`${started.data.url}/seed`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sporades-session-token": sessionToken },
        body: JSON.stringify({ text: "Seeded", meta }),
      });
      assert.equal(seedResponse.status, 200);
      const seeded = await seedResponse.json();
      assert.deepEqual(seeded.meta, meta);
      const compatibleValues = [
        ["Array", ["top", 1, null]],
        ["Boolean", true],
        ["Number", 42.5],
        ["String", "plain text"],
        ["Null", null],
      ];
      for (const [text, value] of compatibleValues) {
        const response = await fetch(`${started.data.url}/seed`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-sporades-session-token": sessionToken },
          body: JSON.stringify({ text, meta: value }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).meta, value);
      }

      socket.send(JSON.stringify({ id: "notes-1", type: "query.subscribe", query: "notes" }));
      const initial = await readSocketMessage(socket);
      assert.equal(initial.error, null);
      assert.deepEqual(initial.data.find((row) => row.text === "Seeded").meta, meta);
      for (const [text, value] of compatibleValues) {
        assert.deepEqual(initial.data.find((row) => row.text === text).meta, value);
      }

      const afterDefaultPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "notes-1" && message.type === "query.result" && message.data.length === 7,
      );
      socket.send(
        JSON.stringify({
          id: "add-1",
          type: "mutation.run",
          mutation: "addNote",
          args: ["Defaulted"],
        }),
      );
      const addResult = await readSocketMessage(socket);
      assert.equal(addResult.type, "mutation.result");
      assert.equal(addResult.error, null);
      const afterDefault = await afterDefaultPromise;
      assert.deepEqual(afterDefault.data[0].meta, { tags: [], archived: false });

      const updatedMeta = { tags: ["edited"], nested: { ok: true }, values: [1, "two", null] };
      socket.send(
        JSON.stringify({
          id: "update-1",
          type: "mutation.run",
          mutation: "updateNoteMeta",
          args: [seeded.id, updatedMeta],
        }),
      );
      const updateResult = await readSocketMessage(socket);
      assert.equal(updateResult.type, "mutation.result");
      assert.equal(updateResult.error, null);
      socket.send(JSON.stringify({ id: "notes-2", type: "query.subscribe", query: "notes" }));
      const afterUpdate = await waitForSocketMessage(
        socket,
        (message) => message.id === "notes-2" && message.type === "query.result",
      );
      assert.deepEqual(afterUpdate.data.find((row) => row.text === "Seeded").meta, updatedMeta);

      const invalidResponse = await fetch(`${started.data.url}/invalid-json`, { method: "POST" });
      assert.equal(invalidResponse.status, 500);
      assert.deepEqual(await invalidResponse.json(), {
        ok: false,
        data: null,
        error: {
          message: "Invalid JSON field value.",
          hint: "Use only JSON-compatible values: objects, arrays, strings, numbers, booleans, or null.",
        },
      });

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const notesTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "notes");
      assert.match(notesTable.rows.find((row) => row.text === "Seeded").meta, /^\{/);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev deletes Capsule rows through ctx.db table API", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "delete-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "delete-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "delete-island",

  schema: {
    notes: table({
      text: String(),
      ownerId: String(),
    }),
  },

  queries: {
    notes: query((ctx) => ctx.db.notes.where("ownerId", ctx.auth.userId).orderBy("createdAt", "desc").all()),
  },

  mutations: {
    addNote: mutation((ctx, text: string) => ctx.db.notes.insert({ text, ownerId: ctx.auth.userId })),
    deleteNote: mutation((ctx, id: string) => ctx.db.notes.delete(id)),
  },
});
`,
    );

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "notes", type: "query.subscribe", query: "notes" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      const addedPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "notes" && message.type === "query.result" && message.data.length === 1,
      );
      const addResultPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "add-note" && message.type === "mutation.result",
      );
      socket.send(JSON.stringify({ id: "add-note", type: "mutation.run", mutation: "addNote", args: ["Delete me"] }));
      const addResult = await addResultPromise;
      assert.equal(addResult.error, null);
      assert.equal(addResult.data.text, "Delete me");
      const addedRows = await addedPromise;
      const noteId = addedRows.data[0].id;

      const missingDeletePromise = waitForSocketMessage(
        socket,
        (message) => message.id === "delete-missing" && message.type === "mutation.result",
      );
      socket.send(JSON.stringify({ id: "delete-missing", type: "mutation.run", mutation: "deleteNote", args: ["missing"] }));
      assert.deepEqual(await missingDeletePromise, {
        id: "delete-missing",
        type: "mutation.result",
        mutation: "deleteNote",
        data: false,
        error: null,
      });

      const deletedPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "notes" && message.type === "query.result" && message.data.length === 0,
      );
      const deleteResultPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "delete-note" && message.type === "mutation.result",
      );
      socket.send(JSON.stringify({ id: "delete-note", type: "mutation.run", mutation: "deleteNote", args: [noteId] }));
      assert.deepEqual(await deleteResultPromise, {
        id: "delete-note",
        type: "mutation.result",
        mutation: "deleteNote",
        data: true,
        error: null,
      });
      assert.deepEqual((await deletedPromise).data, []);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const notesTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "notes");
      assert.deepEqual(notesTable.rows, []);
    } finally {
      socket?.close();
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
  });
});


test("sporades dev gives Apple HTTPS callback guidance without advertising localhost", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "apple-guidance-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "apple-guidance-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.auth = {
      providers: {
        anonymous: true,
        apple: {
          clientId: "com.example.web",
          teamId: "TEAM123",
          keyId: "KEY123",
          privateKeyEnv: "APPLE_PRIVATE_KEY",
        },
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const result = await runCli(["dev", "--json"], { cwd: projectDir });
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.message, "Apple auth is not fully configured.");
    assert.match(payload.error.hint, /Hosted HTTPS origin/);
    assert.match(payload.error.hint, /HTTPS development tunnel/);
    assert.doesNotMatch(payload.error.hint, /localhost|http:\/\//);
  });
});


test("WebSocket auth.get reports enabled providers from multi-provider config", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = {
      providers: {
        anonymous: true,
        google: {
          clientIdEnv: "GOOGLE_CLIENT_ID",
          clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        },
        email: true,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=client-id\nGOOGLE_CLIENT_SECRET=client-secret\n");
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
      const auth = await readSocketMessage(socket);

      assert.equal(auth.id, "auth-1");
      assert.deepEqual(Object.keys(auth.data.providers), ["anonymous", "email", "google", "microsoft", "apple", "facebook"]);
      assert.deepEqual(auth.data.providers.anonymous, { enabled: true, configured: true, runtimeAvailable: true });
      assert.deepEqual(auth.data.providers.email, { enabled: true, configured: true, runtimeAvailable: true });
      assert.deepEqual(auth.data.providers.google, { enabled: true, configured: true, runtimeAvailable: true });
      assert.deepEqual(auth.data.providers.microsoft, { enabled: false, configured: false, runtimeAvailable: true });
      assert.doesNotMatch(JSON.stringify(auth.data.providers), /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|client-secret/);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("Facebook auth callback uses the versioned server-owned Graph flow and accepts a profile without email", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "facebook-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "facebook-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const setResult = await runCli(
      ["auth", "set", "facebook", "--client-id", "facebook-app-id", "--client-secret", "facebook-app-secret", "--graph-version", "v23.0", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stdout || setResult.stderr);
    const configuredProject = JSON.parse(await readFile(configPath, "utf8"));
    delete configuredProject.auth.providers.facebook.graphVersion;
    configuredProject.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(configuredProject, null, 2)}\n`);

    await withFakeFacebookServer(async (facebook) => {
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: {
          SPORADES_FACEBOOK_TOKEN_URL: facebook.tokenUrl,
          SPORADES_FACEBOOK_GRAPH_URL: facebook.graphUrl,
          SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK: "1",
        },
      });
      let socket;
      try {
        const started = await waitForJsonLine(child);
        assert.equal(started.ok, true, JSON.stringify(started));
        socket = await openSocket(started.data.url);
        socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
        const anonymous = await readSocketMessage(socket);
        const anonymousUserId = anonymous.data.auth.userId;
        assert.deepEqual(anonymous.data.providers.facebook, {
          enabled: true,
          configured: true,
          runtimeAvailable: true,
          graphVersion: "v23.0",
        });

        socket.send(JSON.stringify({
          id: "signin-1",
          type: "auth.signIn",
          provider: "facebook",
          returnTo: `${started.data.url}/after`,
        }));
        const signIn = await readSocketMessage(socket);
        assert.equal(signIn.type, "auth.redirect");
        const signInUrl = new URL(signIn.data.url);
        assert.equal(signInUrl.origin, "https://www.facebook.com");
        assert.equal(signInUrl.pathname, "/v23.0/dialog/oauth");
        assert.equal(signInUrl.searchParams.get("client_id"), "facebook-app-id");
        assert.equal(signInUrl.searchParams.get("scope"), "public_profile,email");
        assert.equal(signInUrl.searchParams.get("response_type"), "code");
        assert.match(signInUrl.searchParams.get("redirect_uri"), /\/__sporades\/auth\/facebook\/callback$/);
        assert.notEqual(signInUrl.searchParams.get("state"), anonymous.data.sessionToken);
        assert.doesNotMatch(signIn.data.url, /facebook-app-secret/);

        const callbackResponse = await fetch(
          `${started.data.url}/__sporades/auth/facebook/callback?code=server-owned-code&state=${signInUrl.searchParams.get("state")}`,
          { redirect: "manual" },
        );
        assert.equal(callbackResponse.status, 302);
        assert.equal(callbackResponse.headers.get("location"), `${started.data.url}/after`);
        assert.deepEqual(facebook.requests[0], {
          method: "POST",
          path: "/token",
          query: {},
          body: {
            code: "server-owned-code",
            client_id: "facebook-app-id",
            client_secret: "facebook-app-secret",
            redirect_uri: `${started.data.url}/__sporades/auth/facebook/callback`,
          },
          authorization: null,
        });
        assert.deepEqual(facebook.requests[1], {
          method: "GET",
          path: "/v23.0/me",
          query: { fields: "id,name,email,picture" },
          body: {},
          authorization: "Bearer facebook-provider-access-token",
        });

        socket.send(JSON.stringify({ id: "auth-2", type: "auth.get" }));
        const linked = await readSocketMessage(socket);
        assert.deepEqual(linked.data.auth, {
          userId: anonymousUserId,
          displayName: "Mira Without Email",
          email: null,
          picture: "https://example.com/mira-facebook.png",
          isAuthenticated: true,
          isGuest: false,
          provider: "facebook",
        });
        assert.equal(linked.data.sessionToken, anonymous.data.sessionToken);

        const { DatabaseSync } = await import("node:sqlite");
        const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
        try {
          const persisted = sqlite.prepare(
            "SELECT provider, subject, email, displayName, picture FROM sporades_auth_identities WHERE provider = ?",
          ).get("facebook");
          assert.deepEqual({ ...persisted }, {
            provider: "facebook",
            subject: "facebook-subject-mira",
            email: null,
            displayName: "Mira Without Email",
            picture: "https://example.com/mira-facebook.png",
          });
          assert.doesNotMatch(JSON.stringify(persisted), /facebook-provider-access-token/);
        } finally {
          sqlite.close();
        }
      } finally {
        socket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("Google auth rejects spoofed forwarding without a configured public origin", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "client-id", "--client-secret", "client-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocketWithHeaders(started.data.url, {
        "x-forwarded-host": "photos.example.test",
        "x-forwarded-proto": "https",
      });

      socket.sendJson({
        id: "signin",
        type: "auth.signIn",
        provider: "google",
        returnTo: "https://photos.example.test/library",
      });
      const signIn = await socket.readJson();
      assert.equal(signIn.type, "error");
      assert.equal(signIn.error.code, "OAUTH_ORIGIN_INVALID");
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("dev inspection token rejection protects database inspection and local identity simulation", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "guarded-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "guarded-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = { providers: { anonymous: true, email: true } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const dbListResponse = await fetch(`${started.data.url}/__sporades/debug/db/list`);
      assert.equal(dbListResponse.status, 401);
      assert.equal((await dbListResponse.json()).data, null);

      const dbQueryResponse = await fetch(`${started.data.url}/__sporades/debug/db/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT name FROM sqlite_schema" }),
      });
      assert.equal(dbQueryResponse.status, 401);
      assert.equal((await dbQueryResponse.json()).data, null);

      const authResponse = await fetch(`${started.data.url}/__sporades/debug/auth/as`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sporades-inspection-token": "wrong-token",
        },
        body: JSON.stringify({ provider: "email", email: "mira@example.com" }),
      });
      assert.equal(authResponse.status, 401);
      assert.equal((await authResponse.json()).data, null);

      const { DatabaseSync } = await import("node:sqlite");
      const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
      try {
        const sessionCount = sqlite.prepare("SELECT COUNT(*) AS count FROM sporades_auth_sessions").get();
        assert.equal(sessionCount.count, 0);
      } finally {
        sqlite.close();
      }

      const dbResult = await runCli(["db", "query", "SELECT COUNT(*) AS count FROM todos", "--json"], { cwd: projectDir });
      assert.equal(dbResult.code, 0, dbResult.stderr);
      assert.deepEqual(JSON.parse(dbResult.stdout).data.rows, [{ count: 0 }]);

      const authResult = await runCli(["auth", "as", "email", "--email", "mira@example.com", "--json"], { cwd: projectDir });
      assert.equal(authResult.code, 0, authResult.stderr);
      assert.equal(JSON.parse(authResult.stdout).data.auth.email, "mira@example.com");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades db list returns tables from the running dev session database", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const listResult = await runCli(["db", "list", "--json"], { cwd: projectDir });
      assert.equal(listResult.code, 0, listResult.stderr);
      assert.deepEqual(JSON.parse(listResult.stdout), {
        ok: true,
        data: {
          tables: [
            "sporades",
            "sporades_auth_access_key_locks",
            "sporades_auth_access_key_owners",
            "sporades_auth_access_keys",
            "sporades_auth_email_credentials",
            "sporades_auth_identities",
            "sporades_auth_oauth_states",
            "sporades_auth_password_reset_codes",
            "sporades_auth_reauthentication_proofs",
            "sporades_auth_reauthentication_throttle",
            "sporades_auth_reauthentication_throttle_fence",
            "sporades_auth_service_user_locks",
            "sporades_auth_sessions",
            "sporades_auth_users",
            "sporades_file_buckets",
            "sporades_file_ingress",
            "sporades_file_ingress_audit_outbox",
            "sporades_file_public_urls",
            "sporades_file_uploads",
            "sporades_files",
            "sporades_jobs",
            "sporades_schedule_legacy_adoption",
            ...TEAM_RUNTIME_TABLES,
            "sporades_user_preferences",
            "todos",
          ],
        },
        error: null,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades db dump returns structured table data from the running dev session database", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      await waitForJsonLine(child);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const dump = JSON.parse(dumpResult.stdout);
      assert.deepEqual(dump.data.tables.filter((table) => TEAM_RUNTIME_TABLES.includes(table.name)).map((table) => table.name), TEAM_RUNTIME_TABLES);
      dump.data.tables = dump.data.tables.filter((table) => !TEAM_RUNTIME_TABLES.includes(table.name));
      assert.deepEqual(dump, {
        ok: true,
        data: {
          tables: [
            {
              name: "sporades",
              columns: ["key", "value"],
              rows: [
                { key: "stripe-event-payload-retention-sentinel-cursor-v1", value: '{"afterId":"","recheckAt":null}' },
                { key: "schedule-reconciliation-lock", value: "v1" },
                { key: "schedule-legacy-adoption-lineage-v1", value: "complete" },
                { key: "schemaVersion", value: "v1:additive-fields" },
                { key: "schemaHash", value: "f5a4b88b9bf85d0836797e22fa37197b8b38e8d9baddbec676ea15def328c3a0" },
                {
                  key: "schema",
                  value:
                    '{"tables":[{"name":"todos","fields":[{"name":"text","kind":"String","sqliteType":"TEXT"},{"name":"done","kind":"Boolean","sqliteType":"INTEGER","defaultValue":false},{"name":"ownerId","kind":"String","sqliteType":"TEXT"}],"uniqueConstraints":[]}]}',
                },
                { key: "accessKeyScopes", value: "[]" },
              ],
            },
            {
              name: "sporades_auth_access_key_locks",
              columns: ["name", "operationRevision"],
              rows: [{ name: "selector", operationRevision: 0 }],
            },
            {
              name: "sporades_auth_access_key_owners",
              columns: ["ownerUserId", "currentCount", "totalCount", "operationRevision"],
              rows: [],
            },
            {
              name: "sporades_auth_access_keys",
              columns: [
                "id", "ownerUserId", "name", "reservedName", "grantsJson", "secretVersion", "selector",
                "verifierDigest", "lifecycleRevision", "createdAt", "expiresAt", "rotatedAt", "revokedAt",
                "revocationCause", "lastUsedAt",
              ],
              rows: [],
            },
            {
              name: "sporades_auth_email_credentials",
              columns: ["email", "userId", "passwordHash", "passwordSalt", "createdAt"],
              rows: [],
            },
            {
              name: "sporades_auth_identities",
              columns: ["id", "userId", "provider", "subject", "email", "displayName", "picture", "createdAt", "updatedAt"],
              rows: [],
            },
            {
              name: "sporades_auth_oauth_states",
              columns: [
                "state",
                "provider",
                "sessionToken",
                "returnTo",
                "redirectUri",
                "createdAt",
                "expiresAt",
                "nonce",
                "pkceVerifier",
                "registrationCiphertext",
                "reauthPurpose",
                "reauthUserId",
              ],
              rows: [],
            },
            {
              name: "sporades_auth_password_reset_codes",
              columns: ["selector", "verifierHash", "email", "userId", "createdAt", "expiresAt"],
              rows: [],
            },
            {
              name: "sporades_auth_reauthentication_proofs",
              columns: ["id", "userId", "sessionToken", "purpose", "createdAt", "expiresAt"],
              rows: [],
            },
            {
              name: "sporades_auth_reauthentication_throttle",
              columns: ["key", "count", "resetAt"],
              rows: [],
            },
            {
              name: "sporades_auth_reauthentication_throttle_fence",
              columns: ["id", "version"],
              rows: [{ id: "email", version: 0 }],
            },
            {
              name: "sporades_auth_service_user_locks",
              columns: ["userId", "operationRevision"],
              rows: [],
            },
            {
              name: "sporades_auth_sessions",
              columns: ["token", "userId", "provider", "createdAt", "expiresAt"],
              rows: [],
            },
            {
              name: "sporades_auth_users",
              columns: [
                "id",
                "createdAt",
                "displayName",
                "email",
                "picture",
                "isAuthenticated",
                "isGuest",
                "provider",
                "userKind",
                "lifecycleStatus",
                "disabledAt",
              ],
              rows: [],
            },
            {
              name: "sporades_file_buckets",
              columns: ["id", "ownerId", "name", "createdAt"],
              rows: [],
            },
            {
              name: "sporades_file_ingress",
              columns: ["key", "leaseId", "state", "actorId", "authorityKind", "authorityId", "ownerId", "principalNamespace", "principalKeyDigest", "endpointMethod", "endpointPath", "requestKey", "partKey", "expiresAt", "sweepToken", "payload", "updatedAt"],
              rows: [],
            },
            {
              name: "sporades_file_ingress_audit_outbox",
              columns: ["claimId", "state", "claimToken", "createdAt", "updatedAt", "deliveredAt"],
              rows: [],
            },
            {
              name: "sporades_file_public_urls",
              columns: ["id", "fileId", "ownerId", "version", "expiresAt", "createdAt", "revokedAt"],
              rows: [],
            },
            {
              name: "sporades_file_uploads",
              columns: ["id", "fileId", "ownerId", "bucketId", "bucketName", "path", "name", "type", "version", "expectedSize", "createdAt"],
              rows: [],
            },
            {
              name: "sporades_files",
              columns: [
                "id",
                "ownerId",
                "bucketId",
                "bucketName",
                "path",
                "name",
                "type",
                "size",
                "version",
                "status",
                "createdAt",
                "updatedAt",
                "deletedAt",
              ],
              rows: [],
            },
            {
              name: "sporades_jobs",
              columns: [
                "id",
                "handler",
                "enqueuedByUserId",
                "actorUserId",
                "actorProvider",
                "payload",
                "status",
                "availableAt",
                "attempts",
                "idempotencyKey",
                "result",
                "failure",
                "createdAt",
                "startedAt",
                "completedAt",
                "failedAt",
                "retryJson",
                "attemptHistory",
                "cancelRequestedAt",
                "leaseExpiresAt",
                "claimToken",
                "scheduleName",
                "scheduledFor",
                "authSnapshotJson",
                "credentialJson",
                "payloadRetentionUntil",
                "payloadRedactedAt",
                "enqueueTraceContext",
              ],
              rows: [],
            },
            {
              name: "sporades_schedule_legacy_adoption",
              columns: ["scheduleName", "definitionFingerprint", "adoptionOpen"],
              rows: [],
            },
            {
              name: "sporades_user_preferences",
              columns: ["userId", "value", "updatedAt"],
              rows: [],
            },
            {
              name: "todos",
              columns: ["id", "createdAt", "updatedAt", "text", "done", "ownerId"],
              rows: [],
            },
          ],
        },
        error: null,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("todo message capture retains a same-turn mutation result and query refresh", async () => {
  const socket = new EventTarget();
  const messages = captureSocketMessages(socket);
  const result = { id: "mutation-1", type: "mutation.result", data: null, error: null };
  const refresh = { id: "query-1", type: "query.result", data: [{ text: "Buy milk" }], error: null };
  try {
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(result) }));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(refresh) }));
    assert.deepEqual(await messages.next(message => message.id === "mutation-1"), result);
    assert.deepEqual(await messages.next(message => message.id === "query-1"), refresh);
  } finally { messages.dispose(); }
});


test("a scaffolded guestbook stores Google-linked author metadata from ctx.auth", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "guest-island", "--template", "guestbook", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "guest-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "client-id", "--client-secret", "client-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);

    await withFakeGoogleServer(async (google) => {
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: {
          SPORADES_GOOGLE_TOKEN_URL: google.tokenUrl,
          SPORADES_GOOGLE_JWKS_URL: google.jwksUrl,
          SPORADES_OAUTH_TEST_ENDPOINTS: "1",
        },
      });
      let socket;
      try {
        const started = await waitForJsonLine(child);
        assert.equal(started.ok, true, JSON.stringify(started));
        socket = await openSocket(started.data.url);

        socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
        const anonymousAuth = await readSocketMessage(socket);
        const userId = anonymousAuth.data.auth.userId;
        assert.equal(anonymousAuth.data.providers.google.configured, true);

        socket.send(JSON.stringify({ id: "signin-1", type: "auth.signIn", provider: "google", returnTo: `${started.data.url}/guestbook` }));
        const signIn = await readSocketMessage(socket);
        assert.equal(signIn.type, "auth.redirect");
        const signInUrl = new URL(signIn.data.url);
        google.setNonce(signInUrl.searchParams.get("nonce"));
        const callbackResponse = await fetch(
          `${started.data.url}/__sporades/auth/google/callback?code=server-owned-code&state=${signInUrl.searchParams.get("state")}`,
          { redirect: "manual" },
        );
        assert.equal(callbackResponse.status, 302);
        assert.equal(callbackResponse.headers.get("location"), `${started.data.url}/guestbook`);

        socket.send(JSON.stringify({ id: "auth-2", type: "auth.get" }));
        const linkedAuth = await readSocketMessage(socket);
        assert.deepEqual(linkedAuth.data.auth, {
          userId,
          displayName: "Mira",
          email: "mira@example.com",
          picture: "https://example.com/mira.png",
          isAuthenticated: true,
          isGuest: false,
          provider: "google",
        });

        socket.send(JSON.stringify({ id: "entries-1", type: "query.subscribe", query: "entries" }));
        assert.deepEqual((await readSocketMessage(socket)).data, []);

        socket.send(JSON.stringify({ id: "sign-1", type: "mutation.run", mutation: "sign", args: ["Signed with Google"] }));
        assert.equal((await readSocketMessage(socket)).error, null);
        const refresh = await readSocketMessage(socket);
        assert.equal(refresh.data[0].body, "Signed with Google");
        assert.equal(refresh.data[0].authorId, userId);
        assert.equal(refresh.data[0].authorName, "Mira");
        assert.equal(refresh.data[0].authorPicture, "https://example.com/mira.png");
      } finally {
        socket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("server app message handlers can send filtered app messages to the current user's clients", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "message-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "message-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, message } from "sporades/server";

export default capsule({
  name: "message-island",

  messages: {
    typing: message((ctx, data) => {
      const sentToClients = ctx.messages.send({ type: "typing", data });
      return { ok: true, sentToClients };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let firstSocket;
    let secondSocket;
    let otherUserSocket;
    try {
      const started = await waitForJsonLine(child);
      firstSocket = await openSocket(started.data.url);
      firstSocket.send(JSON.stringify({ id: "first-auth", type: "auth.get" }));
      const firstAuth = await readSocketMessage(firstSocket);

      secondSocket = await openSocket(started.data.url, firstAuth.data.sessionToken);
      secondSocket.send(JSON.stringify({ id: "second-auth", type: "auth.get" }));
      assert.equal((await readSocketMessage(secondSocket)).type, "auth.result");
      otherUserSocket = await openSocket(started.data.url);

      const firstAppMessage = waitForSocketMessage(
        firstSocket,
        (message) => message.type === "app.message" && message.message === "typing",
      );
      const secondAppMessage = waitForSocketMessage(
        secondSocket,
        (message) => message.type === "app.message" && message.message === "typing",
      );
      const sendResult = waitForSocketMessage(
        firstSocket,
        (message) => message.id === "typing" && message.type === "app.result",
      );

      firstSocket.send(
        JSON.stringify({
          id: "typing",
          type: "app.send",
          message: "typing",
          data: { roomId: "general", active: true },
        }),
      );

      assert.deepEqual(await firstAppMessage, {
        type: "app.message",
        message: "typing",
        data: { roomId: "general", active: true },
      });
      assert.deepEqual(await secondAppMessage, {
        type: "app.message",
        message: "typing",
        data: { roomId: "general", active: true },
      });
      assert.deepEqual(await sendResult, {
        id: "typing",
        type: "app.result",
        message: "typing",
        data: { ok: true, sentToClients: 2 },
        error: null,
      });

      otherUserSocket.send(JSON.stringify({ id: "other-auth", type: "auth.get" }));
      assert.equal((await readSocketMessage(otherUserSocket)).type, "auth.result");
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      otherUserSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev refreshes only subscriptions that read a table a mutation or Job wrote", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "scoped-refresh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "scoped-refresh-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, job, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "scoped-refresh-island",

  schema: {
    todos: table({ text: String(), ownerId: String() }),
    notes: table({ text: String(), ownerId: String() }),
    audits: table({ text: String() }),
  },

  queries: {
    todos: query((ctx) => ctx.db.todos.where("ownerId", ctx.auth.userId).orderBy("createdAt", "asc").all()),
    notes: query((ctx) => ctx.db.notes.where("ownerId", ctx.auth.userId).orderBy("createdAt", "asc").all()),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => ctx.db.todos.insert({ text, ownerId: ctx.auth.userId })),
    addNote: mutation((ctx, text: string) => ctx.db.notes.insert({ text, ownerId: ctx.auth.userId })),
    audit: mutation((ctx, text: string) => ctx.db.audits.insert({ text })),
    queueNote: mutation(async (ctx, text: string) => {
      await ctx.jobs.enqueue("writeNote", { text, ownerId: ctx.auth.userId });
      return { queued: true };
    }),
  },

  jobs: {
    writeNote: job((ctx, payload: { text: string; ownerId: string }) => {
      ctx.db.notes.insert({ text: payload.text, ownerId: payload.ownerId });
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);
      socket.send(JSON.stringify({ id: "notes", type: "query.subscribe", query: "notes" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      // Returns the ids of messages that arrive before a sentinel request's reply.
      const drainUntil = async (label) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        socket.send(JSON.stringify({ id: label, type: "auth.get" }));
        const seen = [];
        for (let message = await readSocketMessage(socket); message.id !== label; message = await readSocketMessage(socket)) seen.push(message.id);
        return seen;
      };
      const expectOnlyNext = async (label) => {
        assert.deepEqual(await drainUntil(label), [], `${label}: no other subscription was refreshed`);
      };

      // Startup schema statements are unidentified writes, which may make one refresh a full one.
      socket.send(JSON.stringify({ id: "warm", type: "mutation.run", mutation: "audit", args: ["warm-up"] }));
      assert.equal((await readSocketMessage(socket)).id, "warm");
      await drainUntil("after-warm");

      socket.send(JSON.stringify({ id: "add-todo", type: "mutation.run", mutation: "addTodo", args: ["ship"] }));
      assert.equal((await readSocketMessage(socket)).id, "add-todo");
      const todoRefresh = await readSocketMessage(socket);
      assert.equal(todoRefresh.id, "todos");
      assert.deepEqual(todoRefresh.data.map((todo) => todo.text), ["ship"]);
      await expectOnlyNext("after-todo");

      socket.send(JSON.stringify({ id: "unrelated", type: "mutation.run", mutation: "audit", args: ["unrelated"] }));
      assert.equal((await readSocketMessage(socket)).id, "unrelated");
      await expectOnlyNext("after-unrelated");

      // The mutation itself writes only the Job table; the Job's completion refreshes notes alone.
      socket.send(JSON.stringify({ id: "queue-note", type: "mutation.run", mutation: "queueNote", args: ["from job"] }));
      assert.equal((await readSocketMessage(socket)).id, "queue-note");
      const noteRefresh = await readSocketMessage(socket);
      assert.equal(noteRefresh.id, "notes");
      assert.deepEqual(noteRefresh.data.map((note) => note.text), ["from job"]);
      await expectOnlyNext("after-job");

      socket.send(JSON.stringify({ id: "add-note", type: "mutation.run", mutation: "addNote", args: ["direct"] }));
      assert.equal((await readSocketMessage(socket)).id, "add-note");
      const directNoteRefresh = await readSocketMessage(socket);
      assert.equal(directNoteRefresh.id, "notes");
      assert.deepEqual(directNoteRefresh.data.map((note) => note.text), ["from job", "direct"]);
      await expectOnlyNext("after-note");
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev runs Capsule mutation handlers from the bundled module", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "bundled-mutation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "bundled-mutation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

const TODO_PREFIX = "bundled:";

export default capsule({
  name: "bundled-mutation-island",

  schema: {
    todos: table({
      text: String(),
      ownerId: String(),
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({
        text: TODO_PREFIX + text.trim().replace(/\\s+/g, " "),
        ownerId: ctx.auth.userId,
      });
      if (text.trim() === "rollback") {
        throw Object.assign(new Error("No rollback todos."), {
          hint: "Try calmer todo text.",
        });
      }
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "record", type: "mutation.run", mutation: "addTodo", args: ["  imported   helper  "] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "record",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: null,
      });

      const refreshed = await readSocketMessage(socket);
      assert.equal(refreshed.id, "todos");
      assert.equal(refreshed.type, "query.result");
      assert.equal(refreshed.error, null);
      assert.deepEqual(
        refreshed.data.map((todo) => todo.text),
        ["bundled:imported helper"],
      );

      socket.send(JSON.stringify({ id: "rollback", type: "mutation.run", mutation: "addTodo", args: ["rollback"] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "rollback",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          message: "No rollback todos.",
          hint: "Try calmer todo text.",
        },
      });

      const dumpResult = await runCli(["db", "query", "SELECT text FROM todos ORDER BY createdAt", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      assert.deepEqual(JSON.parse(dumpResult.stdout).data.rows, [{ text: "bundled:imported helper" }]);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev awaits async endpoint handlers and context middleware before writing responses", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "async-endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "async-endpoint-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "TENANT=green\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "async-endpoint-island",

  middleware: [
    async (ctx) => {
      await Promise.resolve();
      return { ...ctx, tenant: ctx.env.TENANT };
    },
  ],

  endpoints: {
    tenant: endpoint({ method: "GET", path: "/tenant" }, async (ctx) => {
      await Promise.resolve();
      return {
        status: 202,
        headers: { "x-tenant": ctx.tenant },
        body: {
          tenant: ctx.tenant,
          kind: ctx.kind,
        },
      };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));

      const response = await fetch(`${started.data.url}/tenant`);
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("x-tenant"), "green");
      assert.deepEqual(await response.json(), {
        tenant: "green",
        kind: "endpoint",
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev applies the safe MIME allowlist to private and public file URL responses", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "file-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "file-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);

      async function sendAndWait(payload) {
        socket.send(JSON.stringify(payload));
        return await waitForSocketMessage(socket, (message) => message.id === payload.id);
      }

      async function uploadCase(id, file, body) {
        const uploadUrl = await sendAndWait({
          id: `${id}-upload-url`,
          type: "file.uploadUrl",
          file: { ...file, size: Buffer.byteLength(body) },
        });
        assert.equal(uploadUrl.error, null, uploadUrl.error?.message);
        const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, started.data.url), {
          method: uploadUrl.data.method,
          body,
        });
        assert.equal(uploadResponse.status, 200);
        const uploaded = await uploadResponse.json();
        assert.equal(uploaded.ok, true, uploaded.error?.message);
        return uploaded.data.file;
      }

      const auth = await sendAndWait({ id: "auth", type: "auth.get" });
      const cases = [
        {
          id: "text",
          file: { name: "safe.txt", type: "text/plain", path: "/mime/safe.txt" },
          body: "plain text",
          expectedContentType: "text/plain",
        },
        {
          id: "png",
          file: { name: "safe.png", type: "image/png", path: "/mime/safe.png" },
          body: "png bytes",
          expectedContentType: "image/png",
        },
        {
          id: "html",
          file: { name: "page.html", type: "text/html", path: "/mime/page.html" },
          body: "<script>throw new Error('nope')</script>",
          expectedContentType: "application/octet-stream",
        },
        {
          id: "svg",
          file: { name: "vector.svg", type: "image/svg+xml", path: "/mime/vector.svg" },
          body: "<svg><script>throw new Error('nope')</script></svg>",
          expectedContentType: "application/octet-stream",
        },
        {
          id: "xml",
          file: { name: "feed.xml", type: "application/xml", path: "/mime/feed.xml" },
          body: "<?xml version=\"1.0\"?><feed />",
          expectedContentType: "application/octet-stream",
        },
        {
          id: "missing",
          file: { name: "missing-type.bin", path: "/mime/missing-type.bin" },
          body: "missing type",
          expectedContentType: "application/octet-stream",
        },
        {
          id: "unknown",
          file: { name: "unknown.bin", type: "application/x-unknown", path: "/mime/unknown.bin" },
          body: "unknown type",
          expectedContentType: "application/octet-stream",
        },
      ];

      for (const testCase of cases) {
        const file = await uploadCase(testCase.id, testCase.file, testCase.body);
        const privateUrl = await sendAndWait({
          id: `${testCase.id}-private-url`,
          type: "file.url",
          fileId: file.id,
        });
        assert.equal(privateUrl.error, null);
        const privateRead = await fetch(new URL(privateUrl.data.url, started.data.url), {
          headers: { "x-sporades-session-token": auth.data.sessionToken },
        });
        assert.equal(privateRead.status, 200);
        assert.equal(privateRead.headers.get("content-type"), testCase.expectedContentType);
        assert.equal(await privateRead.text(), testCase.body);

        const publicUrl = await sendAndWait({
          id: `${testCase.id}-public-url`,
          type: "file.publicUrl.create",
          fileId: file.id,
          options: { noExpiry: true },
        });
        assert.equal(publicUrl.error, null);
        const publicRead = await fetch(new URL(publicUrl.data.publicUrl.url, started.data.url));
        assert.equal(publicRead.status, 200);
        assert.equal(publicRead.headers.get("content-type"), testCase.expectedContentType);
        assert.equal(await publicRead.text(), testCase.body);
      }
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("Dev admission denies malformed raw targets before application execution and fallback failure logging", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "malformed-admission", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "malformed-admission");
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.admissionPolicy = { path: "policy.json" };
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(projectDir, "policy.json"), JSON.stringify({
      version: 1,
      rules: [{ id: "unrelated", enabled: true, conditions: [{ kind: "pathname", exact: "/blocked" }], action: { kind: "deny" } }],
    }));
    await writeFile(path.join(projectDir, "server", "index.ts"), `import { capsule, endpoint } from "sporades/server";
export default capsule({ name: "malformed-admission", middleware: [(ctx) => {
  globalThis.process.getBuiltinModule("node:fs").appendFileSync("app-called", "called\\n");
  return ctx;
}], endpoints: { admin: endpoint({ method: "GET", path: "/admin" }, () => ({ status: 200, body: "application" })) } });`);
    const child = startCli(["dev", "--json"], { cwd: projectDir });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(await (await fetch(`${started.data.url}/admin`)).text(), "application");
      assert.equal(await readFile(path.join(projectDir, "app-called"), "utf8"), "called\n");
      await rm(path.join(projectDir, "app-called"));
      for (const target of ["/%", "ftp://example.test/admin", "http://user:secret@example.test/admin", "http://example.test:bad/admin"]) {
        const response = await rawHttpResponse(started.data.url, target);
        assert.match(response, /^HTTP\/1\.1 403 Forbidden\r\n/, response);
        assert.match(response, /\r\ncache-control: no-store\r\n/i, response);
        assert.match(response, /\r\ncontent-length: 10\r\n/i, response);
        assert.deepEqual(Buffer.from(response.slice(response.indexOf("\r\n\r\n") + 4)), Buffer.from("Forbidden\n"));
        await assert.rejects(readFile(path.join(projectDir, "app-called")), { code: "ENOENT" });
      }
      const logs = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logs.code, 0, logs.stderr);
      assert.equal(JSON.parse(logs.stdout).data.entries.some((entry) => entry.event === "http.request.failed"), false, logs.stdout);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
    }
  });
});


test("Dev admission policy enforces denial across hot failures, rebuilds, removal and active-policy restart", async () => {
  await withTempDir(async dir => {
    const created = await runCli(["create","admission-dev","--no-install","--no-git","--json"],{cwd:dir}); assert.equal(created.code,0,created.stderr);
    const projectDir = path.join(dir,"admission-dev"); await installFakeReact(projectDir);
    const configPath = path.join(projectDir,"sporades.json"); const config = JSON.parse(await readFile(configPath,"utf8")); config.dev.port=0; config.admissionPolicy={path:"policy.json"}; await writeFile(configPath,JSON.stringify(config));
    await writeFile(path.join(projectDir,"server","index.ts"),`import { capsule, endpoint } from "sporades/server";
export default capsule({ name: "admission-dev", endpoints: {
  blocked: endpoint({method:"GET",path:"/blocked"}, () => { globalThis.process.getBuiltinModule("node:fs").appendFileSync("app-called","called\\n"); return {status:202,body:"application"}; }),
  allowed: endpoint({method:"POST",path:"/allowed"}, ctx => ({status:201,headers:{"x-application":"unchanged"},body:{method:ctx.request.method,path:ctx.request.path,query:ctx.request.query.source,header:ctx.request.headers["x-source"],body:ctx.request.body}})),
} });`);
    const policyPath = path.join(projectDir,"policy.json"); await writeFile(policyPath,"{");
    let child = startCli(["dev","--json"],{cwd:projectDir}); let exited = new Promise(resolve=>child.once("exit",resolve));
    try { const first = await waitForJsonLine(child); assert.equal(first.ok,false,JSON.stringify(first)); assert.match(first.error.message,/Configured admission policy/); }
    finally { if(child.exitCode===null) child.kill("SIGTERM"); await exited; }
    const json = (id, exact = "/blocked") => JSON.stringify({version:1,rules:[{id,enabled:true,conditions:[{kind:"pathname",exact}],action:{kind:"deny"}}]}); await writeFile(policyPath,json("seed"));
    child = startCli(["dev","--json"],{cwd:projectDir}); exited = new Promise(resolve=>child.once("exit",resolve));
    try {
      let started = await waitForJsonLine(child); assert.equal(started.ok,true,JSON.stringify(started));
      let session = JSON.parse(await readFile(path.join(projectDir,".sporades","dev-session.json"),"utf8"));
      const health = async () => (await (await fetch(`${started.data.url}/__sporades/health/runtime`,{headers:{"x-sporades-host-probe":session.inspectionToken}})).json()).data.runtime.admissionPolicy;
      const denied = async () => {
        const response = await fetch(`${started.data.url}/blocked?private=opaque`);
        assert.equal(response.status,403); assert.equal(response.headers.get("cache-control"),"no-store"); assert.equal(response.headers.get("content-length"),"10"); assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from("Forbidden\n"));
        await assert.rejects(readFile(path.join(projectDir,"app-called")),{code:"ENOENT"});
      };
      const allowed = async () => {
        const response = await fetch(`${started.data.url}/allowed?source=unchanged`,{method:"POST",headers:{"x-source":"original","content-type":"application/json"},body:JSON.stringify({text:"untouched bytes"})});
        assert.equal(response.status,201); assert.equal(response.headers.get("x-application"),"unchanged");
        assert.deepEqual(await response.json(),{method:"POST",path:"/allowed",query:"unchanged",header:"original",body:{text:"untouched bytes"}});
      };
      const restart = async () => {
        child.kill("SIGTERM"); await exited;
        child = startCli(["dev","--json"],{cwd:projectDir}); exited = new Promise(resolve=>child.once("exit",resolve));
        started = await waitForJsonLine(child); assert.equal(started.ok,true,JSON.stringify(started));
        session = JSON.parse(await readFile(path.join(projectDir,".sporades","dev-session.json"),"utf8"));
      };
      const initial = await health(); assert.equal(initial.state,"healthy");
      await denied(); await allowed();
      assert.equal((await fetch(`${started.data.url}/__sporades/connection-token`,{headers:{"x-sporades-connection-token-request":"1"}})).status,200);
      const wait = async predicate => {const deadline=Date.now()+9000;while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}assert.fail("policy failed to converge");};
      await writeFile(policyPath,"{"); await wait(async()=> (await health()).state==="degraded"); assert.equal((await health()).digest,initial.digest);
      await denied(); await allowed();
      const rebuilt = waitForJsonEvent(child,event=>event.ok&&event.data?.event==="rebuild"&&event.data?.status==="success");
      await writeFile(path.join(projectDir,"server","index.ts"),(await readFile(path.join(projectDir,"server","index.ts"),"utf8"))+"\n// rebuild while policy is degraded\n");
      await rebuilt; assert.equal((await health()).digest,initial.digest); await denied(); await allowed();
      await writeFile(policyPath,json("updated", "/other")); await wait(async()=> (await health()).state==="healthy" && (await health()).digest!==initial.digest);
      const admitted = await fetch(`${started.data.url}/blocked`); assert.equal(admitted.status,202); assert.equal(await admitted.text(),"application"); assert.equal(await readFile(path.join(projectDir,"app-called"),"utf8"),"called\n");
      await rm(path.join(projectDir,"app-called"));
      const replacementDigest = (await health()).digest;
      await writeFile(policyPath,json("restart-active"));
      await wait(async()=> (await health()).state==="healthy" && (await health()).digest!==replacementDigest);
      await denied(); await allowed();
      const activeDigest = (await health()).digest;
      await restart(); assert.equal((await health()).state,"healthy"); assert.equal((await health()).digest,activeDigest);
      await denied(); await allowed();
      // The durable marker written by authorized policy removal, not a missing file.
      await writeFile(policyPath,'{"sporadesAdmissionPublication":1,"removed":true}\n');
      await wait(async()=> (await health()).state==="disabled"); assert.equal((await health()).digest,null);
      const removed = await fetch(`${started.data.url}/blocked`); assert.equal(removed.status,202); assert.equal(await removed.text(),"application"); assert.equal(await readFile(path.join(projectDir,"app-called"),"utf8"),"called\n");
      await rm(path.join(projectDir,"app-called")); await allowed();
      await restart(); assert.equal((await health()).state,"disabled"); assert.equal((await health()).digest,null);
      const removedRestart = await fetch(`${started.data.url}/blocked`); assert.equal(removedRestart.status,202); assert.equal(await removedRestart.text(),"application"); assert.equal(await readFile(path.join(projectDir,"app-called"),"utf8"),"called\n");
      await allowed();
    } finally { if(child.exitCode===null) child.kill("SIGTERM"); await exited; }
  });
});
