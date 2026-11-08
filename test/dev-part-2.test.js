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
  withTempDir,
  runRealBrowserRedirectTracer,
  snapshotProjectTree,
  runCli,
  startCliFrom,
  startCli,
  packCandidateInto,
  installPackedCandidate,
  installFakeDocker,
  rawHttpResponse,
  waitForJsonLine,
  waitForJsonEvent,
  captureJsonEvents,
  installFakeReact,
  installFakePreact,
  installVue,
  nodeText,
  sessionState,
  authStub,
  litSource,
  createLitTemplate,
  createInfernoTemplate,
  withFakeMicrosoftServer,
  openSocket,
  subscribeDevRefresh,
  readSocketMessage,
  waitForSocketClose,
  waitForSocketMessage
} from "./support/dev-fixture.js";



test("Dev runtime wires the Stripe Team Billing provider on initial start and hot restart", async () => {
  const source = await readFile(path.join(repoRoot, "src", "cli", "sporades.ts"), "utf8");
  const runtimeSource = source.slice(source.indexOf("async function createDevRuntime"), source.indexOf("function createDevInspectionToken"));
  assert.equal(
    [...runtimeSource.matchAll(/createStripeTeamBillingProvider:\s*await stripeTeamBillingProviderFactory\(/g)].length,
    2,
    "both initial and replacement Dev databases must receive the built-in Team Billing provider factory",
  );
});


test("client toolchains reject the server-only Stripe integration boundary", async () => {
  for (const toolchain of ["esbuild", "vite"]) {
    await withTempDir(async (dir) => {
      const created = await runCli(["create", `stripe-client-${toolchain}`, "--framework", "react", "--toolchain", toolchain, "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(created.code, 0, created.stderr);
      const projectDir = path.join(dir, `stripe-client-${toolchain}`);
      await installFakeReact(projectDir);
      const clientSourcePath = path.join(projectDir, "client", "index.tsx");
      const clientSource = `import { createStripePaymentIntegration } from "sporades/server/stripe";\nvoid createStripePaymentIntegration;\n${await readFile(clientSourcePath, "utf8")}`;
      await writeFile(clientSourcePath, clientSource);
      const indexHtmlPath = path.join(projectDir, "index.html");

      await assert.rejects(
        buildClientToolchain({
          projectDir,
          frameworkConfig: { framework: "react", entry: "index.tsx", loader: "tsx", jsxImportSource: "react", jsxRuntimeImport: "react/jsx-runtime" },
          toolchain,
          clientSource,
          clientSourcePath,
          indexHtml: await readFile(indexHtmlPath, "utf8"),
          indexHtmlPath,
        }),
        (error) => {
          assert.match(error.message, /client code cannot import server-only Sporades modules/i);
          return true;
        },
      );
    });
  }
});


test("Vite build diagnostics redact short relative project roots only as path prefixes", async () => {
  for (const projectName of ["a", "app"]) {
    const projectDir = path.join(process.cwd(), projectName);
    const clientDir = path.join(projectDir, "client");
    const clientSourcePath = path.join(clientDir, "index.tsx");
    const indexHtmlPath = path.join(projectDir, "index.html");
    const relativeSource = `${projectName}/client/index.tsx`;
    const windowsRelativeSource = relativeSource.replaceAll("/", "\\");
    const windowsAbsoluteSource = clientSourcePath.replaceAll("/", "\\");
    const readableProse = "A capable app can map an application and adapt a banner";
    const posixCaseDistinctPath = `${projectName.toUpperCase()}/client/index.tsx`;
    const embeddedWordPaths = [
      `café${projectName}/client/index.tsx`,
      `e\u0301${projectName}/client/index.tsx`,
      `Ω${projectName}/client/index.tsx`,
      `界${projectName}/client/index.tsx`,
      `١${projectName}/client/index.tsx`,
      `word‿${projectName}/client/index.tsx`,
    ];
    await assert.rejects(access(projectDir), (error) => error.code === "ENOENT");
    try {
      await mkdir(clientDir, { recursive: true });
      await writeFile(clientSourcePath, "export {}\n");
      await writeFile(indexHtmlPath, '<script type="module" src="/client/index.tsx"></script>\n');
      await writeFile(
        path.join(projectDir, "vite.config.mjs"),
        `throw new Error(${JSON.stringify(`${readableProse}; embedded=${embeddedWordPaths.join("|")}; case=${posixCaseDistinctPath}; absolute=${clientSourcePath}?mode=build; windows=${windowsAbsoluteSource}:7:3; stack=(${relativeSource}:8:4); query=?file=${relativeSource}; quoted='${windowsRelativeSource}'; spaced= ${relativeSource}`)});\n`,
      );

      await assert.rejects(
        buildClientToolchain({
          projectDir,
          frameworkConfig: { framework: "react", entry: "index.tsx", loader: "tsx", jsxImportSource: "react", jsxRuntimeImport: "react/jsx-runtime" },
          toolchain: "vite",
          clientSource: "export {}\n",
          clientSourcePath,
          indexHtml: await readFile(indexHtmlPath, "utf8"),
          indexHtmlPath,
        }),
        (error) => {
          assert.match(error.message, new RegExp(readableProse));
          for (const embedded of embeddedWordPaths) assert.equal(error.message.includes(embedded), true, embedded);
          assert.equal(error.message.includes(`case=${posixCaseDistinctPath}`), true);
          assert.match(error.message, /absolute=<project>\/client\/index\.tsx\?mode=build/);
          assert.match(error.message, /windows=<project>\\client\\index\.tsx:7:3/);
          assert.match(error.message, /stack=\(<project>\/client\/index\.tsx:8:4\)/);
          assert.match(error.message, /query=\?file=<project>\/client\/index\.tsx/);
          assert.match(error.message, /quoted='<project>\\client\\index\.tsx'/);
          assert.match(error.message, /spaced= <project>\/client\/index\.tsx/);
          assert.equal(error.message.includes(projectDir), false);
          assert.equal(error.message.includes(windowsAbsoluteSource), false);
          return true;
        },
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }
});


test("generated demo controls offer only available OAuth actions and preserve guest state", async () => {
  for (const template of ["todo", "guestbook", "photo-library"]) await withTempDir(async (dir) => {
    const projectDir = await createInfernoTemplate(dir, `signin-${template}`, template);
    const available = { enabled: true, configured: true, runtimeAvailable: true };
    const guest = { userId: "guest", provider: "anonymous", isGuest: true, isAuthenticated: false };
    const providers = {
      anonymous: available, email: available, google: available, facebook: available, futureProvider: available,
      microsoft: { ...available, configured: false }, apple: { ...available, runtimeAvailable: false },
    };
    const session = litSource({ auth: guest, providers, error: null, loading: false });
    const calls = [];
    const harness = await mountInfernoTemplate(projectDir, {
      session, auth: authStub({ async signIn(...args) { calls.push(args); return { data: null, error: null }; } }),
      queries: Object.fromEntries(["todos", "entries", "publicPhotos", "personalPhotos"].map(name => [name, litSource({ data: [], error: null, loading: false })])),
      mutations: Object.fromEntries(["addTodo", "sign", "recordPhoto", "updatePhotoIsPublic", "updatePhotoImageUrl", "updatePhotoPublicUrlId"].map(name => [name, { async run() { return { data: null, error: null }; } }])),
      files: {},
    });
    const controls = () => [...harness.window.document.querySelectorAll("button")].filter(button => button.textContent.startsWith("Sign in with"));
    try {
      assert.deepEqual(controls().map(button => button.textContent), ["Sign in with Google", "Sign in with Facebook"], template);
      controls()[0].click(); await harness.settle();
      assert.deepEqual(calls, [["google"]]);
      session.publish({ auth: guest, providers: { ...providers, google: { ...available, enabled: false } }, error: null, loading: false });
      await harness.settle();
      assert.deepEqual(controls().map(button => button.textContent), ["Sign in with Facebook"]);
      session.publish({ auth: { ...guest, provider: "facebook", isGuest: false, isAuthenticated: true }, providers, error: null, loading: false });
      await harness.settle();
      assert.deepEqual(controls(), []);
      session.publish({ auth: guest, providers: { anonymous: available, email: available }, error: null, loading: false });
      await harness.settle();
      assert.deepEqual(controls(), []);
    } finally { await harness.unmount(); }
  });
});


test("real Inferno todo renders, mutates, and reconnects native component lifecycle", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createInfernoTemplate(dir, "inferno-todo-behavior", "todo");
    const calls = [], queryListeners = new Set(), sessionListeners = new Set();
    const counts = { queryStarts: 0, queryStops: 0, sessionStarts: 0, sessionStops: 0 };
    const source = (listeners, starts, stops, initial) => ({ subscribe(listener) { counts[starts] += 1; listeners.add(listener); listener(initial); return { unsubscribe() { if (listeners.delete(listener)) counts[stops] += 1; } }; } });
    const harness = await mountInfernoTemplate(projectDir, {
      auth: authStub(),
      session: source(sessionListeners, "sessionStarts", "sessionStops", { auth: null, providers: {}, loading: false, error: null }),
      queries: { todos: source(queryListeners, "queryStarts", "queryStops", { data: [{ id: "i1", text: "Cross the native lifecycle seam" }], error: null, loading: false }) },
      mutations: { addTodo: { async run(value) { calls.push(value); return { data: { id: "i2" }, error: null }; } } },
    });
    try {
      assert.match(harness.text(), /Sporades Todos.*Cross the native lifecycle seam/s);
      assert.deepEqual(counts, { queryStarts: 1, queryStops: 0, sessionStarts: 1, sessionStops: 0 });
      const input = harness.find('input[aria-label="Todo"]');
      input.value = "  Ship Inferno  "; input.dispatchEvent(new harness.window.Event("input", { bubbles: true })); await harness.settle();
      assert.equal(harness.find("button").disabled, false);
      harness.find("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true, cancelable: true })); await harness.settle();
      assert.deepEqual(calls, ["Ship Inferno"]); assert.equal(harness.find('input[aria-label="Todo"]').value, "");
      await harness.disconnect(); await harness.disconnect();
      assert.deepEqual(counts, { queryStarts: 1, queryStops: 1, sessionStarts: 1, sessionStops: 1 });
      await harness.reconnect();
      assert.deepEqual(counts, { queryStarts: 2, queryStops: 1, sessionStarts: 2, sessionStops: 1 });
    } finally { await harness.unmount(); }
    assert.deepEqual(counts, { queryStarts: 2, queryStops: 2, sessionStarts: 2, sessionStops: 2 });
  });
});


test("real Inferno Guestbook renders, mutates, handles auth errors, and cleans lifecycle", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createInfernoTemplate(dir, "inferno-guestbook-behavior", "guestbook", { toolchain: "vite" });
    const calls = [], entries = litSource({ data: [{ id: "e1", authorName: "Athos", body: "All for one", createdAt: "2026-07-12T12:00:00Z" }], error: null, loading: false });
    const session = litSource({ auth: null, providers: { google: { enabled: true, configured: true, runtimeAvailable: true } }, error: null, loading: false });
    const harness = await mountInfernoTemplate(projectDir, { auth: { ...authStub(), async signIn() { return { data: null, error: { message: "Auth refused" } }; } }, session, queries: { entries }, mutations: { sign: { async run(value) { calls.push(value); return { data: null, error: null }; } } } });
    try {
      assert.match(harness.text(), /Leave a note from this island.*All for one/s);
      const textarea = harness.find("textarea"); textarea.value = "  One for all  "; textarea.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
      harness.find("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true, cancelable: true })); await harness.settle();
      assert.deepEqual(calls, ["One for all"]); assert.equal(harness.find("textarea").value, "");
      harness.find('button[type="button"]').click(); await harness.settle(); assert.match(harness.text(), /Auth refused/);
    } finally { await harness.unmount(); }
    assert.deepEqual([session.counts.starts, session.counts.stops, entries.counts.starts, entries.counts.stops], [1, 1, 1, 1]);
  });
});


test("real Lit Photo Library surfaces and recovers structured sign-in and sign-out failures", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createLitTemplate(dir, "lit-photo-auth", "photo-library");
    const session = litSource({ ...sessionState(), loading: false }); let signInFails = true, signOutFails = true;
    const auth = authStub({ async signIn() { return signInFails ? { data: null, error: new Error("Google sign-in failed") } : { data: null, error: null }; }, async signOut() { return signOutFails ? { data: null, error: new Error("Sign-out failed") } : { data: null, error: null }; } });
    const mutation = { async run() { return { data: null, error: null }; } };
    const harness = await mountLitTemplate(projectDir, { auth, files: {}, journey: {}, preferences: {}, session, queries: { publicPhotos: litSource({ data: [], error: null, loading: false }), personalPhotos: litSource({ data: [], error: null, loading: false }) }, mutations: { recordPhoto: mutation, updatePhotoIsPublic: mutation, updatePhotoImageUrl: mutation, updatePhotoPublicUrlId: mutation } });
    const button = (label) => [...harness.element.shadowRoot.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
    try {
      button("Sign in with Google").dispatchEvent(new harness.window.Event("click", { bubbles: true })); await harness.settle(); assert.match(harness.text(), /Google sign-in failed/);
      signInFails = false; button("Sign in with Google").dispatchEvent(new harness.window.Event("click", { bubbles: true })); await harness.settle(); assert.doesNotMatch(harness.text(), /Google sign-in failed/);
      session.publish({ ...sessionState(), loading: false, auth: { userId: "athos", provider: "google", displayName: "Athos", isAuthenticated: true } }); await harness.settle(); assert(button("Sign out"));
      button("Sign out").dispatchEvent(new harness.window.Event("click", { bubbles: true })); await harness.settle(); assert.match(harness.text(), /Sign-out failed/); assert(button("Sign out"));
      signOutFails = false; button("Sign out").dispatchEvent(new harness.window.Event("click", { bubbles: true })); await harness.settle(); assert.doesNotMatch(harness.text(), /Sign-out failed/);
      session.publish({ ...sessionState(), loading: false }); await harness.settle(); assert(button("Sign in with Google"));
    } finally { await harness.unmount(); }
  });
});


test("sporades dev keeps serving after unusual raw HTTP request targets", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "http-liveness", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "http-liveness");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    const events = captureJsonEvents(child);
    try {
      const started = await events.next((event) => event.ok && event.data?.event === "started");
      for (const [target, status] of [["//", 404], ["///x", 404], ["/%", 400], ["http://evil.example/x", 404]]) {
        const response = await rawHttpResponse(started.data.url, target);
        assert.match(response, new RegExp(`^HTTP/1\\.1 ${status}\\b`), `${target}: ${response}`);
        assert.equal((await fetch(started.data.url)).status, 200, `runtime stopped after ${target}`);
        assert.equal(child.exitCode, null, `runtime exited after ${target}`);
      }
      assert.equal(events.events.some((event) => /unhandledRejection|uncaughtException|fatal-runtime|restart/i.test(JSON.stringify(event))), false);
      assert.doesNotMatch(events.stderr, /unhandledRejection|uncaughtException|fatal-runtime|Invalid URL/i);
    } finally {
      events.dispose();
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
  });
});


test("sporades dev bundles and serves a scaffolded React todo capsule", async () => {
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

      assert.equal(started.ok, true);
      assert.equal(started.data.event, "started");
      assert.equal(started.error, null);
      assert.equal(typeof started.data.port, "number");
      assert.match(started.data.url, /^http:\/\/localhost:\d+$/);

      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.match(serverBundle, /todo-island/);
      assert.match(clientBundle, /Sporades Todos/);
      assert.doesNotMatch(clientBundle, /Original client source/);
      assert.doesNotMatch(clientBundle, /import .* from "react"/);
      assert.match(clientBundle, /createRoot/);

      const rootResponse = await fetch(started.data.url);
      assert.equal(rootResponse.status, 200);
      assert.match(await rootResponse.text(), /<script type="module" src="\/client\.js"><\/script>/);

      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      const servedClientBundle = await clientResponse.text();
      assert.match(servedClientBundle, /Sporades Todos/);
      assert.doesNotMatch(servedClientBundle, /Original client source/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev reports service activation failures without publishing candidate client output", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "service-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "service-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.services = { database: { kind: "database", engine: "libsql" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir);
    await writeFile(docker.statusPath, "healthy\n");

    await withFakeLibsqlService(path.join(dir, "service.db"), async ({ url: serviceUrl }) => {
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: {
          ...docker.env,
          FAKE_DOCKER_STATUS_FILE: docker.statusPath,
          FAKE_DOCKER_SERVICE_PORT: new URL(serviceUrl).port,
        },
      });
      try {
        await waitForJsonLine(child);
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        const before = await (await fetch(`${started.data.url}/client.js`)).text();
        await writeFile(docker.statusPath, "unhealthy\n");
        const clientPath = path.join(projectDir, "client", "index.tsx");
        const source = await readFile(clientPath, "utf8");
        await writeFile(clientPath, source.replace("Blank Sporades Capsule", "Premature Service Capsule"));

        const failed = await waitForJsonEvent(child, (event) => !event.ok && event.data?.event === "rebuild");
        assert.deepEqual(failed.data.build, { phase: "services", framework: "react", toolchain: "esbuild" });
        assert.equal(failed.error.message, "Capsule database service did not become ready.");
        assert.equal(await (await fetch(`${started.data.url}/client.js`)).text(), before);
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("sporades dev preserves unusual request targets across HTTP and WebSocket admission", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "request-targets", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "request-targets");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      assert.match(session.inspectionToken, /^[a-f0-9]{64}$/);
      for (const [target, method, expectedStatus] of [["//", "GET", 404], ["//unrelated.example/", "GET", 404], ["///", "GET", 404], ["/%", "GET", 400], ["ftp://example.test/admin", "GET", 400], ["http://user:secret@example.test/admin", "GET", 400], ["http://example.test:bad/admin", "GET", 400], ["/?query=%", "GET", 200], ["http://unrelated.example\\path", "GET", 400], ["http://unrelated.example/", "GET", 200], ["*", "OPTIONS", 404], ["*", "GET", 400]]) {
        const response = await rawHttpResponse(started.data.url, target, { method, headers: { host: "wrong.example" } });
        assert.match(response, new RegExp(`^HTTP/1\\.1 ${expectedStatus} `), `${target}: ${response}`);
        if (["/%", "ftp://example.test/admin", "http://user:secret@example.test/admin", "http://example.test:bad/admin"].includes(target)) {
          assert.match(response, /\r\nBad request\r\n/);
          assert.doesNotMatch(response, /\r\ncache-control: no-store\r\n/i);
        }
        if (target === "*") assert.match(response, /x-content-type-options: nosniff/i, response);
        assert.equal((await fetch(`${started.data.url}/__sporades/health/runtime`, { headers: { "x-sporades-host-probe": session.inspectionToken } })).status, 200);
      }
      assert.equal(await rawHttpResponse(started.data.url, "unrelated.example:443", { method: "CONNECT" }), "");
      assert.equal((await fetch(`${started.data.url}/__sporades/health/runtime`, { headers: { "x-sporades-host-probe": session.inspectionToken } })).status, 200);
      const page = await fetch(started.data.url, { headers: { "sec-fetch-dest": "document" } });
      const token = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(await page.text())?.[1];
      assert.ok(token);
      const rejectedUpgrade = await rawHttpResponse(started.data.url, `///__sporades/ws?connectionToken=${encodeURIComponent(token)}`, {
        headers: { connection: "Upgrade", upgrade: "websocket", origin: started.data.url, "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13" },
      });
      assert.doesNotMatch(rejectedUpgrade, /^HTTP\/1\.1 101 /, rejectedUpgrade);
      assert.equal((await fetch(`${started.data.url}/__sporades/health/runtime`, { headers: { "x-sporades-host-probe": session.inspectionToken } })).status, 200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("Vite rejects a symlinked project configuration before creating release output", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(
      ["create", "vite-config-symlink", "--framework", "react", "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vite-config-symlink");
    await installFakeReact(projectDir);
    const externalConfig = path.join(dir, "external-vite.config.mjs");
    await writeFile(externalConfig, "export default {};\n");
    await symlink(externalConfig, path.join(projectDir, "vite.config.mjs"));
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));

    await assert.rejects(createBundle(projectDir, config), (error) => {
      assert.equal(error.message, "Vite configuration must be a regular file inside the Capsule: vite.config.mjs.");
      assert.equal(error.phase, "client");
      assert.equal(error.framework, "react");
      assert.equal(error.toolchain, "vite");
      return true;
    });
    await assert.rejects(access(path.join(projectDir, ".sporades")), (error) => error.code === "ENOENT");
  });
});


test("Preact Vite preserves createHooks source compatibility and emits a Preact-only normalized tree", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(
      ["create", "preact-vite-build", "--template", "todo", "--framework", "preact", "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "preact-vite-build");
    await installFakePreact(projectDir);
    await writeFile(path.join(projectDir, ".env"), "VITE_PREACT_LEAK=preact-browser-secret\n");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "PREACT_SERVER_ONLY=preact-server-secret\n");
    await writeFile(path.join(projectDir, "vite.config.mjs"), 'export default { plugins: [{ name: "preact-vite-config-loaded" }] };\n');
    await writeFile(path.join(projectDir, "postcss.config.js"), 'throw new Error("preact-postcss-config-loaded");\n');
    const clientPath = path.join(projectDir, "client", "index.tsx");
    const clientSource = await readFile(clientPath, "utf8");
    assert.match(clientSource, /createHooks\(\{ useState, useEffect \}\)/);
    assert.match(clientSource, /from "preact"/);
    assert.match(clientSource, /from "preact\/hooks"/);
    assert.doesNotMatch(clientSource, /from "react|react-dom/);
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    const bundle = await createBundle(projectDir, config, { publishLegacy: false });
    try {
      const files = await snapshotProjectTree(bundle.staticFiles.publicDir);
      const paths = Object.keys(files).filter((file) => !file.endsWith("/"));
      assert(paths.includes("index.html"), JSON.stringify(paths));
      assert(paths.some((file) => /^assets\/index-[^/]+\.js$/.test(file)));
      assert(paths.some((file) => /^assets\/index-[^/]+\.css$/.test(file)));
      assert(paths.some((file) => /^assets\/vite-scaffold-[^/]+\.js$/.test(file)));
      assert(paths.some((file) => file.endsWith(".js.map")));
      assert.equal(paths.includes("client.js"), false);
      const output = (await Promise.all(paths.map((file) => readFile(path.join(bundle.staticFiles.publicDir, file), "utf8")))).join("\n");
      assert.doesNotMatch(output, /preact-(?:browser|server)-secret|preact-(?:vite|postcss)-config-loaded/);
      assert.doesNotMatch(output, /node_modules\/react(?:-dom)?\/|from ["']react(?:-dom)?/);
      assert.doesNotMatch(output, /\/@vite\/client|react-refresh|vite\/hmr/i);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});


for (const { template, marker } of [
  { template: "guestbook", marker: "Leave a note from this island" },
  { template: "photo-library", marker: "Photo Library" },
  { template: "campfire", marker: "Campfire" },
]) test(`Vue Vite compiles the complete ${template} exemplar without leaking Server env`, async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", `vue-${template}-build`, "--template", template, "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, `vue-${template}-build`);
    await installVue(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), `${template === "photo-library" ? "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n" : ""}VUE_EXEMPLAR_SECRET=server-only-vue-exemplar\n`);
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    const bundle = await createBundle(projectDir, config, { publishLegacy: false });
    try {
      const files = Object.keys(await snapshotProjectTree(bundle.staticFiles.publicDir)).filter((file) => !file.endsWith("/"));
      assert(files.some((file) => /^assets\/index-[^/]+\.js$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => /^assets\/index-[^/]+\.css$/.test(file)), JSON.stringify(files));
      assert.equal(files.some((file) => file.endsWith(".tsx")), false);
      const output = (await Promise.all(files.map((file) => readFile(path.join(bundle.staticFiles.publicDir, file), "utf8")))).join("\n");
      assert.match(output, new RegExp(marker));
      assert.doesNotMatch(output, /server-only-vue-exemplar|VUE_EXEMPLAR_SECRET|\/@vite\/client|react-refresh|vite\/hmr/i);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});


test("Vue Photo Library enforces private auth uploads and explicit publication lifecycle", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "vue-photo-behavior", "--template", "photo-library", "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vue-photo-behavior");
    await installVue(projectDir);
    const calls = [];
    const photo = { id: "photo-private", title: "Secret crown", status: "private", fileId: "file-private", imageUrl: "", publicUrlId: "", isPublic: false };
    const mutations = Object.fromEntries(["recordPhoto", "updatePhotoIsPublic", "updatePhotoImageUrl", "updatePhotoPublicUrlId"].map((name) => [name, {
      loading: false, error: null, async run(...args) {
        calls.push([name, ...args]);
        const livePhoto = globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__.queries.personalPhotos.data.find((candidate) => candidate.id === args[0]);
        if (name === "updatePhotoIsPublic") livePhoto.isPublic = args[1];
        if (name === "updatePhotoPublicUrlId") livePhoto.publicUrlId = args[1];
        if (name === "updatePhotoImageUrl") livePhoto.imageUrl = args[1];
        return { data: null, error: null };
      },
    }]));
    const harness = await mountVueTemplate(projectDir, {
      session: sessionState(),
      queries: { publicPhotos: { loading: false, data: [], error: null }, personalPhotos: { loading: false, data: [photo], error: null } },
      mutations,
      auth: authStub(),
      files: {
        async upload(file) { calls.push(["upload", file.name]); return { id: `file-${file.name}`, name: file.name, type: file.type, size: file.size }; },
        async publicUrl(fileId) { calls.push(["publicUrl", fileId]); return { id: `url-${fileId}`, url: `https://files.example/${fileId}` }; },
        async revokePublicUrl(id) { calls.push(["revokePublicUrl", id]); return { data: null, error: null }; },
      },
      journey: {}, preferences: {},
    });
    try {
      const fileInput = harness.find((node) => node.type === "input" && node.props.type === "file");
      const form = harness.find((node) => node.type === "form");
      await harness.trigger(fileInput, "change", { files: [{ name: "guest.png", type: "image/png", size: 10 }] });
      await harness.trigger(form, "submit");
      assert(calls.some(([name]) => name === "publicUrl"), "anonymous upload receives a public URL");

      calls.length = 0;
      harness.state.session.auth = { userId: "google-user", provider: "google", displayName: "Aramis", isGuest: false };
      await harness.settle();
      await harness.trigger(fileInput, "change", { files: [{ name: "private.png", type: "image/png", size: 11 }] });
      await harness.trigger(form, "submit");
      assert(calls.some(([name]) => name === "upload"));
      assert.equal(calls.some(([name]) => name === "publicUrl"), false, "authenticated upload stays private by default");
      assert.match(harness.text(), /Photo saved privately/);
      assert.match(harness.text(), /My library.*Secret crown/s);

      calls.length = 0;
      await harness.trigger(harness.find((node) => node.type === "button" && nodeText(node) === "Make public"), "click");
      assert.deepEqual(calls.map(([name]) => name), ["publicUrl", "updatePhotoImageUrl", "updatePhotoPublicUrlId", "updatePhotoIsPublic"]);
      await harness.settle();
      calls.length = 0;
      await harness.trigger(harness.find((node) => node.type === "button" && nodeText(node) === "Make private"), "click");
      assert.deepEqual(calls.map(([name]) => name), ["revokePublicUrl", "updatePhotoIsPublic", "updatePhotoImageUrl", "updatePhotoPublicUrlId"]);
      assert.doesNotMatch(harness.text(), /dummy-secret|GOOGLE_CLIENT_SECRET|credential/i);
    } finally { harness.unmount(); }
  });
});


test("Dev watches prerender modules and transitive code while retaining the last successful static shell", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "prerender-dev", "--framework", "react", "--toolchain", "vite", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, 'prerender-dev');
    await installFakeReact(projectDir);
    const config = await installPrerenderFixture(projectDir);
    config.dev.port = 0;
    await writeFile(path.join(projectDir, 'sporades.json'), JSON.stringify(config));
    const child = startCli(['dev', '--json'], {cwd:projectDir});
    const events = captureJsonEvents(child);
    let socket;
    try {
      const started = await events.next((event) => event.data?.event === 'started');
      const page = () => fetch(started.data.url).then((response) => response.text());
      assert.match(await page(), /Useful before JavaScript/);
      socket = await openSocket(started.data.url); await subscribeDevRefresh(socket);
      const refresh = readSocketMessage(socket);
      await writeFile(path.join(projectDir, 'render/copy.ts'), 'export const copy = "Transitive edit";');
      const rebuilt = await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.equal(rebuilt.data.build.phase, 'client');
      assert.equal((await refresh).type, 'refresh');
      assert.match(await page(), /Transitive edit/);
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'export default () => "<main>Renderer edit</main>";');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Renderer edit/);
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'export default () => { throw new Error("failed prerender edit"); };');
      const failed = await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      assert.match(failed.error.message, /failed prerender edit/);
      assert.match(await page(), /Renderer edit/);
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'import { copy } from "./new-copy.ts"; export default () => copy;');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      await writeFile(path.join(projectDir, 'render/new-copy.ts'), 'export const copy = "Recovered new dependency";');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      const final = await page();
      assert.match(final, /Recovered new dependency/);
      assert.doesNotMatch(final, /(?:server|project)-env-prerender-must-not-ship/);
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'export default () => { const target = "./computed.cjs"; return require(target); };');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      assert.match(await page(), /Recovered new dependency/);
      await writeFile(path.join(projectDir, 'render/computed.cjs'), 'throw new Error("computed helper failed");');
      const helperFailed = await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      assert.match(helperFailed.error.message, /computed helper failed/);
      assert.match(await page(), /Recovered new dependency/);
      await writeFile(path.join(projectDir, 'render/computed.cjs'), 'module.exports = "Recovered computed helper";');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Recovered computed helper/);
      for (const packageName of ['new-render-copy', '@example/new-render-copy']) {
        await writeFile(path.join(projectDir, 'render/landing.ts'), `import copy from ${JSON.stringify(packageName)}; export default () => copy;`);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
        const packageDir = path.join(projectDir, 'node_modules', packageName);
        await mkdir(packageDir, {recursive:true});
        await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({name:packageName, main:'index.js'}));
        await writeFile(path.join(packageDir, 'index.js'), `module.exports = ${JSON.stringify(`Installed ${packageName}`)};`);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.ok((await page()).includes(`Installed ${packageName}`));
      }
      const customResolution = path.join(dir, 'custom-resolution');
      for (const [specifier, target] of [
        ['custom-copy', path.join(customResolution, 'node_modules/custom-copy/index.js')],
        ['./relative-copy', path.join(customResolution, 'relative-copy.js')],
      ]) {
        await writeFile(path.join(projectDir, 'render/landing.ts'), `export default () => {const target = ${JSON.stringify(specifier)}; return require(require.resolve(target, {paths:[${JSON.stringify(customResolution)}]}));};`);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
        await mkdir(path.dirname(target), {recursive:true});
        await writeFile(target, 'module.exports = "Recovered custom resolution";');
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Recovered custom resolution/);
        await writeFile(target, 'module.exports = "Updated custom resolution";');
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Updated custom resolution/);
      }
      const linkedPackage = path.join(dir, 'linked-copy');
      await mkdir(path.join(linkedPackage, 'node_modules'), {recursive:true});
      await writeFile(path.join(linkedPackage, 'package.json'), '{"name":"linked-copy","main":"index.js"}');
      await writeFile(path.join(linkedPackage, 'index.js'), 'module.exports = "Linked package";');
      await symlink(linkedPackage, path.join(linkedPackage, 'cycle'));
      await symlink(linkedPackage, path.join(linkedPackage, 'node_modules/linked-copy'));
      await symlink(linkedPackage, path.join(projectDir, 'node_modules/linked-copy'));
      const linkedHelper = path.join(dir, 'linked-helper');
      await mkdir(linkedHelper);
      await writeFile(path.join(linkedHelper, 'copy.js'), 'module.exports = "Linked package";');
      await symlink(linkedHelper, path.join(linkedPackage, 'helper'));
      await writeFile(path.join(linkedPackage, 'index.js'), 'module.exports = require("./helper/copy.js");');
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'import copy from "linked-copy"; export default () => copy;');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Linked package/);
      const linkedRebuildCount = events.events.filter(event => event.data?.event === 'rebuild').length;
      await writeFile(path.join(linkedPackage, 'node_modules/unrelated.txt'), 'not an imported dependency');
      await new Promise(resolve => setTimeout(resolve, 800));
      assert.equal(events.events.filter(event => event.data?.event === 'rebuild').length, linkedRebuildCount, 'unrelated nested dependencies are not recursively polled');
      await writeFile(path.join(linkedHelper, 'copy.js'), 'module.exports = "Updated linked package";');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Updated linked package/);
      await writeFile(path.join(linkedHelper, 'alternative.json'), '"Initial linked alternative"');
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'import copy from "linked-copy/helper/alternative"; export default () => copy;');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Initial linked alternative/);
      await writeFile(path.join(linkedHelper, 'alternative.js'), 'module.exports = "Preferred linked alternative";');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Preferred linked alternative/);
      for (const computed of [false, true]) {
        const stem = computed ? 'main-computed' : 'main-static';
        await writeFile(path.join(linkedHelper, `${stem}.json`), '"Initial linked main"');
        await writeFile(path.join(linkedPackage, 'package.json'), JSON.stringify({name:'linked-copy', main:`helper/${stem}`}));
        await writeFile(path.join(projectDir, 'render/landing.ts'), computed
          ? 'export default () => {const name = "linked-copy"; return require(name);};'
          : 'import copy from "linked-copy"; export default () => copy;');
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Initial linked main/);
        await writeFile(path.join(linkedHelper, `${stem}.js`), 'module.exports = "Preferred linked main";');
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Preferred linked main/);
      }
      const absolute = path.join(dir, 'late-absolute.cjs');
      const manifestPath = path.join(projectDir, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      for (const [alias, target, renderer, resolvedTarget = target] of [
        ['#copy', './render/alias-copy.ts', 'import copy from "#copy"; export default () => copy;'],
        ['#typed-copy', './render/alias-typed.js', 'import copy from "#typed-copy"; export default () => copy;', './render/alias-typed.ts'],
        ['#computed/*', './render/*.cjs', 'export default () => { const name = "#computed/alias-computed"; return require(name); };'],
      ]) {
        manifest.imports = {[alias]:{node:target, default:target}};
        await writeFile(manifestPath, JSON.stringify(manifest));
        await writeFile(path.join(projectDir, 'render/landing.ts'), renderer);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
        const targetFile = resolvedTarget.replace('*', 'alias-computed');
        await writeFile(path.join(projectDir, targetFile), targetFile.endsWith('.ts') ? 'export default "Recovered package alias";' : 'module.exports = "Recovered computed alias";');
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Recovered (?:package|computed) alias/);
        if (alias === '#copy') {
          await writeFile(path.join(projectDir, 'render/repointed-alias.ts'), 'export default "Repointed manifest alias";');
          manifest.imports = {'#copy':'./render/repointed-alias.ts'};
          await writeFile(manifestPath, JSON.stringify(manifest));
          await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
          assert.match(await page(), /Repointed manifest alias/);
        }
      }
      for (const computed of [false, true]) {
        const stem = computed ? 'self-computed' : 'self-static';
        const target = `./render/${stem}.${computed ? 'cjs' : 'ts'}`;
        manifest.exports = {[`./${stem}`]:{node:target, default:target}};
        await writeFile(manifestPath, JSON.stringify(manifest));
        const specifier = `${manifest.name}/${stem}`;
        await writeFile(path.join(projectDir, 'render/landing.ts'), computed
          ? `export default () => {const target = ${JSON.stringify(specifier)}; return require(target);};`
          : `import copy from ${JSON.stringify(specifier)}; export default () => copy;`);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
        await writeFile(path.join(projectDir, target), computed ? 'module.exports = "Recovered self export";' : 'export default "Recovered self export";');
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Recovered self export/);
      }
      for (const packageName of ['computed-export-copy', '@example/computed-export-copy', 'static-export-copy']) {
        const renderer = packageName.startsWith('static') ? `import copy from ${JSON.stringify(`${packageName}/feature`)}; export default () => copy;` : `export default () => { const target = ${JSON.stringify(`${packageName}/feature`)}; return require(target); };`;
        await writeFile(path.join(projectDir, 'render/landing.ts'), renderer);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
        const packageDir = path.join(projectDir, 'node_modules', packageName);
        await mkdir(path.join(packageDir, 'dist'), {recursive:true});
        await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({name:packageName, exports:{'./feature':'./dist/feature.js'}}));
        await writeFile(path.join(packageDir, 'dist/feature.js'), `module.exports = ${JSON.stringify(`Installed computed ${packageName}`)};`);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.ok((await page()).includes(`Installed computed ${packageName}`));
        await writeFile(path.join(packageDir, 'dist/next.js'), `module.exports = ${JSON.stringify(`Repointed ${packageName}`)};`);
        await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({name:packageName, exports:{'./feature':'./dist/next.js'}}));
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.ok((await page()).includes(`Repointed ${packageName}`));
      }
      const localPackage = path.join(projectDir, 'render/local-package');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');
      const tsconfig = {compilerOptions:{paths:{'@render/*':['./render/*']}}};
      await writeFile(tsconfigPath, JSON.stringify(tsconfig));
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'import copy from "@render/mapped-copy"; export default () => copy;');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      await writeFile(path.join(projectDir, 'render/mapped-copy.ts'), 'export default "Recovered tsconfig mapping";');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Recovered tsconfig mapping/);
      await writeFile(path.join(projectDir, 'render/mapped-next.ts'), 'export default "Retargeted tsconfig mapping";');
      tsconfig.compilerOptions.paths = {'@render/*':['./render/mapped-next.ts']};
      await writeFile(tsconfigPath, JSON.stringify(tsconfig));
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Retargeted tsconfig mapping/);
      await writeFile(tsconfigPath, JSON.stringify({compilerOptions:{baseUrl:'./render'}}));
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'import copy from "base-copy"; export default () => copy;');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      await writeFile(path.join(projectDir, 'render/base-copy.ts'), 'export default "Recovered base URL copy";');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Recovered base URL copy/);
      for (const kind of ['static', 'computed']) {
        const name = `shadowed-${kind}-copy`;
        const outer = path.join(projectDir, 'node_modules', name);
        await mkdir(outer, {recursive:true});
        await writeFile(path.join(outer, 'package.json'), JSON.stringify({name, main:'index.js'}));
        await writeFile(path.join(outer, 'index.js'), 'module.exports = "Outer package";');
        await writeFile(path.join(projectDir, 'render/landing.ts'), kind === 'static' ? `import copy from '${name}'; export default () => copy;` : `export default () => { const name = '${name}'; return require(name); };`);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Outer package/);
        const inner = path.join(projectDir, 'render/node_modules', name);
        await mkdir(inner, {recursive:true});
        await writeFile(path.join(inner, 'index.js'), 'module.exports = "Nearer manifestless package";');
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Nearer manifestless package/);
        await rm(path.join(inner, 'index.js'));
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Outer package/);
        await writeFile(path.join(inner, 'index.js'), 'module.exports = "Recreated nearer package";');
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Recreated nearer package/);
      }
      await mkdir(localPackage);
      await writeFile(path.join(localPackage, 'copy.js'), 'module.exports = "Local package boundary";');
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'import copy from "./local-package/copy.js"; export default () => copy;');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      await writeFile(path.join(localPackage, 'package.json'), '{"type":"commonjs"}');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Local package boundary/);
      await writeFile(path.join(localPackage, 'package.json'), '{"type":"module"}');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      assert.match(await page(), /Local package boundary/);
      await writeFile(path.join(localPackage, 'package.json'), '{"type":"commonjs"}');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      await writeFile(path.join(localPackage, 'package.json'), '{malformed');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      await writeFile(path.join(localPackage, 'package.json'), '{"type":"commonjs"}');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Local package boundary/);
      await writeFile(path.join(projectDir, 'render/landing.ts'), `import copy from ${JSON.stringify(absolute)}; export default () => copy;`);
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      await writeFile(absolute, 'module.exports = "Recovered absolute dependency";');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      assert.match(await page(), /Recovered absolute dependency/);
      const resolutionDir = path.join(projectDir, 'render/resolution');
      await mkdir(resolutionDir);
      await writeFile(path.join(resolutionDir, 'package.json'), '{"type":"commonjs"}');
      for (const computed of [false, true]) {
        const stem = computed ? 'resolution-computed' : 'resolution-static';
        const initial = path.join(resolutionDir, `${stem}.${computed ? 'json' : 'js'}`);
        const preferred = path.join(resolutionDir, `${stem}.${computed ? 'js' : 'ts'}`);
        await writeFile(initial, computed ? '"Initial resolution"' : 'module.exports = "Initial resolution";');
        await writeFile(path.join(projectDir, 'render/landing.ts'), computed
          ? `export default () => {const target = "./resolution/${stem}"; return require(target);};`
          : `import copy from "./resolution/${stem}"; export default () => copy;`);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Initial resolution/);
        await writeFile(preferred, computed ? 'module.exports = "Preferred resolution";' : 'export default "Preferred resolution";');
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Preferred resolution/);
        await rm(preferred);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Initial resolution/);
      }
      const settle = () => new Promise((resolve) => setTimeout(resolve, 800));
      for (const computed of [false, true]) {
        const name = computed ? 'selected-computed' : 'selected-static';
        const selected = path.join(projectDir, 'node_modules', name);
        await mkdir(selected, {recursive:true});
        await writeFile(path.join(selected, 'package.json'), JSON.stringify({name, type:'commonjs'}));
        await writeFile(path.join(selected, 'feature.json'), '"Initial package resolution"');
        await writeFile(path.join(projectDir, 'render/landing.ts'), computed
          ? `export default () => {const target = "${name}/feature"; return require(target);};`
          : `import copy from "${name}/feature"; export default () => copy;`);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Initial package resolution/);
        const preferred = path.join(selected, 'feature.js');
        await writeFile(preferred, 'module.exports = "Preferred package resolution";');
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Preferred package resolution/);
        await rm(preferred);
        await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
        assert.match(await page(), /Initial package resolution/);
      }
      const rebuildCount = () => events.events.filter((event) => event.data?.event === 'rebuild').length;
      await settle();
      await writeFile(path.join(projectDir, 'render/existing.cjs'), 'module.exports = "One rebuild";');
      const beforeExisting = rebuildCount();
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'import copy from "./existing.cjs"; export default () => copy;');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'success');
      await settle();
      assert.equal(rebuildCount(), beforeExisting + 1, 'discovering an unchanged dependency does not trigger another rebuild');
      const beforeMissing = rebuildCount();
      await writeFile(path.join(projectDir, 'render/landing.ts'), 'import copy from "./still-missing.cjs"; export default () => copy;');
      await events.next((event) => event.data?.event === 'rebuild' && event.data.status === 'failed');
      await settle();
      assert.equal(rebuildCount(), beforeMissing + 1, 'new missing candidates do not repeat the failed build');
    } catch (error) {
      error.message += `\nCaptured events: ${JSON.stringify(events.events)}`;
      throw error;
    } finally {
      socket?.close();
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM'); await exited;
    }
  });
});


test("sporades dev reports public candidate failures without changing the active tree", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "public-failure-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "public-failure-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      const before = await (await fetch(`${started.data.url}/client.js`)).text();
      const treesDir = path.join(projectDir, ".sporades", "build", ".public-trees");
      const savedTreesDir = `${treesDir}.saved`;
      await rename(treesDir, savedTreesDir);
      await writeFile(treesDir, "blocks public candidate creation\n");

      const clientPath = path.join(projectDir, "client", "index.tsx");
      const source = await readFile(clientPath, "utf8");
      await writeFile(clientPath, source.replace("Blank Sporades Capsule", "Invalid Public Candidate"));
      const failed = await waitForJsonEvent(child, (event) => !event.ok && event.data.event === "rebuild");
      assert.deepEqual(failed.data.build, { phase: "public", framework: "react", toolchain: "esbuild" });
      assert.equal(await (await fetch(`${started.data.url}/client.js`)).text(), before);

      await rm(treesDir);
      await rename(savedTreesDir, treesDir);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev keeps the old Runtime active when service-env state cannot be prepared", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "env-state-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "env-state-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      const beforeClient = await (await fetch(`${started.data.url}/client.js`)).text();
      assert.equal((await fetch(`${started.data.url}/version`)).status, 404);
      const legacyServerPath = path.join(projectDir, ".sporades", "build", "server.mjs");
      const legacyClientPath = path.join(projectDir, ".sporades", "build", "client.js");
      const legacyServerBefore = await readFile(legacyServerPath, "utf8");
      const legacyClientBefore = await readFile(legacyClientPath, "utf8");

      // Observe before triggering writes: the watcher can report failure while a write yields.
      const failedEvent = waitForJsonEvent(child, (event) => !event.ok && event.data.event === "rebuild");
      const envStatePath = path.join(projectDir, ".sporades", "dev-database-env.json");
      await rm(envStatePath, { force: true });
      await mkdir(envStatePath);
      const serverPath = path.join(projectDir, "server", "index.ts");
      const serverSource = await readFile(serverPath, "utf8");
      await writeFile(
        serverPath,
        serverSource
          .replace('import { capsule } from "sporades/server";', 'import { capsule, endpoint } from "sporades/server";')
          .replace("  schema: {},", '  schema: {},\n  endpoints: [endpoint({ method: "GET", path: "/version" }, () => ({ version: "new" }))],'),
      );
      const clientPath = path.join(projectDir, "client", "index.tsx");
      const clientSource = await readFile(clientPath, "utf8");
      await writeFile(clientPath, clientSource.replace("Blank Sporades Capsule", "Premature Env State Capsule"));

      const failed = await failedEvent;
      assert.deepEqual(failed.data.build, { phase: "runtime", framework: "react", toolchain: "esbuild" });
      assert.equal((await fetch(`${started.data.url}/version`)).status, 404);
      assert.equal(await (await fetch(`${started.data.url}/client.js`)).text(), beforeClient);
      assert.equal(await readFile(legacyServerPath, "utf8"), legacyServerBefore);
      assert.equal(await readFile(legacyClientPath, "utf8"), legacyClientBefore);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("candidate publication can preserve a legacy Container server bundle", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "legacy-publication", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "legacy-publication");
    await installFakeReact(projectDir);
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    await createBundle(projectDir, config);
    const serverPath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const originalServer = await readFile(serverPath);
    const clientPath = path.join(projectDir, "client", "index.tsx");
    await writeFile(clientPath, (await readFile(clientPath, "utf8")).replace("Blank Sporades Capsule", "New Candidate Capsule"));
    const candidate = await createBundle(projectDir, config, { publishLegacy: false });
    try {
      assert.equal(typeof candidate.serverBundle, "string");
      const rollback = await candidate.publishLegacy({ preserveServerBundle: true });
      assert.deepEqual(await readFile(serverPath), originalServer);
      assert.match(await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8"), /New Candidate Capsule/);
      await rollback();
      assert.deepEqual(await readFile(serverPath), originalServer);
    } finally {
      await candidate.releasePublicTreeLease();
      await discardPublicTree(candidate.staticFiles.publicTree).catch(() => {});
    }
  });
});


test("Dev rejects a symlinked action root without touching its target", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "unsafe-action-root", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "unsafe-action-root");
    await installFakeReact(projectDir);
    const buildDir = path.join(projectDir, ".sporades", "build");
    await mkdir(buildDir, { recursive: true });
    const outside = path.join(dir, "outside-action-root");
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel"), "untouched");
    await symlink(outside, path.join(buildDir, ".dev-actions"));
    const failed = await runCli(["dev", "--json"], { cwd: projectDir });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stdout + failed.stderr, /Invalid Dev action Bundle directory/);
    assert.deepEqual(await readdir(outside), ["sentinel"]);
    assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "untouched");
  });
});


test("sporades auth as refuses servers without local identity simulation support", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "auth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "auth-island");

    const server = createServer((request, response) => {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const result = await runCli(
        ["auth", "as", "email", "--email", "mira@example.com", "--port", String(server.address().port), "--json"],
        { cwd: projectDir },
      );
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Dev session does not support local identity simulation.",
          hint: "Start a current `sporades dev` session for this project, then retry `sporades auth as email`.",
        },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});


for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) test(`sporades dev preserves last-good Inferno esbuild ${template} output and recovers`, async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createInfernoTemplate(dir, `inferno-dev-${template}`, template, { omitToolchain: template === "blank" });
    if (template === "photo-library") await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8")); config.dev.port = 0; await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child); assert.equal(started.ok, true, JSON.stringify(started));
      const clientPath = path.join(projectDir, "client", "index.tsx");
      const original = await readFile(clientPath, "utf8");
      const label = { blank: "Blank Sporades Capsule", todo: "Sporades Todos", guestbook: "Leave a note from this island.", "photo-library": "Photo Library", campfire: "Campfire" }[template];
      await writeFile(clientPath, original.replace(label, `Rebuilt Inferno ${template}`));
      const rebuilt = await waitForJsonEvent(child, (event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(rebuilt.data.build, { phase: "client", framework: "inferno", toolchain: "esbuild" });
      const lastGood = await (await fetch(`${started.data.url}/client.js`)).text(); assert.match(lastGood, new RegExp(`Rebuilt Inferno ${template}`));
      await writeFile(clientPath, "export const = ;\n");
      const failed = await waitForJsonEvent(child, (event) => !event.ok && event.data?.event === "rebuild" && event.data.status === "failed");
      assert.deepEqual(failed.data.build, { phase: "client", framework: "inferno", toolchain: "esbuild" });
      assert.match(failed.error.message, /Client bundle failed/); assert(JSON.stringify(failed).length < 4096);
      assert.equal(await (await fetch(`${started.data.url}/client.js`)).text(), lastGood);
      await writeFile(clientPath, original.replace(label, `Recovered Inferno ${template}`));
      const recovered = await waitForJsonEvent(child, (event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(recovered.data.build, { phase: "client", framework: "inferno", toolchain: "esbuild" });
      assert.match(await (await fetch(`${started.data.url}/client.js`)).text(), new RegExp(`Recovered Inferno ${template}`));
    } finally { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
  });
});


test("sporades dev reloads client-only config without restarting the server Runtime", async () => {
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
    await installFakePreact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const authBefore = await readSocketMessage(socket);

      config.client.framework = "preact";
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

      const rebuilt = await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );
      assert.equal(rebuilt.error, null);

      assert.equal(socket.readyState, WebSocket.OPEN);
      socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
      const authAfter = await readSocketMessage(socket);
      assert.equal(authAfter.data.sessionToken, authBefore.data.sessionToken);
      assert.deepEqual(authAfter.data.auth, authBefore.data.auth);

      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      assert.match(await clientResponse.text(), /JSX import source: preact/);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("a capsule reload surface stays structured when it exceeds the log payload cap", async () => {
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
      assert.equal(started.ok, true, JSON.stringify(started.error));

      // Enough declarations that the surface overruns the 4096-byte default. Without a bound of
      // its own, `capLogEnvelope` would shed `jobs`, `mutations` and `tables` wholesale by
      // replacing each with the string "[TRUNCATED]".
      const padding = Array.from(
        { length: 160 },
        (_unused, index) => `    reload_surface_padding_table_${String(index).padStart(3, "0")}: table({ text: String() }),`,
      ).join("\n");
      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(serverPath, originalServer.replace("    todos: table({", `${padding}\n    todos: table({`));

      await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const reloaded = JSON.parse(logsResult.stdout).data.entries.find(
        (entry) => entry.event === "dev.capsule.reloaded",
      );
      assert.ok(reloaded, "expected a dev.capsule.reloaded log entry");

      // The shape is the contract: three arrays and three counts, whether or not anything was shed.
      for (const kind of ["tables", "mutations", "jobs"]) {
        assert.ok(Array.isArray(reloaded.data[kind]), `${kind} is ${JSON.stringify(reloaded.data[kind])}`);
        assert.equal(typeof reloaded.data.omitted[kind], "number");
      }
      assert.ok(reloaded.data.omitted.tables > 0, "expected the padded table list to report omissions");
      assert.equal(reloaded.data.tables.every((name) => typeof name === "string"), true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev applies additive field migrations without losing existing Capsule data", async () => {
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
    let socket;
    let migratedSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(socket)).data.sessionToken;

      socket.send(JSON.stringify({ id: "todos-before", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "add-before", type: "mutation.run", mutation: "addTodo", args: ["Keep me"] }));
      assert.equal((await readSocketMessage(socket)).type, "mutation.result");
      assert.deepEqual(
        (await readSocketMessage(socket)).data.map((todo) => todo.text),
        ["Keep me"],
      );

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      const pendingSchemaRebuild = Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
      await writeFile(
        serverPath,
        originalServer
          .replace(
            "done: Boolean().default(false),",
            `done: Boolean().default(false),
      priority: String().default("normal"),
      note: String(),`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `updateTodoNote: mutation((ctx, id: string, note: string) => {
      ctx.db.todos.update(id, { note });
    }),

    addTodo: mutation((ctx, text: string, done: boolean, priority: string, note: string) => {`,
          )
          .replace(
            "ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });",
            "ctx.db.todos.insert({ text, done, priority, note, ownerId: ctx.auth.userId });",
          ),
      );

      const [rebuilt] = await pendingSchemaRebuild;
      assert.equal(rebuilt.error, null);
      socket = null;

      migratedSocket = await openSocket(started.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "todos-after", type: "query.subscribe", query: "todos" }));
      const migratedRows = await readSocketMessage(migratedSocket);
      assert.equal(migratedRows.error, null);
      assert.equal(migratedRows.data.length, 1);
      assert.equal(migratedRows.data[0].text, "Keep me");
      assert.equal(migratedRows.data[0].done, false);
      assert.equal(migratedRows.data[0].priority, "normal");
      assert.equal(migratedRows.data[0].note, null);

      const insertedRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.length === 2,
      );
      migratedSocket.send(
        JSON.stringify({
          id: "add-after",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["New field works", false, "urgent", "first note"],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const insertedRows = await insertedRowsPromise;
      assert.equal(insertedRows.data[0].text, "New field works");
      assert.equal(insertedRows.data[0].priority, "urgent");
      assert.equal(insertedRows.data[0].note, "first note");

      const updatedRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.note === "edited note"),
      );
      migratedSocket.send(
        JSON.stringify({
          id: "update-note",
          type: "mutation.run",
          mutation: "updateTodoNote",
          args: [insertedRows.data[0].id, "edited note"],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const updatedTodo = (await updatedRowsPromise).data.find((todo) => todo.note === "edited note");
      assert.equal(updatedTodo.priority, "urgent");

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      const todosTable = tables.find((table) => table.name === "todos");
      assert.deepEqual(todosTable.columns, ["id", "createdAt", "updatedAt", "text", "done", "priority", "note", "ownerId"]);
      assert.equal(todosTable.rows.find((row) => row.text === "Keep me").priority, "normal");
      assert.equal(todosTable.rows.find((row) => row.text === "Keep me").note, null);
      assert.equal(todosTable.rows.find((row) => row.text === "New field works").note, "edited note");
      const systemRows = tables.find((table) => table.name === "sporades").rows;
      assert.equal(systemRows.find((row) => row.key === "schemaVersion")?.value, "v1:additive-fields");
      assert.match(systemRows.find((row) => row.key === "schema")?.value ?? "", /"priority"/);
    } finally {
      migratedSocket?.close();
      socket?.close();
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
  });
});


test("Microsoft full-page redirect completes through discovered endpoints and preserves anonymous state", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "microsoft-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "microsoft-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const configured = await runCli(
      ["auth", "set", "microsoft", "--client-id", "microsoft-client-id", "--client-secret", "microsoft-secret", "--tenant", "organizations", "--json"],
      { cwd: projectDir },
    );
    assert.equal(configured.code, 0, configured.stderr);
    assert.equal(JSON.parse(configured.stdout).data.providers.microsoft.runtimeAvailable, true);
    assert.doesNotMatch(configured.stdout, /microsoft-secret/);

    await withFakeMicrosoftServer(async (microsoft) => {
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: {
          SPORADES_MICROSOFT_DISCOVERY_URL: microsoft.discoveryUrl,
          SPORADES_OAUTH_TEST_ENDPOINTS: "1",
        },
      });
      let socket;
      try {
        const started = await waitForJsonLine(child);
        assert.equal(started.ok, true, JSON.stringify(started));
        socket = await openSocket(started.data.url);
        socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
        const before = await readSocketMessage(socket);
        const anonymousUserId = before.data.auth.userId;
        assert.deepEqual(before.data.providers.microsoft, {
          enabled: true,
          configured: true,
          runtimeAvailable: true,
        });
        socket.send(JSON.stringify({ id: "preference", type: "preferences.update", patch: { theme: "night" } }));
        assert.equal((await readSocketMessage(socket)).error, null);
        socket.send(JSON.stringify({
          id: "signin",
          type: "auth.signIn",
          provider: "microsoft",
          returnTo: `${started.data.url}/after`,
        }));
        const signIn = await readSocketMessage(socket);
        assert.equal(signIn.type, "auth.redirect");
        assert.doesNotMatch(signIn.data.url, /microsoft-secret|server-owned-secret-token/);
        const authorize = new URL(signIn.data.url);
        assert.equal(authorize.origin, microsoft.origin);
        assert.equal(authorize.pathname, "/authorize");
        assert.equal(authorize.searchParams.get("scope"), "openid profile email");
        assert.equal(authorize.searchParams.get("response_mode"), "query");
        assert.ok(authorize.searchParams.get("nonce"));
        assert.ok(authorize.searchParams.get("state"));
        assert.ok(authorize.searchParams.get("code_challenge"));

        const usedRealBrowser = await runRealBrowserRedirectTracer(authorize.toString());
        if (!usedRealBrowser) {
          const providerRedirect = await fetch(authorize, { redirect: "manual" });
          assert.equal(providerRedirect.status, 302);
          const callbackLocation = providerRedirect.headers.get("location");
          assert.match(callbackLocation, /\/__sporades\/auth\/microsoft\/callback\?/);
          const callback = await fetch(callbackLocation, { redirect: "manual" });
          assert.equal(callback.status, 302, await callback.text());
          assert.equal(callback.headers.get("location"), `${started.data.url}/after`);
        }
        const tokenRequest = microsoft.requests.find((request) => request.path === "/token");
        assert.deepEqual(tokenRequest.body, {
          code: "microsoft-code",
          client_id: "microsoft-client-id",
          client_secret: "microsoft-secret",
          redirect_uri: `${started.data.url}/__sporades/auth/microsoft/callback`,
          grant_type: "authorization_code",
          code_verifier: tokenRequest.body.code_verifier,
          scope: "openid profile email",
        });
        assert.ok(tokenRequest.body.code_verifier);
        socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
        const linked = await readSocketMessage(socket);
        assert.deepEqual(linked.data.auth, {
          userId: anonymousUserId,
          displayName: "Mira Microsoft",
          email: null,
          picture: null,
          isAuthenticated: true,
          isGuest: false,
          provider: "microsoft",
        });
        socket.send(JSON.stringify({ id: "preferences-after", type: "preferences.get" }));
        assert.deepEqual((await readSocketMessage(socket)).data.preferences, { theme: "night" });
      } finally {
        socket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("sporades logs returns captured ctx.log entries from the running dev session", async () => {
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
    await writeFile(path.join(projectDir, ".env.sporades.server"), "WEBHOOK_SECRET=env-secret-123\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "Todo Island",
  endpoints: {
    log: endpoint({ method: "POST", path: "/log" }, async (ctx) => {
      ctx.log.info("ctx.log is available", {
        password: "plaintext-password",
        token: "token-123",
        secretValue: ctx.env.WEBHOOK_SECRET,
        authorization: "Bearer auth-123",
        cookie: "session=abc",
        clientSecret: "client-secret-123",
        safe: "visible",
        nested: { apiToken: "nested-token-123" },
        large: "x".repeat(5000),
      });
      await Promise.resolve();
      ctx.log.info("ctx.log after await", { safe: "second" });
      return { status: 200, body: { ok: true, body: ctx.request.body } };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const ctxResponse = await fetch(`${started.data.url}/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawBodySecret: "do-not-log-request-body" }),
      });
      assert.equal(ctxResponse.status, 200);

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const logs = JSON.parse(logsResult.stdout);
      assert.equal(logs.ok, true);
      assert.equal(logs.error, null);
      assert.equal(logs.data.source, "sqlite");
      const ctxLog = logs.data.entries.find((entry) => entry.message === "ctx.log is available");
      const platformLog = logs.data.entries.find((entry) => entry.event === "dev.session.started");

      assert.equal(platformLog.category, "platform");
      assert.equal(platformLog.level, "info");
      assert.equal(platformLog.capsule.name, "todo-island");
      assert.equal(platformLog.release, null);
      assert.equal(ctxLog.category, "app");
      assert.equal(ctxLog.event, "ctx.log");
      assert.equal(ctxLog.level, "info");
      assert.equal(ctxLog.capsule.name, "todo-island");
      assert.equal(ctxLog.release, null);
      assert.equal(ctxLog.request.method, "POST");
      assert.equal(ctxLog.request.path, "/log");
      assert.equal(ctxLog.request.body, undefined);
      const afterAwaitLog = logs.data.entries.find((entry) => entry.message === "ctx.log after await");
      assert.equal(afterAwaitLog.request.id, ctxLog.request.id);
      assert.equal(afterAwaitLog.traceId, null);
      assert.equal(afterAwaitLog.spanId, null);
      assert.equal(ctxLog.data.safe, "visible");
      assert.equal(ctxLog.data.password, "[REDACTED]");
      assert.equal(ctxLog.data.token, "[REDACTED]");
      assert.equal(ctxLog.data.secretValue, "[REDACTED]");
      assert.equal(ctxLog.data.authorization, "[REDACTED]");
      assert.equal(ctxLog.data.cookie, "[REDACTED]");
      assert.equal(ctxLog.data.clientSecret, "[REDACTED]");
      assert.equal(ctxLog.data.nested.apiToken, "[REDACTED]");
      assert.equal(JSON.stringify(ctxLog).includes("do-not-log-request-body"), false);
      assert.equal(JSON.stringify(ctxLog).includes("env-secret-123"), false);
      assert.equal(ctxLog.truncated, true);

      const tailResult = await runCli(["logs", "tail", "--json"], { cwd: projectDir });
      assert.equal(tailResult.code, 0, tailResult.stderr);
      const tailEvents = tailResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(tailEvents.some((entry) => entry.event === "ctx.log" && entry.message === "ctx.log is available"), true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("dev inspection token rotates across dev session restarts", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "rotation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "rotation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const firstChild = startCli(["dev", "--json"], { cwd: projectDir });
    let firstToken;
    try {
      const firstStarted = await waitForJsonLine(firstChild);
      assert.equal(firstStarted.ok, true, JSON.stringify(firstStarted.error));
      const firstSession = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      firstToken = firstSession.inspectionToken;
      assert.match(firstToken, /^[a-f0-9]{64}$/);
    } finally {
      firstChild.kill("SIGTERM");
      await new Promise((resolve) => firstChild.once("exit", resolve));
    }

    const secondChild = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const secondStarted = await waitForJsonLine(secondChild);
      assert.equal(secondStarted.ok, true, JSON.stringify(secondStarted.error));
      const secondSession = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      assert.match(secondSession.inspectionToken, /^[a-f0-9]{64}$/);
      assert.notEqual(secondSession.inspectionToken, firstToken);

      const oldTokenResponse = await fetch(`${secondStarted.data.url}/__sporades/debug/db/list`, {
        headers: { "x-sporades-inspection-token": firstToken },
      });
      assert.equal(oldTokenResponse.status, 401);
      assert.equal((await oldTokenResponse.json()).data, null);

      const listResult = await runCli(["db", "list", "--json"], { cwd: projectDir });
      assert.equal(listResult.code, 0, listResult.stderr);
      assert.equal(JSON.parse(listResult.stdout).ok, true);
    } finally {
      secondChild.kill("SIGTERM");
      await new Promise((resolve) => secondChild.once("exit", resolve));
    }
  });
});


test("sporades dev runs query handlers from the bundled Capsule module", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "query-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "query-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "helpers.ts"),
      `export function decorateGreeting(name: string) {
  return \`Hello, \${name}!\`;
}
`,
    );
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, query } from "sporades/server";
import { decorateGreeting } from "./helpers";

const salutation = "Ada";

export default capsule({
  name: "query-island",

  queries: {
    greeting: query(() => ({
      text: decorateGreeting(salutation),
      parts: ["bundled", "query"],
    })),

    greetingFor: query((_ctx, name) => ({
      text: decorateGreeting(name),
      parts: ["argument-bearing", "query"],
    })),

    argumentBytes: query((_ctx, value) => ({ bytes: new TextEncoder().encode(value).byteLength })),

    echoArguments: query((_ctx, ...args) => args),

    broken: query(() => {
      throw new Error("Imported helper went sideways.");
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
      const socket = await openSocket(started.data.url);
      try {
        socket.send(JSON.stringify({ id: "greeting-1", type: "query.subscribe", query: "greeting" }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "greeting-1",
          type: "query.result",
          query: "greeting",
          data: {
            text: "Hello, Ada!",
            parts: ["bundled", "query"],
          },
          error: null,
        });

        socket.send(JSON.stringify({ id: "greeting-for-1", type: "query.subscribe", query: "greetingFor", args: ["Grace"] }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "greeting-for-1",
          type: "query.result",
          query: "greetingFor",
          data: {
            text: "Hello, Grace!",
            parts: ["argument-bearing", "query"],
          },
          error: null,
        });

        const multipleArgs = ["Grace", { items: Array.from({ length: 12 }, (_, i) => i) }, ["a", "b"]];
        socket.send(JSON.stringify({ id: "multiple-args", type: "query.subscribe", query: "echoArguments", args: multipleArgs }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "multiple-args", type: "query.result", query: "echoArguments", data: multipleArgs, error: null,
        });

        socket.send(JSON.stringify({ id: "invalid-known-1", type: "query.subscribe", query: "greetingFor", args: { name: "Grace" } }));
        const invalidKnown = await readSocketMessage(socket);
        socket.send(JSON.stringify({ id: "invalid-unknown-1", type: "query.subscribe", query: "doesNotExist", args: { name: "Grace" } }));
        const invalidUnknown = await readSocketMessage(socket);
        assert.deepEqual(invalidKnown, {
          id: "invalid-known-1",
          type: "query.result",
          query: "greetingFor",
          data: null,
          error: {
            message: "Invalid query arguments.",
            hint: "Use a JSON-compatible argument array no larger than 65536 UTF-8 bytes.",
          },
        });
        assert.deepEqual(invalidUnknown.error, invalidKnown.error, "invalid payloads do not reveal whether a query exists");

        socket.send(JSON.stringify({ id: "legacy-args-1", type: "query.subscribe", name: "greetingFor", args: ["Grace"] }));
        assert.deepEqual((await readSocketMessage(socket)).error, invalidKnown.error);

        const exact = "é".repeat((65536 - 4) / 2);
        socket.send(JSON.stringify({ id: "boundary-1", type: "query.subscribe", query: "argumentBytes", args: [exact] }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "boundary-1",
          type: "query.result",
          query: "argumentBytes",
          data: { bytes: Buffer.byteLength(exact, "utf8") },
          error: null,
        });

        const tooLarge = "é".repeat(Math.ceil((65537 - 4) / 2));
        socket.send(JSON.stringify({ id: "oversized-1", type: "query.subscribe", query: "greetingFor", args: [tooLarge] }));
        assert.deepEqual((await readSocketMessage(socket)).error, invalidKnown.error);

        socket.send(JSON.stringify({ id: "broken-1", type: "query.subscribe", query: "broken" }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "broken-1",
          type: "query.result",
          query: "broken",
          error: {
            message: "Imported helper went sideways.",
            hint: "Check the Capsule query handler and retry the query.",
          },
        });

        const stillServing = await fetch(started.data.url);
        assert.equal(stillServing.status, 200);
      } finally {
        socket.close();
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev awaits async Capsule query handlers before sending results", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "async-query-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "async-query-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, query } from "sporades/server";

export default capsule({
  name: "async-query-island",

  queries: {
    greeting: query(async () => {
      await Promise.resolve();
      return { text: "async query resolved" };
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

      socket.send(JSON.stringify({ id: "greeting", type: "query.subscribe", query: "greeting" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "greeting",
        type: "query.result",
        query: "greeting",
        data: { text: "async query resolved" },
        error: null,
      });
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("server app message handlers can target explicit users", async () => {
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
    whisper: message((ctx, data) => {
      return {
        delivered: ctx.messages.send({
          type: "whisper",
          data: { text: data.text },
          scope: { scope: "users", userIds: data.userIds },
        }),
      };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let senderSocket;
    let recipientSocket;
    let otherSocket;
    try {
      const started = await waitForJsonLine(child);
      senderSocket = await openSocket(started.data.url);
      recipientSocket = await openSocket(started.data.url);
      otherSocket = await openSocket(started.data.url);

      recipientSocket.send(JSON.stringify({ id: "recipient-auth", type: "auth.get" }));
      const recipientAuth = await readSocketMessage(recipientSocket);

      const recipientMessage = waitForSocketMessage(
        recipientSocket,
        (message) => message.type === "app.message" && message.message === "whisper",
      );
      const senderResult = waitForSocketMessage(
        senderSocket,
        (message) => message.id === "whisper" && message.type === "app.result",
      );

      senderSocket.send(
        JSON.stringify({
          id: "whisper",
          type: "app.send",
          message: "whisper",
          data: { text: "psst", userIds: [recipientAuth.data.auth.userId] },
        }),
      );

      assert.deepEqual(await recipientMessage, {
        type: "app.message",
        message: "whisper",
        data: { text: "psst" },
      });
      assert.deepEqual(await senderResult, {
        id: "whisper",
        type: "app.result",
        message: "whisper",
        data: { delivered: 1 },
        error: null,
      });

      otherSocket.send(JSON.stringify({ id: "other-auth", type: "auth.get" }));
      assert.equal((await readSocketMessage(otherSocket)).type, "auth.result");
    } finally {
      senderSocket?.close();
      recipientSocket?.close();
      otherSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("WebSocket auth.get creates a persistent anonymous session token", async () => {
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
    let socket;
    let expiredSocket;
    try {
      const started = await waitForJsonLine(child);
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
      const auth = await readSocketMessage(socket);

      assert.equal(auth.id, "auth-1");
      assert.equal(auth.type, "auth.result");
      assert.equal(auth.error, null);
      assert.equal(typeof auth.data.sessionToken, "string");
      assert.ok(auth.data.sessionToken.length > 20);
      assert.deepEqual(auth.data.auth, {
        userId: auth.data.auth.userId,
        displayName: "Anonymous",
        email: null,
        picture: null,
        isAuthenticated: false,
        isGuest: true,
        provider: "anonymous",
      });
      assert.equal(typeof auth.data.auth.userId, "string");

      const { DatabaseSync } = await import("node:sqlite");
      const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
      try {
        const storedSession = sqlite
          .prepare("SELECT token, userId, createdAt, expiresAt FROM sporades_auth_sessions WHERE token = ?")
          .get(auth.data.sessionToken);
        assert.equal(storedSession.token, auth.data.sessionToken);
        assert.equal(storedSession.userId, auth.data.auth.userId);
        assert.match(storedSession.createdAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.match(storedSession.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.ok(Date.parse(storedSession.expiresAt) > Date.now());

        sqlite
          .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?")
          .run("2000-01-01T00:00:00.000Z", auth.data.sessionToken);
      } finally {
        sqlite.close();
      }

      socket.close();
      socket = null;
      expiredSocket = await openSocket(started.data.url, auth.data.sessionToken);
      expiredSocket.send(JSON.stringify({ id: "auth-expired", type: "auth.get" }));
      const refreshedAuth = await readSocketMessage(expiredSocket);
      assert.equal(refreshedAuth.type, "auth.result");
      assert.notEqual(refreshedAuth.data.sessionToken, auth.data.sessionToken);
      assert.notEqual(refreshedAuth.data.auth.userId, auth.data.auth.userId);
      assert.equal(refreshedAuth.data.auth.provider, "anonymous");
    } finally {
      socket?.close();
      expiredSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("WebSocket todo data is isolated by anonymous session token across reconnects", async () => {
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
    let firstSocket;
    let secondSocket;
    let reloadedSocket;
    try {
      const started = await waitForJsonLine(child);
      firstSocket = await openSocket(started.data.url);

      firstSocket.send(JSON.stringify({ id: "first-auth", type: "auth.get" }));
      const firstAuth = await readSocketMessage(firstSocket);
      const firstToken = firstAuth.data.sessionToken;
      const firstUserId = firstAuth.data.auth.userId;

      firstSocket.send(JSON.stringify({ id: "first-query", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(firstSocket)).data, []);

      firstSocket.send(
        JSON.stringify({ id: "first-add", type: "mutation.run", mutation: "addTodo", args: ["First session"] }),
      );
      assert.equal((await readSocketMessage(firstSocket)).type, "mutation.result");
      const firstRefresh = await readSocketMessage(firstSocket);
      assert.deepEqual(
        firstRefresh.data.map((todo) => todo.text),
        ["First session"],
      );

      secondSocket = await openSocket(started.data.url);
      secondSocket.send(JSON.stringify({ id: "second-auth", type: "auth.get" }));
      const secondAuth = await readSocketMessage(secondSocket);
      assert.notEqual(secondAuth.data.sessionToken, firstToken);
      assert.notEqual(secondAuth.data.auth.userId, firstUserId);

      secondSocket.send(JSON.stringify({ id: "second-query", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(secondSocket)).data, []);

      secondSocket.send(
        JSON.stringify({ id: "second-add", type: "mutation.run", mutation: "addTodo", args: ["Second session"] }),
      );
      assert.equal((await readSocketMessage(secondSocket)).type, "mutation.result");
      const secondRefresh = await readSocketMessage(secondSocket);
      assert.deepEqual(
        secondRefresh.data.map((todo) => todo.text),
        ["Second session"],
      );
      firstSocket.close();
      firstSocket = null;
      reloadedSocket = await openSocket(started.data.url, firstToken);
      reloadedSocket.send(JSON.stringify({ id: "reloaded-auth", type: "auth.get" }));
      const reloadedAuth = await readSocketMessage(reloadedSocket);
      assert.equal(reloadedAuth.data.sessionToken, firstToken);
      assert.equal(reloadedAuth.data.auth.userId, firstUserId);

      reloadedSocket.send(JSON.stringify({ id: "reloaded-query", type: "query.subscribe", query: "todos" }));
      const reloadedTodos = await readSocketMessage(reloadedSocket);
      assert.deepEqual(
        reloadedTodos.data.map((todo) => todo.text),
        ["First session"],
      );
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      reloadedSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev persists private file uploads across dev session restarts", async () => {
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

    let child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth", type: "auth.get" }));
      const auth = await readSocketMessage(socket);

      socket.send(
        JSON.stringify({
          id: "upload-url",
          type: "file.uploadUrl",
          file: { name: "hello.txt", type: "text/plain", size: 11 },
        }),
      );
      const uploadUrl = await readSocketMessage(socket);
      assert.equal(uploadUrl.type, "file.uploadUrl.result");
      assert.equal(uploadUrl.error, null);
      assert.equal(uploadUrl.data.file.bucket, "default");
      assert.equal(uploadUrl.data.file.name, "hello.txt");
      assert.equal(uploadUrl.data.file.size, 11);
      assert.equal(uploadUrl.data.file.type, "text/plain");
      assert.equal(uploadUrl.data.file.path, "/default/hello.txt");
      assert.doesNotMatch(uploadUrl.data.file.path, /sessionToken/);
      assert.equal(uploadUrl.data.file.path.includes(auth.data.sessionToken), false);

      const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, started.data.url), {
        method: uploadUrl.data.method,
        body: "hello world",
      });
      assert.equal(uploadResponse.status, 200);
      const uploaded = await uploadResponse.json();
      assert.equal(uploaded.ok, true);
      assert.equal(uploaded.data.file.id, uploadUrl.data.file.id);

      socket.send(JSON.stringify({ id: "file-url", type: "file.url", fileId: uploaded.data.file.id }));
      const privateUrl = await readSocketMessage(socket);
      assert.equal(privateUrl.error, null);
      assert.match(privateUrl.data.url, /^\/__sporades\/files\/private\//);
      assert.doesNotMatch(privateUrl.data.url, /sessionToken/);
      assert.equal(privateUrl.data.url.includes(auth.data.sessionToken), false);
      assert.doesNotMatch(privateUrl.data.file.path, /sessionToken/);
      assert.equal(privateUrl.data.file.path.includes(auth.data.sessionToken), false);

      const queryTokenUrl = new URL(privateUrl.data.url, started.data.url);
      queryTokenUrl.searchParams.set("sessionToken", auth.data.sessionToken);
      const queryTokenResponse = await fetch(queryTokenUrl);
      assert.equal(queryTokenResponse.status, 404);

      const privateResponse = await fetch(new URL(privateUrl.data.url, started.data.url), {
        headers: { "x-sporades-session-token": auth.data.sessionToken },
      });
      assert.equal(privateResponse.status, 200);
      assert.equal(privateResponse.headers.get("content-type"), "text/plain");
      assert.equal(await privateResponse.text(), "hello world");

      socket.close();
      socket = null;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));

      child = startCli(["dev", "--json"], { cwd: projectDir });
      const restarted = await waitForJsonLine(child);
      const persistedResponse = await fetch(new URL(privateUrl.data.url, restarted.data.url), {
        headers: { "x-sporades-session-token": auth.data.sessionToken },
      });
      assert.equal(persistedResponse.status, 200);
      assert.equal(await persistedResponse.text(), "hello world");
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("installed Dev and generated Bundle preserve public availability probe parity", { timeout: 60_000 }, async () => {
  const scratchRoot = path.join(repoRoot, ".sporades");
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(path.join(scratchRoot, "probe-parity-"));
  const configDir = path.join(root, "config");
  const env = { SPORADES_CONFIG_DIR: configDir, COPYFILE_DISABLE: "1" };
  const received = [];
  const collector = createServer(async (request, response) => {
    let body = "";
    for await (const bytes of request) body += bytes;
    received.push({ path: request.url, body: JSON.parse(body) });
    response.writeHead(200).end("{}");
  });
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 4000);
    try { await exited; } finally { clearTimeout(deadline); }
  };
  try {
    await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${collector.address().port}`;
    const created = await runCli(["create", "probe-app", "--template", "blank", "--framework", "vanilla", "--no-install", "--no-git"], { cwd: root, env });
    assert.equal(created.code, 0, created.stderr);
    const project = path.join(root, "probe-app");
    const { tarballPath } = await packCandidateInto(root);
    const installed = await installPackedCandidate(project, tarballPath);
    const serverSource = `import { capsule, endpoint } from 'sporades/server'; export default capsule({ name: 'probe-parity', endpoints: { work: endpoint({ method: 'GET', path: '/work' }, async () => ({ status: 200, body: 'work' })) } });`;
    await writeFile(path.join(project, "server", "index.ts"), serverSource);
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "telemetry.json"), JSON.stringify({ schemaVersion: 1, profiles: { probe: { endpoint, tls: { mode: "loopback" }, metricsIntervalMs: 5000 } } }));
    const config = JSON.parse(await readFile(path.join(project, "sporades.json"), "utf8"));
    config.name = "probe-parity"; config.dev.port = 0; config.telemetry = { profile: "probe" };
    await writeFile(path.join(project, "sporades.json"), JSON.stringify(config));
    const { bundleServerCapsuleModule } = await import("../dist/bundle-pipeline.js");
    const { createServerBundleModuleSource } = await import("../dist/templates/server-bundle-module-graph.js");
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(project, "server", "index.ts") });
    const bundleDir = path.join(root, "bundle"); await mkdir(bundleDir);
    const bundlePath = path.join(bundleDir, "server.mjs");
    await writeFile(bundlePath, await createServerBundleModuleSource({ config: { name: "probe-parity", __sporadesTelemetry: { endpoint, tls: { mode: "loopback" }, serviceName: "probe-parity", metricsIntervalMs: 1000 } }, serverEnv: {}, serverSource, serverModuleSource,
      epilogue: 'process.stdout.write(JSON.stringify({ data: { event: "started", url: "http://127.0.0.1:" + server.address().port } }) + "\\n");',
    }));
    const nonce = "abcdef1234567890";
    const cases = [
      ["/__sporades/probe", { "x-sporades-probe-nonce": nonce }, 200],
      [`/__sporades/probe?nonce=${nonce}`, {}, 200],
      [`/__sporades/probe?nonce=${"f".repeat(64)}`, {}, 200],
      ["/__sporades/probe", {}, 404],
      ["/__sporades/probe?nonce=bad", {}, 404],
      [`/__sporades/probe?nonce=${"f".repeat(15)}`, {}, 404],
      [`/__sporades/probe?nonce=${"f".repeat(65)}`, {}, 404],
      ["/__sporades/probe", { "x-sporades-probe-nonce": "ABCDEF1234567890" }, 404],
      [`/__sporades/probe?nonce=${nonce}`, { "x-sporades-probe-nonce": "bad" }, 404],
      ["/__sporades/health/runtime", {}, 404],
      ["/__sporades/health/runtime", { "x-sporades-host-probe": "b".repeat(64) }, 404],
    ];
    for (const mode of ["Dev", "Bundle"]) {
      child = mode === "Dev" ? startCliFrom(installed.cliPath, ["dev", "--json"], { cwd: project, env })
        : spawn(process.execPath, [bundlePath], { cwd: bundleDir, env: { ...process.env, ...env, PORT: "0", SPORADES_RUNTIME_PROBE_TOKEN: "a".repeat(64) }, stdio: ["ignore", "pipe", "pipe"] });
      let startup = "";
      const captureStartup = chunk => { startup += chunk; };
      child.stdout.on("data", captureStartup);
      let started;
      try { started = await waitForJsonEvent(child, event => event.data?.event === "started"); }
      catch (error) {
        const diagnostics = startup.split("\n").flatMap(line => { try { const event = JSON.parse(line); return event.error?.message ? [event.error.message] : []; } catch { return []; } });
        throw new Error(`${mode} startup failed: ${diagnostics.join("; ")}`, { cause: error });
      } finally { child.stdout.off("data", captureStartup); }
      for (const [route, headers, status] of cases) {
        const response = await fetch(started.data.url + route, { headers });
        assert.equal(response.status, status, `${mode}: ${route}`);
        const body = await response.text();
        if (status === 200) {
          assert.equal(response.headers.get("cache-control"), "no-store");
          assert.equal(response.headers.get("pragma"), "no-cache");
          assert.equal(response.headers.get("vary"), "X-Sporades-Probe-Nonce");
          const expectedNonce = headers["x-sporades-probe-nonce"] ?? new URL(route, "http://localhost").searchParams.get("nonce");
          assert.equal(body, `sporades-application-probe-v1:${expectedNonce}\n`);
        } else assert.equal(body, "Not found", `${mode} denial stays opaque`);
      }
      assert.equal((await fetch(started.data.url + "/work")).status, 200);
      await stop();
    }
    const spans = received.flatMap(batch => batch.body.resourceSpans ?? []).flatMap(resource => resource.scopeSpans ?? []).flatMap(scope => scope.spans ?? []);
    assert.equal(spans.filter(span => span.name === "GET /work").length, 2, "both runtimes export ordinary application requests");
    assert(!spans.some(span => span.name === "GET /__unknown" || span.name.includes("/__sporades/probe")), "valid and invalid probe GETs never export request spans");
    const counts = received.flatMap(batch => batch.body.resourceMetrics ?? []).flatMap(resource => resource.scopeMetrics ?? []).flatMap(scope => scope.metrics ?? []).filter(metric => metric.name === "http.server.request.count");
    assert(counts.some(metric => metric.sum.dataPoints.some(point => point.attributes.some(attr => attr.key === "http.route" && attr.value.stringValue === "/work"))));
    assert(!counts.some(metric => metric.sum.dataPoints.some(point => point.attributes.some(attr => attr.key === "http.route" && ["/__unknown", "/__sporades/probe"].includes(attr.value.stringValue)))), "probe GETs never enter request metrics");
    assert(!JSON.stringify(received).includes(nonce), "probe nonces never enter exported telemetry");
  } finally {
    await stop(); collector.closeAllConnections(); await new Promise(resolve => collector.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
