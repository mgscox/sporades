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
import { fileURLToPath, pathToFileURL } from "node:url";
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
  TEAM_RUNTIME_TABLES,
  withTempDir,
  snapshotProjectTree,
  runCli,
  startCli,
  installFakeDocker,
  withFakeServiceEndpoint,
  waitForJsonLine,
  waitForJsonEvent,
  captureJsonEvents,
  waitForStdoutLine,
  installFakeReact,
  nodeText,
  sessionState,
  authStub,
  createVueCampfire,
  createSolidTemplate,
  campfireHarnessState,
  litSource,
  createLitTemplate,
  createInfernoTemplate,
  litCampfireState,
  installEnvProbeQuery,
  assertUnknownEnvQuery,
  openSocket,
  openSocketWithHeaders,
  readSocketMessage,
  captureSocketMessages,
  waitForSocketClose,
  closeSocketGracefully,
  waitForSocketMessage,
  TEST_PROCESS_EVENT_TIMEOUT_MS,
} from "./support/dev-fixture.js";



test("real Inferno Photo Library keeps authenticated uploads private and publishes explicitly", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createInfernoTemplate(dir, "inferno-photo-behavior", "photo-library");
    const calls = [], session = litSource({ auth: { userId: "athos", provider: "google", displayName: "Athos", isAuthenticated: true }, providers: {}, error: null, loading: false });
    const publicPhotos = litSource({ data: [], error: null, loading: false }), personalPhotos = litSource({ data: [], error: null, loading: false });
    const mutation = (name) => ({ async run(...args) { calls.push([name, ...args]); return { data: null, error: null }; } });
    const harness = await mountInfernoTemplate(projectDir, { auth: authStub(), session, queries: { publicPhotos, personalPhotos }, files: { async upload(file) { calls.push(["upload", file.name]); return { id: "f1" }; }, async publicUrl() { calls.push(["publicUrl"]); return { id: "u1", url: "/public/f1" }; }, async revokePublicUrl() {} }, mutations: { recordPhoto: mutation("recordPhoto"), updatePhotoIsPublic: mutation("updatePhotoIsPublic"), updatePhotoImageUrl: mutation("updatePhotoImageUrl"), updatePhotoPublicUrlId: mutation("updatePhotoPublicUrlId") } });
    try {
      const inputs = [...harness.window.document.querySelectorAll("input")];
      inputs[0].value = "Crown"; inputs[0].dispatchEvent(new harness.window.Event("input", { bubbles: true }));
      Object.defineProperty(inputs[1], "files", { configurable: true, value: [new harness.window.File(["photo"], "crown.png", { type: "image/png" })] }); inputs[1].dispatchEvent(new harness.window.Event("change", { bubbles: true }));
      harness.find("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true, cancelable: true })); await harness.settle();
      assert.deepEqual(calls.map(([name]) => name), ["upload", "recordPhoto"]); assert.match(harness.text(), /Photo saved privately/);
    } finally { await harness.unmount(); }
    assert.deepEqual([session.counts.stops, publicPhotos.counts.stops, personalPhotos.counts.stops], [1, 1, 1]);
  });
});


test("real Inferno Campfire prepares missing fixtures and switches Musketeer identity", async () => {
  await withTempDir(async dir=>{const projectDir=await createInfernoTemplate(dir,"inferno-campfire-fixtures","campfire");const calls=[],state=litCampfireState(calls);state.queries.profiles=litSource({data:[{key:"athos",userId:"athos",name:"Athos"}],error:null,loading:false});state.preferences.get=async()=>({data:{preferences:{campfireShareActivity:false}},error:null});state.auth={...authStub(),async signUp(_p,c){calls.push(["auth.signUp",c.email]);return{data:null,error:null};},async signIn(_p,c){calls.push(["auth.signIn",c.email]);return{data:null,error:null};},async signOut(){calls.push(["auth.signOut"]);return{data:null,error:null};}};const harness=await mountInfernoTemplate(projectDir,state);try{await harness.settle();assert.deepEqual(calls.filter(([n])=>n==="registerFixture").map(([,key])=>key),["porthos","aramis","dartagnan"]);assert(calls.some(([n])=>n==="seedCampfire"));const porthos=[...harness.window.document.querySelectorAll("button")].find(b=>b.textContent==="Porthos");porthos.click();await harness.settle();assert(calls.some(([n,email])=>n==="auth.signIn"&&/porthos/.test(email)));}finally{await harness.unmount();}});
});


test("real Lit Photo Library keeps authenticated uploads private and publishes explicitly", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createLitTemplate(dir, "lit-photo-behavior", "photo-library");
    const calls = [], session = litSource({ ...sessionState(), loading: false, auth: { userId: "athos", provider: "google", displayName: "Athos", isAuthenticated: true } });
    const photo = { id: "p1", title: "Secret crown", fileId: "f1", imageUrl: "/private", publicUrlId: "u1", isPublic: false, status: "private" };
    const mutation = (name) => ({ async run(...args) { calls.push([name, ...args]); return { data: null, error: null }; } });
    const files = { async upload(file) { calls.push(["upload", file.name]); return { id: "f2", name: file.name }; }, async publicUrl(id) { calls.push(["publicUrl", id]); return { id: "u2", url: "/public/f2" }; }, async revokePublicUrl(id) { calls.push(["revokePublicUrl", id]); } };
    const harness = await mountLitTemplate(projectDir, { auth: authStub(), files, journey: {}, preferences: {}, session, queries: { publicPhotos: litSource({ data: [], error: null, loading: false }), personalPhotos: litSource({ data: [photo], error: null, loading: false }) }, mutations: { recordPhoto: mutation("recordPhoto"), updatePhotoIsPublic: mutation("updatePhotoIsPublic"), updatePhotoImageUrl: mutation("updatePhotoImageUrl"), updatePhotoPublicUrlId: mutation("updatePhotoPublicUrlId") } });
    try {
      const input = harness.find('input[type="file"]'); Object.defineProperty(input, "files", { configurable: true, value: [{ name: "private.png", type: "image/png", size: 11 }] }); input.dispatchEvent(new harness.window.Event("change", { bubbles: true })); await harness.settle(); assert.equal(harness.find('button[type="submit"], form button').disabled, false);
      harness.find("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true, cancelable: true })); await harness.settle();
      assert(calls.some(([name]) => name === "upload")); assert.equal(calls.some(([name]) => name === "publicUrl"), false); assert.match(harness.text(), /Photo saved privately/);
      calls.length = 0; harness.find(".library button").dispatchEvent(new harness.window.Event("click", { bubbles: true })); await harness.settle();
      assert.deepEqual(calls.map(([name]) => name), ["publicUrl", "updatePhotoImageUrl", "updatePhotoPublicUrlId", "updatePhotoIsPublic"]);
      photo.isPublic = true; await harness.element.requestUpdate(); await harness.settle(); calls.length = 0; harness.find(".library button").dispatchEvent(new harness.window.Event("click", { bubbles: true })); await harness.settle();
      assert.deepEqual(calls.map(([name]) => name), ["revokePublicUrl", "updatePhotoIsPublic", "updatePhotoImageUrl", "updatePhotoPublicUrlId"]);
    } finally { await harness.unmount(); }
  });
});


test("sporades dev uses project files directly and ignores deploy.files declarations", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "dev-files", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "dev-files");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    // A missing declaration fails `sporades deploy`; Dev must neither read nor validate it.
    config.deploy = { ...(config.deploy ?? {}), files: [{ path: "missing/settings.json", update: "preserve" }] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(started.data.event, "started");
      await assert.rejects(access(path.join(projectDir, ".sporades", "deploy-files")), { code: "ENOENT" });
      await assert.rejects(access(path.join(projectDir, ".sporades", "preserved-files")), { code: "ENOENT" });
      await assert.rejects(access(path.join(projectDir, ".sporades", "deploy-file-attempt.jsonl")), { code: "ENOENT" });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev starts MinIO storage Capsule services and injects server-only storage env", async () => {
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
      storage: {
        kind: "storage",
        engine: "minio",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    await installEnvProbeQuery(projectDir);
    const docker = await installFakeDocker(dir);

    await withFakeServiceEndpoint(async ({ port: servicePort }) => {
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: { ...docker.env, FAKE_DOCKER_SERVICE_PORT: String(servicePort) },
      });
      try {
        const starting = await waitForJsonLine(child);
        assert.deepEqual(starting.data, {
          event: "service",
          service: "storage",
          status: "starting",
          engine: "minio",
          statePath: path.join(".sporades", "services", "storage"),
        });
        const ready = await waitForJsonEvent(child, (event) => event.data?.event === "service" && event.data.status === "ready");
        assert.deepEqual(ready.data, {
          event: "service",
          service: "storage",
          status: "ready",
          engine: "minio",
          statePath: path.join(".sporades", "services", "storage"),
          host: "127.0.0.1",
          port: Number(servicePort),
        });
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        assert.equal(started.ok, true);

        const socket = await openSocket(started.data.url);
        try {
          socket.send(JSON.stringify({ id: "env-1", type: "query.subscribe", query: "testEnvProbe" }));
          assert.deepEqual(await readSocketMessage(socket), {
            id: "env-1",
            type: "query.result",
            query: "testEnvProbe",
            data: [],
            error: null,
          });
        } finally {
          socket.close();
        }

        const clientBundle = await (await fetch(`${started.data.url}/client.js`)).text();
        assert.doesNotMatch(clientBundle, /SPORADES_SERVICE_STORAGE_/);
        assert.doesNotMatch(clientBundle, /sporades-minio-local-secret/);

        const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
        assert.match(compose, /sporades-todo-island-storage:/);
        assert.match(compose, /image: quay\.io\/minio\/minio:RELEASE\.2025-04-22T22-12-26Z/);
        assert.match(compose, /MINIO_ROOT_USER: "sporades"/);
        assert.match(compose, /127\.0\.0\.1::9000/);
        assert.match(compose, /todo-island\/\.sporades\/services\/storage\:\/data:rw"/);
        assert.match(compose, /com\.sporades\.capsule-service\.kind: "storage"/);

        const calls = await docker.calls();
        assert.deepEqual(calls[1].args.slice(5), ["ps", "--format", "json", "sporades-todo-island-storage"]);
        assert.deepEqual(calls[2].args.slice(5), ["port", "sporades-todo-island-storage", "9000"]);
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("sporades dev injects database Capsule service connection details into server-only env and restarts services on rebuild", async () => {
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
    await installEnvProbeQuery(projectDir);
    const docker = await installFakeDocker(dir);

    await withFakeLibsqlService(path.join(dir, "dev-libsql.db"), async ({ url: serviceUrl }) => {
      const servicePort = new URL(serviceUrl).port;
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: { ...docker.env, FAKE_DOCKER_SERVICE_PORT: String(servicePort) },
      });
      let socket;
      try {
        await waitForJsonLine(child);
        await waitForJsonEvent(child, (event) => event.data?.event === "service" && event.data.status === "ready");
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        assert.equal(started.ok, true);

        socket = await openSocket(started.data.url);
        socket.send(JSON.stringify({ id: "env-1", type: "query.subscribe", query: "testEnvProbe" }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "env-1",
          type: "query.result",
          query: "testEnvProbe",
          data: [],
          error: null,
        });

        const clientResponse = await fetch(`${started.data.url}/client.js`);
        assert.equal(clientResponse.status, 200);
        const clientBundle = await clientResponse.text();
        assert.doesNotMatch(clientBundle, /SPORADES_SERVICE_DATABASE_URL/);
        assert.doesNotMatch(clientBundle, /SPORADES_SERVICE_DATABASE_AUTH_TOKEN/);
        assert.doesNotMatch(clientBundle, new RegExp(String(servicePort)));

        const stateDir = path.join(projectDir, ".sporades", "services", "database");
        await writeFile(path.join(stateDir, "survives-restart.txt"), "kept\n");
        const clientPath = path.join(projectDir, "client", "index.tsx");
        const originalClient = await readFile(clientPath, "utf8");
        await writeFile(clientPath, originalClient.replace("Sporades Todos", "Sporades Service Todos"));

        const rebuilt = await waitForJsonEvent(child, (event) => event.data?.event === "rebuild" && event.data.status === "success");
        assert.equal(rebuilt.ok, true);
        assert.equal(await readFile(path.join(stateDir, "survives-restart.txt"), "utf8"), "kept\n");

        const calls = await docker.calls();
        assert.equal(calls.filter((call) => call.args[0] === "compose" && call.args.includes("up")).length, 2);
      } finally {
        socket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("Lit configuration without a toolchain defaults to the Vite public-tree contract", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "lit-default", "--framework", "lit", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr || created.stdout);
    const projectDir = path.join(dir, "lit-default");
    await installProjectLitToolchain(projectDir, repoRoot);
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    delete config.client.toolchain;
    const bundle = await createBundle(projectDir, config, { publishLegacy: false });
    try {
      const paths = Object.keys(await snapshotProjectTree(bundle.staticFiles.publicDir)).filter((file) => !file.endsWith("/"));
      assert(paths.some((file) => /^assets\/index-[^/]+\.js$/.test(file)));
      assert(paths.some((file) => /^assets\/index-[^/]+\.css$/.test(file)));
      assert.equal(paths.includes("client.js"), false);
    } finally { await bundle.releasePublicTreeLease(); await discardPublicTree(bundle.staticFiles.publicTree); }
  });
});


test("Solid Guestbook renders query state and drives its native mutation primitive", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createSolidTemplate(dir, "solid-guestbook-behavior", "guestbook");
    let finishSign;
    const signCalls = [];
    const harness = await mountSolidTemplate(projectDir, {
      session: sessionState(),
      queries: { entries: { loading: true, data: null, error: null } },
      mutations: { sign: { loading: false, data: null, error: null, async run(body) {
        signCalls.push(body);
        return new Promise((resolve) => { finishSign = resolve; });
      } } },
      auth: authStub(), files: {}, journey: {}, preferences: {},
    });
    try {
      assert.match(harness.text(), /Loading/);
      harness.setQuery("entries", { loading: false, data: null, error: { message: "Guestbook unavailable" } });
      await harness.settle();
      assert.match(harness.text(), /Guestbook unavailable/);
      harness.setQuery("entries", { loading: false, error: null, data: [{ id: "entry-1", body: "All for one", authorName: "Athos", authorPicture: "", createdAt: "2026-07-11T12:00:00.000Z" }] });
      await harness.settle();
      assert.match(harness.text(), /Athos.*All for one/s);

      const textarea = harness.find("textarea");
      const form = harness.find("form");
      await harness.setValue(textarea, "  One for all  ");
      await harness.trigger(form, "submit");
      assert.deepEqual(signCalls, ["One for all"]);
      assert.equal(harness.state.counts.mutations.sign.runs, 1, "the template invokes createMutation().run rather than treating state as a store");
      assert.equal(harness.find("button[type=submit]").disabled, true);
      finishSign({ data: null, error: { message: "Signing failed" } });
      await harness.settle();
      assert.match(harness.text(), /Signing failed/);
      assert.equal(textarea.value, "  One for all  ", "failed mutation preserves the draft");

      await harness.trigger(form, "submit");
      finishSign({ data: { id: "entry-2" }, error: null });
      await harness.settle();
      assert.equal(textarea.value, "", "successful mutation clears the rendered draft");
    } finally {
      await harness.unmount();
      assert.equal(harness.state.counts.queries.entries.stopped, 1);
      assert.equal(harness.state.counts.session.stopped, 1, "Solid root disposal owns auth cleanup");
    }
  });
});


test("Solid Campfire drives messages, preferences, consented TTL activity, and root cleanup", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createSolidTemplate(dir, "solid-campfire-behavior", "campfire");
    const calls = [];
    let journeySubscriber = () => {};
    const state = campfireHarnessState(calls, { subscribe(callback) { journeySubscriber = callback; return { unsubscribe() { calls.push(["unsubscribe"]); } }; } });
    const harness = await mountSolidTemplate(projectDir, state);
    try {
      harness.setSession({ ...sessionState(), auth: { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false, isAuthenticated: true } });
      await harness.settle();
      assert(calls.some(([name]) => name === "preferences.get"));
      assert(calls.some(([name, value]) => name === "journey.set" && value.status === "reading" && value.ttlSeconds === 12));
      assert.equal(harness.find('input[type="checkbox"]').checked, true);

      journeySubscriber({ data: { type: "snapshot", states: [{ sessionId: "p1", userId: "porthos-user", status: "reading", metadata: { channel: "ideas" } }] } });
      await harness.settle();
      assert.match(harness.text(), /A Musketeer is reading #ideas/);

      const messageInput = harness.find("#message");
      await harness.setValue(messageInput, "Protect the crown");
      assert(calls.some(([name, value]) => name === "journey.set" && value.status === "typing" && value.ttlSeconds === 4));
      await harness.trigger(harness.find("form"), "submit");
      await harness.settle();
      assert(calls.some(([name, input]) => name === "sendMessage" && input.body === "Protect the crown"));
      assert(calls.some(([name, value]) => name === "journey.set" && value.status === "posted" && value.ttlSeconds === 8));

      const share = harness.find('input[type="checkbox"]');
      share.checked = false;
      await harness.trigger(share, "change");
      await harness.settle();
      assert(calls.some(([name, value]) => name === "preferences.update" && value.campfireShareActivity === false));
      harness.setSession({ ...sessionState(), auth: { userId: "porthos-user", provider: "email", displayName: "Porthos", isGuest: false, isAuthenticated: true } });
      await harness.settle();
      assert(calls.some(([name]) => name === "journey.disable"), "auth successor retires the previous owner's consent");
    } finally {
      await harness.unmount();
      assert(calls.some(([name]) => name === "unsubscribe"), "root cleanup releases Journey observation");
      assert.equal(harness.state.counts.queries.messagesGeneral.stopped, 1);
      assert.equal(harness.state.counts.session.stopped, 1);
    }
  });
});


test("Vue Campfire drives messages, preferences, consented TTL activity, and typing disposal", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createVueCampfire(dir, "vue-campfire-behavior");
    const calls = [];
    let journeySubscriber = () => {};
    const harness = await mountVueTemplate(projectDir, campfireHarnessState(calls, {
      subscribe(callback) { journeySubscriber = callback; return { unsubscribe() { calls.push(["unsubscribe"]); } }; },
    }));
    try {
      harness.state.session.auth = { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false };
      await harness.settle();
      assert(calls.some(([name]) => name === "preferences.get"));
      assert(calls.some(([name, state]) => name === "journey.set" && state.status === "reading" && state.ttlSeconds === 12));
      assert.equal(harness.find((node) => node.type === "input" && node.props.type === "checkbox").props.checked, true);

      journeySubscriber({ data: { type: "snapshot", states: [{ sessionId: "p1", userId: "porthos-user", status: "reading", metadata: { channel: "ideas" } }] } });
      await harness.settle();
      assert.match(harness.text(), /A Musketeer is reading #ideas/);

      const messageInput = harness.find((node) => node.type === "input" && node.props.id === "message");
      await harness.setValue(messageInput, "Protect the crown");
      assert(calls.some(([name, state]) => name === "journey.set" && state.status === "typing" && state.ttlSeconds === 4));
      await harness.trigger(harness.find((node) => node.type === "form"), "submit");
      assert(calls.some(([name, input]) => name === "sendMessage" && input.body === "Protect the crown"));
      assert(calls.some(([name, state]) => name === "journey.set" && state.status === "posted" && state.ttlSeconds === 8));

      const beforeDispose = calls.filter(([name, state]) => name === "journey.set" && state?.status === "typing").length;
      await harness.trigger(harness.find((node) => node.type === "button" && nodeText(node) === "# ideas"), "click");
      await new Promise((resolve) => setTimeout(resolve, 2600));
      assert.equal(calls.filter(([name, state]) => name === "journey.set" && state?.status === "typing").length, beforeDispose, "channel transition disposes typing renewal");

      const share = harness.find((node) => node.type === "input" && node.props.type === "checkbox");
      await harness.trigger(share, "change", { checked: false });
      assert(calls.some(([name, value]) => name === "preferences.update" && value.campfireShareActivity === false));
      harness.state.session.auth = { userId: "porthos-user", provider: "email", displayName: "Porthos", isGuest: false };
      await harness.settle();
      assert(calls.some(([name]) => name === "journey.disable"), "auth transition retires Journey consent");
    } finally { harness.unmount(); }
  });
});


test("Solid Vite fails closed when project compiler packages are not installed", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "solid-compiler-missing", "--framework", "solid", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "solid-compiler-missing");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    await assert.rejects(createBundle(projectDir, config), (error) => {
      assert.equal(error.phase, "client");
      assert.equal(error.framework, "solid");
      assert.equal(error.toolchain, "vite");
      assert.match(error.message, /node_modules.*real directory.*Capsule project/i);
      assert.match(error.hint, /npm install.*vite-plugin-solid.*solid-js/i);
      assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostics: error.diagnostics }), new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  });
});


test("pre-telemetry Container binding permits Dev without Docker while preserving its server bundle", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "legacy-dev", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "legacy-dev");
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    await createBundle(projectDir, config);
    const serverPath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const originalServer = await readFile(serverPath);
    const serverEntry = path.join(projectDir, "server", "index.ts");
    const originalSource = await readFile(serverEntry, "utf8");
    await writeFile(serverEntry, originalSource.replace('name: "legacy-dev"', 'name: "fresh-dev-code"'));
    config.name = "fresh-dev-code";
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    await writeFile(path.join(projectDir, ".sporades", "binding.json"), JSON.stringify({
      containerId: "legacy-container", containerName: "legacy-container",
      clientRelease: { framework: "react", toolchain: "esbuild", publicTree: "legacy-public-tree" },
    }));
    const noDocker = path.join(dir, "no-docker");
    await mkdir(noDocker);
    let actionBundlePath;
    const child = startCli(["dev", "--json"], { cwd: projectDir, env: { PATH: noDocker } });
    try {
      const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
      assert.equal(started.ok, true);
      assert.deepEqual(await readFile(serverPath), originalServer);
      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      assert.match(session.actionBundleId, /^[a-f0-9]{32}$/);
      actionBundlePath = path.join(projectDir, ".sporades", "build", ".dev-actions", session.actionBundleId, "server.mjs");
      const actionBeforeFailure = await readFile(actionBundlePath);
      assert.notDeepEqual(actionBeforeFailure, originalServer);
      assert.match(actionBeforeFailure.toString("utf8"), /fresh-dev-code/);
      const jobs = await runCli(["jobs"], { cwd: projectDir, env: { PATH: noDocker } });
      assert.equal(jobs.code, 0, jobs.stderr || jobs.stdout);
      assert.equal(JSON.parse(jobs.stdout).data.capsule.name, "fresh-dev-code");
      const successfulRebuild = waitForJsonEvent(child, (event) => event.data?.event === "rebuild" && event.data?.status === "success");
      config.name = "newer-dev-code";
      await writeFile(configPath, `${JSON.stringify(config)}\n`);
      await successfulRebuild;
      const actionAfterRebuild = await readFile(actionBundlePath);
      assert.match(actionAfterRebuild.toString("utf8"), /newer-dev-code/);
      assert.notDeepEqual(actionAfterRebuild, actionBeforeFailure);
      assert.deepEqual(await readFile(serverPath), originalServer);
      const rebuiltJobs = await runCli(["jobs"], { cwd: projectDir, env: { PATH: noDocker } });
      assert.equal(rebuiltJobs.code, 0, rebuiltJobs.stderr || rebuiltJobs.stdout);
      assert.equal(JSON.parse(rebuiltJobs.stdout).data.capsule.name, "newer-dev-code");
      const failedRebuild = waitForJsonEvent(child, (event) => event.data?.event === "rebuild" && event.data?.status === "failed");
      await writeFile(serverEntry, "export default ???");
      await failedRebuild;
      assert.deepEqual(await readFile(actionBundlePath), actionAfterRebuild);
      assert.deepEqual(await readFile(serverPath), originalServer);
      const rolledBackJobs = await runCli(["jobs"], { cwd: projectDir, env: { PATH: noDocker } });
      assert.equal(rolledBackJobs.code, 0, rolledBackJobs.stderr || rolledBackJobs.stdout);
      assert.equal(JSON.parse(rolledBackJobs.stdout).data.capsule.name, "newer-dev-code");
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    }
    assert.deepEqual(await readFile(serverPath), originalServer);
    await assert.rejects(access(path.dirname(actionBundlePath)), { code: "ENOENT" });
  });
});


test("SIGHUP removes the owned Dev action Bundle", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "hungup-action", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "hungup-action");
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    const marker = path.join(dir, "started-action-id");
    const preload = path.join(dir, "hangup-at-started.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import path from 'node:path';
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const result = write(chunk, ...args);
  let event; try { event = JSON.parse(String(chunk)); } catch {}
  if (event?.data?.event === 'started') {
    const session = JSON.parse(fs.readFileSync('.sporades/dev-session.json', 'utf8'));
    fs.statSync(path.join('.sporades/build/.dev-actions', session.actionBundleId, 'server.mjs'));
    fs.writeFileSync(${JSON.stringify(marker)}, session.actionBundleId);
    process.kill(process.pid, 'SIGHUP');
  }
  return result;
};`);
    const child = startCli(["dev", "--json"], { cwd: projectDir, env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(" "),
    } });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const guard = setTimeout(() => child.kill("SIGKILL"), TEST_PROCESS_EVENT_TIMEOUT_MS);
    try {
      const [code, signal] = await new Promise(resolve => child.once("exit", (...result) => resolve(result)));
      const id = await readFile(marker, "utf8");
      assert.equal(signal, null, "started must publish only after the SIGHUP handler is installed");
      assert.equal(code, 0, stderr);
      await assert.rejects(access(path.join(projectDir, ".sporades/build/.dev-actions", id)), { code: "ENOENT" });
      await assert.rejects(access(path.join(projectDir, ".sporades/dev-session.json")), { code: "ENOENT" });
    } finally {
      clearTimeout(guard);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); }
    }
  });
});


test("sporades dev rolls back multi-write Custom endpoint app-table failures", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-rollback-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "endpoint-rollback-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint, String, table } from "sporades/server";

export default capsule({
  name: "endpoint-rollback-island",

  schema: {
    notes: table({
      text: String(),
      ownerId: String(),
    }),
  },

  endpoints: {
    record: endpoint({ method: "POST", path: "/record" }, (ctx) => {
      ctx.db.notes.insert({ text: ctx.request.body.text + ":committed", ownerId: ctx.auth.userId });
      return { status: 200, body: { ok: true } };
    }),
    explode: endpoint({ method: "POST", path: "/explode" }, (ctx) => {
      ctx.db.notes.insert({ text: ctx.request.body.text + ":first", ownerId: ctx.auth.userId });
      ctx.db.notes.insert({ text: ctx.request.body.text + ":second", ownerId: ctx.auth.userId });
      throw new Error("Endpoint write failed.");
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const committedResponse = await fetch(`${started.data.url}/record`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "before" }),
      });
      assert.equal(committedResponse.status, 200);

      const failedResponse = await fetch(`${started.data.url}/explode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "rollback" }),
      });
      assert.equal(failedResponse.status, 500);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      assert.deepEqual(
        tables.find((table) => table.name === "notes").rows.map((row) => row.text),
        ["before:committed"],
      );
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev gives endpoint handlers request context and structured responses", async () => {
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
    await writeFile(path.join(projectDir, ".env.sporades.server"), "WEBHOOK_SECRET=dev-secret\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    echo: endpoint({ method: "POST", path: "/integrations/echo" }, (ctx) => ({
      status: 201,
      headers: { "x-sporades-endpoint": ctx.env.WEBHOOK_SECRET },
      body: {
        method: ctx.request.method,
        path: ctx.request.path,
        header: ctx.request.headers["x-source"],
        query: ctx.request.query.source,
        body: ctx.request.body,
        authProvider: ctx.auth.provider,
        logMethods: Object.keys(ctx.log).sort(),
      },
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const endpointResponse = await fetch(`${started.data.url}/integrations/echo?source=test-suite`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-source": "integration",
        },
        body: JSON.stringify({ hello: "endpoint" }),
      });
      assert.equal(endpointResponse.status, 201);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(endpointResponse.headers.get("x-sporades-endpoint"), "dev-secret");
      assert.deepEqual(await endpointResponse.json(), {
        method: "POST",
        path: "/integrations/echo",
        header: "integration",
        query: "test-suite",
        body: { hello: "endpoint" },
        authProvider: "anonymous",
        logMethods: ["error", "info", "warn"],
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev endpoints treat missing or invalid session tokens as a new anonymous session", async () => {
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
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    authState: endpoint({ method: "GET", path: "/integrations/auth" }, (ctx) => ({
      status: 200,
      body: {
        auth: ctx.auth,
        credential: ctx.credential,
        authorization: ctx.request.headers.authorization ?? null,
      },
    })),
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
      const existingAuth = (await readSocketMessage(socket)).data.auth;

      const missingTokenResponse = await fetch(`${started.data.url}/integrations/auth`);
      assert.equal(missingTokenResponse.status, 200);
      const missingTokenResult = await missingTokenResponse.json();
      const missingTokenAuth = missingTokenResult.auth;
      assert.equal(missingTokenAuth.provider, "anonymous");
      assert.equal(missingTokenAuth.isGuest, true);
      assert.notEqual(missingTokenAuth.userId, existingAuth.userId);
      assert.deepEqual(missingTokenResult.credential, { kind: "session" });
      assert.equal(missingTokenResult.authorization, null);

      const invalidTokenResponse = await fetch(`${started.data.url}/integrations/auth`, {
        headers: {
          authorization: "Bearer capsule-owned-value",
          "x-sporades-session-token": "not-a-real-session",
        },
      });
      assert.equal(invalidTokenResponse.status, 200);
      const invalidTokenResult = await invalidTokenResponse.json();
      const invalidTokenAuth = invalidTokenResult.auth;
      assert.equal(invalidTokenAuth.provider, "anonymous");
      assert.equal(invalidTokenAuth.isGuest, true);
      assert.notEqual(invalidTokenAuth.userId, existingAuth.userId);
      assert.deepEqual(invalidTokenResult.credential, { kind: "session" });
      assert.equal(invalidTokenResult.authorization, "Bearer capsule-owned-value");
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades auth as email --client current reports undelivered when no browser client is connected", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "auth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "auth-island");
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

      const simulated = await runCli(
        [
          "auth",
          "as",
          "email",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira Vale",
          "--client",
          "current",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const body = JSON.parse(simulated.stdout);
      assert.equal(body.ok, true);
      assert.equal(body.data.localStorage.key, "sporades.sessionToken");
      assert.equal(typeof body.data.localStorage.value, "string");
      assert.deepEqual(body.data.delivery, {
        target: "current",
        delivered: false,
        clients: 0,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades auth as google creates a simulated provider-shaped session without OAuth", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "auth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "auth-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = { providers: { anonymous: true, google: { clientIdEnv: "GOOGLE_CLIENT_ID", clientSecretEnv: "GOOGLE_CLIENT_SECRET" } } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n");
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const result = await runCli(
        [
          "auth",
          "as",
          "google",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira",
          "--picture",
          "https://example.com/mira.png",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(result.code, 0, result.stderr);
      const simulated = JSON.parse(result.stdout);
      assert.equal(simulated.data.auth.provider, "google");
      assert.equal(simulated.data.auth.email, "mira@example.com");
      assert.equal(simulated.data.auth.displayName, "Mira");
      assert.equal(simulated.data.auth.picture, "https://example.com/mira.png");
      assert.equal(typeof simulated.data.localStorage.value, "string");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev returns structured errors for invalid endpoint responses", async () => {
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
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    invalid: endpoint({ method: "POST", path: "/integrations/invalid" }, () => ({
      status: "created",
      body: { ok: true },
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const endpointResponse = await fetch(`${started.data.url}/integrations/invalid`, { method: "POST" });
      assert.equal(endpointResponse.status, 500);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(await endpointResponse.json(), {
        ok: false,
        data: null,
        error: {
          message: "Invalid endpoint response.",
          hint: "Return { status, headers, body } with a numeric status, plain object headers, and a serializable body.",
        },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) test(`sporades dev preserves last-good Inferno Vite ${template} output through acknowledged full-page refresh`, async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createInfernoTemplate(dir, `inferno-vite-dev-${template}`, template, { toolchain: "vite" });
    if (template === "photo-library") await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n");
    const configPath = path.join(projectDir, "sporades.json"); const config = JSON.parse(await readFile(configPath, "utf8")); config.dev.port = 0; await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const clientPath = path.join(projectDir, "client", "index.tsx"), original = await readFile(clientPath, "utf8");
    const child = startCli(["dev", "--json"], { cwd: projectDir }); const events = captureJsonEvents(child); let socket, messages;
    try {
      const scrub = (html) => html.replace(/window\.__SPORADES_CONNECTION_TOKEN="[^"]+"/, 'window.__SPORADES_CONNECTION_TOKEN="<token>"');
      const started = await events.next((event) => event.ok && event.data?.event === "started"); socket = await openSocket(started.data.url); messages = captureSocketMessages(socket);
      socket.send(JSON.stringify({ id: "inferno-ready", type: "dev.refresh.subscribe" })); await messages.next((message) => message.id === "inferno-ready");
      const refresh = messages.next((message) => message.type === "refresh"); await writeFile(clientPath, original.replace("</main>}", '<p data-probe="rebuilt">Inferno rebuilt</p></main>}'));
      const refreshMessage = await refresh; socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: refreshMessage.data.sequence }));
      const rebuilt = await events.next((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success"); assert.deepEqual(rebuilt.data.build, { phase: "client", framework: "inferno", toolchain: "vite" });
      const lastGood = scrub(await (await fetch(started.data.url)).text());
      await writeFile(clientPath, "export const = ;\n"); const failed = await events.next((event) => !event.ok && event.data?.event === "rebuild");
      assert.deepEqual(failed.data.build, { phase: "client", framework: "inferno", toolchain: "vite" }); assert.match(failed.error.message, /Client bundle failed/); assert.equal(scrub(await (await fetch(started.data.url)).text()), lastGood);
      const recoveredRefresh = messages.next((message) => message.type === "refresh"); await writeFile(clientPath, original); const recoveredMessage = await recoveredRefresh; socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: recoveredMessage.data.sequence }));
      const recovered = await events.next((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success"); assert.deepEqual(recovered.data.build, { phase: "client", framework: "inferno", toolchain: "vite" });
    } finally { messages?.dispose(); await closeSocketGracefully(socket); child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
  });
});


test("sporades dev generated server bundle handles client WebSocket close frames", async () => {
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
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      assert.match(serverBundle, /function drainWebSocketFrames/);
      assert.match(serverBundle, /function closeWebSocketClient/);
      assert.match(serverBundle, /function localFileStoragePath/);
      assert.match(serverBundle, /function localFileVersionPath/);

      socket = await openSocketWithHeaders(started.data.url);
      socket.sendJson({
        id: "upload-url",
        type: "file.uploadUrl",
        file: { name: "hello.txt", type: "text/plain", size: 11 },
      });
      const uploadUrl = await socket.readJson();
      assert.equal(uploadUrl.type, "file.uploadUrl.result");
      assert.equal(uploadUrl.error, null, uploadUrl.error?.message);
      const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, started.data.url), {
        method: uploadUrl.data.method,
        body: "hello world",
      });
      assert.equal(uploadResponse.status, 200);
      const uploaded = await uploadResponse.json();
      assert.equal(uploaded.ok, true, JSON.stringify(uploaded.error));
      assert.equal(uploaded.data.file.id, uploadUrl.data.file.id);

      socket.sendCloseFrame();
      await socket.waitForClose();

      const root = await fetch(started.data.url);
      assert.equal(root.status, 200);
      assert.match(await root.text(), /client\.js/);
    } finally {
      socket?.destroy();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev reloads server-runtime config on rebuild and disconnects old WebSocket clients", async () => {
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
    let reconnectedSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);

      config.auth = { providers: { anonymous: true, email: true } };
      const pendingSchemaRebuild = Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

      const [rebuilt] = await pendingSchemaRebuild;
      assert.equal(rebuilt.error, null);

      reconnectedSocket = await openSocket(started.data.url);
      reconnectedSocket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
      const authAfter = await readSocketMessage(reconnectedSocket);
      assert.equal(authAfter.data.providers.email.enabled, true);

      reconnectedSocket.send(
        JSON.stringify({
          id: "email-sign-up",
          type: "auth.signUp",
          provider: "email",
          credentials: { email: "mira@example.com", password: "secret-password", name: "Mira" },
        }),
      );
      const signUp = await readSocketMessage(reconnectedSocket);
      assert.equal(signUp.error, null);
      assert.equal(signUp.data.auth.provider, "email");
    } finally {
      reconnectedSocket?.close();
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev logs a capsule reload that a server change triggered", async () => {
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

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(
        serverPath,
        originalServer.replace(
          "todos: table({",
          `notes: table({
      text: String(),
    }),
    todos: table({`,
        ),
      );

      const rebuilt = await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );
      assert.equal(rebuilt.error, null);

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const reloaded = JSON.parse(logsResult.stdout).data.entries.find(
        (entry) => entry.event === "dev.capsule.reloaded",
      );

      assert.ok(reloaded, "expected a dev.capsule.reloaded log entry after a server change");
      assert.equal(reloaded.category, "platform");
      assert.equal(reloaded.level, "info");
      assert.equal(reloaded.capsule.name, "todo-island");
      assert.ok(reloaded.data.tables.includes("notes"), JSON.stringify(reloaded.data.tables));
      assert.ok(reloaded.data.tables.includes("todos"), JSON.stringify(reloaded.data.tables));
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev supports Date fields through migrations, mutations, queries, and table API filters", async () => {
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
            `import { Boolean, capsule, mutation, query, String, table } from "sporades/server";`,
            `import { Boolean, capsule, Date, endpoint, mutation, query, String, table } from "sporades/server";`,
          )
          .replace(
            "done: Boolean().default(false),",
            `done: Boolean().default(false),
      dueAt: Date().default(new globalThis.Date("2026-01-02T03:04:05.000Z")),
      reminderAt: Date(),`,
          )
          .replace(
            "queries: {",
            `endpoints: {
    dueTodos: endpoint({ method: "GET", path: "/due-todos" }, (ctx) => ({
      body: ctx.db.todos.where("dueAt", new globalThis.Date(ctx.request.query.dueAt)).orderBy("reminderAt", "asc").all()
    })),
  },

  queries: {`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `rescheduleTodo: mutation((ctx, id, dueAt) => {
      ctx.db.todos.update(id, { dueAt: new globalThis.Date(dueAt) });
    }),

    recordDatedTodo: mutation((ctx, text, dueAt, reminderAt) => {
      ctx.db.todos.insert({
        text,
        done: false,
        dueAt: new globalThis.Date(dueAt),
        reminderAt: reminderAt === null ? null : new globalThis.Date(reminderAt),
        ownerId: ctx.auth.userId,
      });
    }),

    addTodo: mutation((ctx, text: string, done: boolean, dueAt: string, reminderAt: string | null) => {`,
          )
          .replace(
            "ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });",
            "ctx.db.todos.insert({ text, done, dueAt: new globalThis.Date(dueAt), reminderAt: reminderAt === null ? null : new globalThis.Date(reminderAt), ownerId: ctx.auth.userId });",
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
      assert.equal(migratedRows.data[0].dueAt, "2026-01-02T03:04:05.000Z");
      assert.equal(migratedRows.data[0].reminderAt, null);

      const addFirstResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "add-first" && message.type === "mutation.result",
      );
      const firstDateRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "First date"),
      );
      migratedSocket.send(
        JSON.stringify({
          id: "add-first",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["First date", false, "2026-03-01T10:00:00.000Z", "2026-02-01T09:00:00.000Z"],
        }),
      );
      assert.equal((await addFirstResultPromise).error, null);
      await firstDateRowsPromise;

      const addSecondResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "add-second" && message.type === "mutation.result",
      );
      const rowsWithSecondPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Second date"),
      );
      migratedSocket.send(
        JSON.stringify({
          id: "add-second",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["Second date", false, "2026-03-01T10:00:00.000Z", null],
        }),
      );
      assert.equal((await addSecondResultPromise).error, null);
      const rowsWithSecond = await rowsWithSecondPromise;
      const firstDateRow = rowsWithSecond.data.find((todo) => todo.text === "First date");
      assert.equal(firstDateRow.dueAt, "2026-03-01T10:00:00.000Z");
      assert.equal(rowsWithSecond.data.find((todo) => todo.text === "Second date").reminderAt, null);

      const updateDateResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "update-date" && message.type === "mutation.result",
      );
      const updatedDateRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.find((todo) => todo.id === firstDateRow.id)?.dueAt === "2026-04-01T12:30:00.000Z",
      );
      migratedSocket.send(
        JSON.stringify({
          id: "update-date",
          type: "mutation.run",
          mutation: "rescheduleTodo",
          args: [firstDateRow.id, "2026-04-01T12:30:00.000Z"],
        }),
      );
      assert.equal((await updateDateResultPromise).error, null);
      await updatedDateRowsPromise;

      const recordDateResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "record-date" && message.type === "mutation.result",
      );
      const tableApiDateRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some(
            (todo) =>
              todo.text === "Table API date" &&
              todo.dueAt === "2026-05-01T08:00:00.000Z" &&
              todo.reminderAt === "2026-04-30T18:00:00.000Z",
          ),
      );
      migratedSocket.send(
        JSON.stringify({
          id: "record-date",
          type: "mutation.run",
          mutation: "recordDatedTodo",
          args: ["Table API date", "2026-05-01T08:00:00.000Z", "2026-04-30T18:00:00.000Z"],
        }),
      );
      assert.equal((await recordDateResultPromise).error, null);
      await tableApiDateRowsPromise;

      const invalidDateResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "invalid-date" && message.type === "mutation.result",
      );
      migratedSocket.send(
        JSON.stringify({
          id: "invalid-date",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["Bad date", false, "not-a-date", "2026-02-01T09:00:00.000Z"],
        }),
      );
      assert.deepEqual(await invalidDateResultPromise, {
        id: "invalid-date",
        type: "mutation.result",
        data: null,
        error: {
          message: "Invalid date value for field: dueAt",
          hint: "Pass an ISO 8601 date string or JavaScript Date value.",
        },
        mutation: "addTodo",
      });

      const endpointResult = await fetch(`${started.data.url}/due-todos?dueAt=2026-03-01T10%3A00%3A00.000Z`);
      assert.equal(endpointResult.status, 200);
      const endpointRows = await endpointResult.json();
      assert.deepEqual(
        endpointRows.map((todo) => todo.text),
        ["Second date"],
      );
      assert.equal(endpointRows[0].reminderAt, null);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      const todosTable = tables.find((table) => table.name === "todos");
      assert.deepEqual(todosTable.columns, [
        "id",
        "createdAt",
        "updatedAt",
        "text",
        "done",
        "dueAt",
        "reminderAt",
        "ownerId",
      ]);
      assert.equal(todosTable.rows.find((row) => row.text === "Keep me").dueAt, "2026-01-02T03:04:05.000Z");
      assert.equal(todosTable.rows.find((row) => row.text === "Keep me").reminderAt, null);
      assert.equal(todosTable.rows.find((row) => row.text === "First date").dueAt, "2026-04-01T12:30:00.000Z");
      assert.equal(todosTable.rows.find((row) => row.text === "Table API date").dueAt, "2026-05-01T08:00:00.000Z");
      const systemRows = tables.find((table) => table.name === "sporades").rows;
      assert.match(systemRows.find((row) => row.key === "schema")?.value ?? "", /"kind":"Date"/);
      assert.match(systemRows.find((row) => row.key === "schema")?.value ?? "", /"sqliteType":"TEXT"/);
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


test("sporades dev supports Reference fields end-to-end", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "library", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "library");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint, mutation, query, Reference, String, table } from "sporades/server";

export default capsule({
  name: "Library",
  schema: {
    users: table({
      name: String(),
      ownerId: String(),
    }),
    posts: table({
      text: String(),
      authorId: Reference("users"),
      ownerId: String(),
    }),
  },
  queries: {
    users: query((ctx) => ctx.db.users.where("ownerId", ctx.auth.userId).all()),
    posts: query((ctx) => ctx.db.posts.where("ownerId", ctx.auth.userId).orderBy("createdAt", "desc").all()),
  },
  mutations: {
    addUser: mutation((ctx, name: string) => {
      ctx.db.users.insert({ name, ownerId: ctx.auth.userId });
    }),
    addPost: mutation((ctx, text: string, authorId: string) => {
      ctx.db.posts.insert({ text, authorId, ownerId: ctx.auth.userId });
    }),
    updatePostAuthorId: mutation((ctx, id: string, authorId: string) => {
      ctx.db.posts.update(id, { authorId });
    }),
  },
  endpoints: {
    postsByAuthor: endpoint({ method: "GET", path: "/posts/by-author" }, (ctx) => ({
      body: ctx.db.posts.where("authorId", ctx.request.query.authorId).orderBy("authorId").all(),
    })),
  },
});
`,
    );

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    let migratedSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(socket)).data.sessionToken;

      socket.send(JSON.stringify({ id: "users", type: "query.subscribe", query: "users" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);
      const usersAfterAdaPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "users" && message.type === "query.result" && message.data.length === 1,
      );
      socket.send(JSON.stringify({ id: "add-ada", type: "mutation.run", mutation: "addUser", args: ["Ada"] }));
      assert.equal((await readSocketMessage(socket)).error, null);
      const usersAfterAda = await usersAfterAdaPromise;
      const adaId = usersAfterAda.data[0].id;
      assert.equal(usersAfterAda.data[0].name, "Ada");

      socket.send(JSON.stringify({ id: "posts", type: "query.subscribe", query: "posts" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);
      const postsAfterInsertPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "posts" && message.type === "query.result" && message.data.length === 1,
      );
      socket.send(
        JSON.stringify({ id: "add-post", type: "mutation.run", mutation: "addPost", args: ["Notes on engines", adaId] }),
      );
      assert.equal((await readSocketMessage(socket)).error, null);
      const postsAfterInsert = await postsAfterInsertPromise;
      assert.equal(postsAfterInsert.data[0].authorId, adaId);

      const byAuthorResponse = await fetch(`${started.data.url}/posts/by-author?authorId=${adaId}`);
      assert.equal(byAuthorResponse.status, 200);
      const postsByAuthor = await byAuthorResponse.json();
      assert.equal(postsByAuthor[0].text, "Notes on engines");
      assert.equal(postsByAuthor[0].authorId, adaId);

      const usersAfterGracePromise = waitForSocketMessage(
        socket,
        (message) => message.id === "users" && message.type === "query.result" && message.data.length === 2,
      );
      socket.send(JSON.stringify({ id: "add-grace", type: "mutation.run", mutation: "addUser", args: ["Grace"] }));
      assert.equal((await readSocketMessage(socket)).error, null);
      const usersAfterGrace = await usersAfterGracePromise;
      const graceId = usersAfterGrace.data.find((user) => user.name === "Grace").id;

      const postsAfterUpdatePromise = waitForSocketMessage(
        socket,
        (message) => message.id === "posts" && message.type === "query.result" && message.data[0]?.authorId === graceId,
      );
      socket.send(
        JSON.stringify({
          id: "update-author",
          type: "mutation.run",
          mutation: "updatePostAuthorId",
          args: [postsAfterInsert.data[0].id, graceId],
        }),
      );
      assert.equal((await readSocketMessage(socket)).error, null);
      const postsAfterUpdate = await postsAfterUpdatePromise;
      assert.equal(postsAfterUpdate.data[0].text, "Notes on engines");

      socket.send(
        JSON.stringify({
          id: "bad-reference",
          type: "mutation.run",
          mutation: "addPost",
          args: ["Missing author", "missing-user-id"],
        }),
      );
      assert.deepEqual((await readSocketMessage(socket)).error, {
        message: "Invalid reference for field: authorId",
        hint: "Pass the id of an existing users row.",
      });

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
        originalServer.replace(
          "authorId: Reference(\"users\"),",
          `authorId: Reference("users"),
      editorId: Reference("users").default("${graceId}"),`,
        ),
      );

      const [rebuilt] = await pendingSchemaRebuild;
      assert.equal(rebuilt.error, null);
      socket = null;

      migratedSocket = await openSocket(started.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "posts-after-migration", type: "query.subscribe", query: "posts" }));
      const migratedPosts = await readSocketMessage(migratedSocket);
      assert.equal(migratedPosts.error, null);
      assert.equal(migratedPosts.data[0].authorId, graceId);
      assert.equal(migratedPosts.data[0].editorId, graceId);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const postsTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "posts");
      assert.deepEqual(postsTable.columns, ["id", "createdAt", "updatedAt", "text", "authorId", "editorId", "ownerId"]);
      assert.equal(postsTable.rows[0].authorId, graceId);
      assert.equal(postsTable.rows[0].editorId, graceId);
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


test("sporades dev reports rebuild events in human-readable output", async () => {
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

    const child = startCli(["dev"], { cwd: projectDir });
    try {
      const started = await waitForStdoutLine(child, (line) => line.startsWith("Sporades dev session started at "));
      assert.match(started, /^Sporades dev session started at http:\/\/localhost:\d+$/);

      const clientPath = path.join(projectDir, "client", "index.tsx");
      const originalClient = await readFile(clientPath, "utf8");
      await writeFile(clientPath, originalClient.replace("Sporades Todos", "Sporades Human Todos"));

      const rebuilt = await waitForStdoutLine(child, (line) => line.startsWith("Sporades dev session rebuilt at "));
      assert.match(rebuilt, /^Sporades dev session rebuilt at http:\/\/localhost:\d+$/);

      await rm(clientPath);
      const failed = await waitForStdoutLine(child, (line) => line.startsWith("Sporades dev rebuild failed: "));
      assert.match(failed, /Missing client entry: client\/index\.tsx/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev loads server env into ctx.env without exposing it to the client bundle", async () => {
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
    await writeFile(path.join(projectDir, ".env.sporades.server"), "API_SECRET=server-only\nFEATURE_FLAG=enabled\n");
    await installFakeReact(projectDir);
    await installEnvProbeQuery(projectDir, '{ keys: Object.keys(ctx.env).sort(), apiSecretLoaded: ctx.env.API_SECRET === "server-only", featureFlag: ctx.env.FEATURE_FLAG }');

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "env-1", type: "query.subscribe", query: "testEnvProbe" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "env-1",
        type: "query.result",
        query: "testEnvProbe",
        data: {
          keys: ["API_SECRET", "FEATURE_FLAG"],
          apiSecretLoaded: true,
          featureFlag: "enabled",
        },
        error: null,
      });
      // The removed runtime-owned env query name is now an ordinary unknown query (#289).
      socket.send(JSON.stringify({ id: "env-2", type: "query.subscribe", query: "ctx.env" }));
      const unknown = await readSocketMessage(socket);
      assertUnknownEnvQuery(unknown, "env-2");
      assert.doesNotMatch(JSON.stringify(unknown), /server-only|API_SECRET/);

      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      assert.doesNotMatch(await clientResponse.text(), /server-only/);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev gives provider-specific OAuth guidance with the exact safe callback URL", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "oauth-guidance-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "oauth-guidance-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 4105;
    config.auth = {
      providers: {
        anonymous: true,
        microsoft: {
          clientIdEnv: "MICROSOFT_CLIENT_ID",
          clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
          tenant: "organizations",
        },
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "MICROSOFT_CLIENT_ID=partial-id\n");

    const result = await runCli(["dev", "--json"], { cwd: projectDir });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Microsoft auth is not fully configured.",
        hint: "Run `sporades auth set microsoft --client-id <id> --client-secret <secret>` or use `--client-json <path>`. Register callback URL http://localhost:4105/__sporades/auth/microsoft/callback.",
      },
    });
  });
});


test("WebSocket email sign-up authenticates the current session and populates ctx.auth", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "email-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "email-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = {
      providers: {
        anonymous: true,
        email: true,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, query } from "sporades/server";

export default capsule({
  name: "email-island",
  queries: {
    me: query((ctx) => ctx.auth),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const anonymousAuth = await readSocketMessage(socket);
      assert.equal(anonymousAuth.data.auth.provider, "anonymous");

      socket.send(
        JSON.stringify({
          id: "signup-1",
          type: "auth.signUp",
          provider: "email",
          credentials: {
            email: "mira@example.com",
            password: "correct horse battery staple",
            name: "Mira",
          },
        }),
      );
      const signUp = await readSocketMessage(socket);
      assert.equal(signUp.id, "signup-1");
      assert.equal(signUp.type, "auth.signUp.result");
      assert.equal(signUp.error, null);
      assert.equal(signUp.data.ok, true);
      assert.notEqual(signUp.data.sessionToken, anonymousAuth.data.sessionToken);
      assert.deepEqual(signUp.data.auth, {
        userId: anonymousAuth.data.auth.userId,
        displayName: "Mira",
        email: "mira@example.com",
        picture: null,
        isAuthenticated: true,
        isGuest: false,
        provider: "email",
      });

      socket.send(JSON.stringify({ id: "me-1", type: "query.subscribe", query: "me" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "me-1",
        type: "query.result",
        query: "me",
        data: signUp.data.auth,
        error: null,
      });

      socket.send(
        JSON.stringify({
          id: "signup-duplicate",
          type: "auth.signUp",
          provider: "email",
          credentials: {
            email: "mira@example.com",
            password: "another good password",
          },
        }),
      );
      const duplicateSignUp = await readSocketMessage(socket);
      assert.deepEqual(duplicateSignUp, {
        id: "signup-duplicate",
        type: "error",
        data: null,
        error: {
          code: "REGISTRATION_DENIED",
          message: "Registration was not admitted.",
          hint: "Use valid registration admission and retry.",
        },
      });

      socket.send(JSON.stringify({ id: "auth-after-duplicate", type: "auth.get" }));
      assert.deepEqual((await readSocketMessage(socket)).data.auth, signUp.data.auth);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("dev inspection JSON requests reject oversized bodies with structured diagnostics", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "request-limit-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "request-limit-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.http = { maxBodyBytes: 64 };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      const response = await fetch(`${started.data.url}/__sporades/debug/db/query`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sporades-inspection-token": session.inspectionToken,
        },
        body: JSON.stringify({ sql: "SELECT 1", filler: "x".repeat(128) }),
      });

      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), {
        ok: false,
        data: null,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body is too large.",
          hint: "Send a request body at or below 64 bytes, or raise http.maxBodyBytes in sporades.json.",
        },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades db query runs read-only SQL against the running dev session database", async () => {
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

      const queryResult = await runCli(
        ["db", "query", "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name", "--json"],
        { cwd: projectDir },
      );
      assert.equal(queryResult.code, 0, queryResult.stderr);
      assert.deepEqual(JSON.parse(queryResult.stdout), {
        ok: true,
        data: {
          columns: ["name"],
          rows: [
            { name: "sporades" },
            { name: "sporades_auth_access_key_locks" },
            { name: "sporades_auth_access_key_owners" },
            { name: "sporades_auth_access_keys" },
            { name: "sporades_auth_email_credentials" },
            { name: "sporades_auth_identities" },
            { name: "sporades_auth_oauth_states" },
            { name: "sporades_auth_password_reset_codes" },
            { name: "sporades_auth_reauthentication_proofs" },
            { name: "sporades_auth_reauthentication_throttle" },
            { name: "sporades_auth_reauthentication_throttle_fence" },
            { name: "sporades_auth_service_user_locks" },
            { name: "sporades_auth_sessions" },
            { name: "sporades_auth_users" },
            { name: "sporades_file_buckets" },
            { name: "sporades_file_ingress" },
            { name: "sporades_file_ingress_audit_outbox" },
            { name: "sporades_file_public_urls" },
            { name: "sporades_file_uploads" },
            { name: "sporades_files" },
            { name: "sporades_jobs" },
            { name: "sporades_schedule_legacy_adoption" },
            { name: "sporades_schedule_occurrences" },
            { name: "sporades_schedules" },
            ...TEAM_RUNTIME_TABLES.map((name) => ({ name })),
            { name: "sporades_user_preferences" },
            { name: "todos" },
          ],
        },
        error: null,
      });

      const internalLogQuery = await runCli(["db", "query", "SELECT * FROM sporades_log_events", "--json"], {
        cwd: projectDir,
      });
      assert.equal(internalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(internalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const qualifiedInternalLogQuery = await runCli(["db", "query", "SELECT * FROM main.sporades_log_events", "--json"], {
        cwd: projectDir,
      });
      assert.equal(qualifiedInternalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(qualifiedInternalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const quotedQualifiedInternalLogQuery = await runCli(
        ["db", "query", 'SELECT message, payload FROM main."sporades_log_events"', "--json"],
        { cwd: projectDir },
      );
      assert.equal(quotedQualifiedInternalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(quotedQualifiedInternalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const parenthesizedInternalLogQuery = await runCli(
        ["db", "query", "SELECT message, payload FROM (sporades_log_events)", "--json"],
        { cwd: projectDir },
      );
      assert.equal(parenthesizedInternalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(parenthesizedInternalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const blockCommentInternalLogQuery = await runCli(
        ["db", "query", "SELECT message FROM /* comment */ sporades_log_events", "--json"],
        { cwd: projectDir },
      );
      assert.equal(blockCommentInternalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(blockCommentInternalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const lineCommentInternalLogQuery = await runCli(
        ["db", "query", "SELECT message FROM -- comment\n sporades_log_events", "--json"],
        { cwd: projectDir },
      );
      assert.equal(lineCommentInternalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(lineCommentInternalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const schemaSqlQuery = await runCli(
        ["db", "query", "SELECT sql FROM sqlite_schema WHERE type = 'table' ORDER BY name", "--json"],
        { cwd: projectDir },
      );
      assert.equal(schemaSqlQuery.code, 0, schemaSqlQuery.stderr);
      assert.equal(
        JSON.stringify(JSON.parse(schemaSqlQuery.stdout).data.rows).includes("sporades_log_events"),
        false,
      );

      const schemaProjectionQuery = await runCli(
        ["db", "query", "SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name", "--json"],
        { cwd: projectDir },
      );
      assert.equal(schemaProjectionQuery.code, 0, schemaProjectionQuery.stderr);
      assert.equal(
        JSON.stringify(JSON.parse(schemaProjectionQuery.stdout).data.rows).includes("sporades_log_events"),
        false,
      );

      const transformedSchemaQuery = await runCli(
        ["db", "query", "SELECT quote(name) AS leaked FROM sqlite_schema WHERE type = 'table' ORDER BY name", "--json"],
        { cwd: projectDir },
      );
      assert.equal(transformedSchemaQuery.code, 0, transformedSchemaQuery.stderr);
      assert.equal(
        JSON.stringify(JSON.parse(transformedSchemaQuery.stdout).data.rows).includes("sporades_log_events"),
        false,
      );

      const literalOnlyQuery = await runCli(
        ["db", "query", "SELECT 'sporades_log_events' AS literal_only", "--json"],
        { cwd: projectDir },
      );
      assert.equal(literalOnlyQuery.code, 0, literalOnlyQuery.stderr);
      assert.deepEqual(JSON.parse(literalOnlyQuery.stdout), {
        ok: true,
        data: {
          columns: ["literal_only"],
          rows: [{ literal_only: "sporades_log_events" }],
        },
        error: null,
      });

      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      const mutatingPragma = await fetch(new URL("/__sporades/debug/db/query", started.data.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sporades-inspection-token": session.inspectionToken,
        },
        body: JSON.stringify({ sql: "PRAGMA user_version = 7" }),
      });
      assert.equal(mutatingPragma.status, 200);
      assert.deepEqual(await mutatingPragma.json(), {
        ok: false,
        data: null,
        error: {
          message: "Only read-only SQL is allowed.",
          hint: "Use a SELECT, WITH, or safe metadata PRAGMA query for `sporades db query`.",
        },
      });

      const userVersion = await runCli(["db", "query", "SELECT * FROM pragma_user_version", "--json"], {
        cwd: projectDir,
      });
      assert.equal(userVersion.code, 0, userVersion.stderr);
      assert.deepEqual(JSON.parse(userVersion.stdout), {
        ok: true,
        data: {
          columns: ["user_version"],
          rows: [{ user_version: 0 }],
        },
        error: null,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("query unsubscribe overtakes delayed initial success and rejection without stale results or reruns", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "delayed-query-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "delayed-query-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, "server", "index.ts"), `import { capsule, message, mutation, query } from "sporades/server";

export default capsule({
  name: "delayed-query-island",
  queries: {
    normal: query(() => [{ complete: true }]),
    delayedSuccess: query(async () => {
      let state = Reflect.get(globalThis, "__sporadesDelayedQueryTest");
      if (!state) { state = { successStarts: 0, failureStarts: 0 }; Reflect.set(globalThis, "__sporadesDelayedQueryTest", state); }
      state.successStarts += 1;
      await new Promise<void>((resolve) => { state.resolveSuccess = resolve; });
      return [{ complete: true }];
    }),
    delayedFailure: query(async () => {
      let state = Reflect.get(globalThis, "__sporadesDelayedQueryTest");
      if (!state) { state = { successStarts: 0, failureStarts: 0 }; Reflect.set(globalThis, "__sporadesDelayedQueryTest", state); }
      state.failureStarts += 1;
      await new Promise<void>((_resolve, reject) => { state.rejectFailure = reject; });
      return [];
    }),
  },
  mutations: { touch: mutation(() => ({ ok: true })) },
  messages: {
    queryStatus: message(() => {
      const state = Reflect.get(globalThis, "__sporadesDelayedQueryTest") ?? { successStarts: 0, failureStarts: 0 };
      return { successStarts: state.successStarts, failureStarts: state.failureStarts };
    }),
    releaseSuccess: message(() => {
      Reflect.get(globalThis, "__sporadesDelayedQueryTest").resolveSuccess();
      return { released: true };
    }),
    rejectFailure: message(() => {
      Reflect.get(globalThis, "__sporadesDelayedQueryTest").rejectFailure(new Error("delayed query exploded"));
      return { rejected: true };
    }),
  },
});
`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    let control;
    try {
      const started = await waitForJsonLine(child);
      socket = await openSocket(started.data.url);
      control = await openSocket(started.data.url);
      let controlId = 0;
      const sendControl = async (name) => {
        const id = `control-${controlId++}`;
        control.send(JSON.stringify({ id, type: "app.send", message: name, data: null }));
        const response = await readSocketMessage(control);
        assert.equal(response.id, id);
        assert.equal(response.error, null, JSON.stringify(response.error));
        return response.data;
      };
      const waitForStarts = async (field) => {
        const deadline = Date.now() + 3000;
        let lastStatus = null;
        while (Date.now() < deadline) {
          const status = await sendControl("queryStatus");
          lastStatus = status;
          if (status[field] === 1) return status;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for ${field}: ${JSON.stringify(lastStatus)}`);
      };
      const assertNoStaleQueryBeforeAuth = async (id) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        socket.send(JSON.stringify({ id, type: "auth.get" }));
        const next = await readSocketMessage(socket);
        assert.equal(next.id, id, "a stale delayed query result or error reached the connection");
        assert.equal(next.type, "auth.result");
      };

      socket.send(JSON.stringify({ id: "normal", type: "query.subscribe", query: "normal" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "normal",
        type: "query.result",
        query: "normal",
        data: [{ complete: true }],
        error: null,
      });
      socket.send(JSON.stringify({ id: "remove-normal", type: "query.unsubscribe", subscriptionId: "normal" }));
      assert.deepEqual((await readSocketMessage(socket)).data, { removed: true });

      socket.send(JSON.stringify({ id: "slow-success", type: "query.subscribe", query: "delayedSuccess" }));
      await waitForStarts("successStarts");
      socket.send(JSON.stringify({ id: "remove-success", type: "query.unsubscribe", subscriptionId: "slow-success" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "remove-success",
        type: "query.unsubscribe.result",
        data: { removed: true },
        error: null,
      });
      assert.deepEqual(await sendControl("releaseSuccess"), { released: true });
      await assertNoStaleQueryBeforeAuth("after-success");

      socket.send(JSON.stringify({ id: "slow-failure", type: "query.subscribe", query: "delayedFailure" }));
      await waitForStarts("failureStarts");
      socket.send(JSON.stringify({ id: "remove-failure", type: "query.unsubscribe", subscriptionId: "slow-failure" }));
      assert.deepEqual((await readSocketMessage(socket)).data, { removed: true });
      assert.deepEqual(await sendControl("rejectFailure"), { rejected: true });
      await assertNoStaleQueryBeforeAuth("after-failure");

      socket.send(JSON.stringify({ id: "touch", type: "mutation.run", mutation: "touch", args: [] }));
      assert.equal((await readSocketMessage(socket)).id, "touch");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(await sendControl("queryStatus"), { successStarts: 1, failureStarts: 1 });
      await assertNoStaleQueryBeforeAuth("after-mutation");
    } finally {
      socket?.close();
      control?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("a scaffolded Campfire awaits database operations from asynchronous Capsule services", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "campfire-async-island", "--template", "campfire", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);

    const projectDir = path.join(dir, "campfire-async-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.services = { database: { kind: "database", engine: "libsql" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir);

    await withFakeLibsqlService(path.join(dir, "campfire-libsql.db"), async ({ url: serviceUrl }) => {
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: { ...docker.env, FAKE_DOCKER_SERVICE_PORT: new URL(serviceUrl).port },
      });
      let socket;
      try {
        await waitForJsonLine(child);
        await waitForJsonEvent(child, (event) => event.data?.event === "service" && event.data.status === "ready");
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        assert.equal(started.ok, true, JSON.stringify(started));
        socket = await openSocket(started.data.url);

        async function request(id, type, details = {}) {
          const response = waitForSocketMessage(socket, (message) => message.id === id);
          socket.send(JSON.stringify({ id, type, ...details }));
          return await response;
        }

        const signup = await request("signup", "auth.signUp", {
          provider: "email",
          credentials: { email: "athos@campfire.example", password: "all-for-one-campfire", name: "Athos" },
        });
        assert.equal(signup.error, null);

        assert.equal((await request("register-1", "mutation.run", { mutation: "registerFixture", args: ["athos"] })).error, null);
        assert.equal((await request("register-2", "mutation.run", { mutation: "registerFixture", args: ["athos"] })).error, null);
        const profiles = await request("profiles", "query.subscribe", { query: "profiles" });
        assert.deepEqual(profiles.data.map(({ key }) => key), ["athos"]);

        const firstSeed = await request("seed-1", "mutation.run", { mutation: "seedCampfire", args: [] });
        const secondSeed = await request("seed-2", "mutation.run", { mutation: "seedCampfire", args: [] });
        assert.deepEqual(
          [firstSeed, secondSeed].map(({ data }) => ({ created: data.created.length, alreadyPresent: data.alreadyPresent.length, failed: data.failed.length })),
          [
            { created: 8, alreadyPresent: 0, failed: 0 },
            { created: 0, alreadyPresent: 8, failed: 0 },
          ],
        );

        const crown = await request("crown", "query.subscribe", { query: "messagesProtectTheCrown" });
        const message = crown.data.find(({ seedKey }) => seedKey === "crown-prompt");
        assert.ok(message);
        const refreshed = waitForSocketMessage(socket, (event) =>
          event.query === "messagesProtectTheCrown"
          && event.data?.some((row) => row.id === message.id && Object.keys(row.reactions).includes(`${signup.data.auth.userId}:up`)));
        const reaction = await request("reaction", "mutation.run", {
          mutation: "toggleReaction",
          args: [{ messageId: message.id, kind: "up" }],
        });
        assert.deepEqual(reaction, { id: "reaction", type: "mutation.result", mutation: "toggleReaction", data: { active: true }, error: null });
        await refreshed;
      } finally {
        socket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("sporades dev rolls back mutation, hook, and pending ACL writes together", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "rollback-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "rollback-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "rollback-island",

  schema: {
    todos: table({
      text: String(),
      ownerId: String(),
    }),
    auditLogs: table({
      text: String(),
      ownerId: String(),
    }).acl({
      insert: async ({ next }) => {
        if (next.text === "deny-fast") {
          return false;
        }
        if (next.text === "allow-slow") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return next.text !== "denied-pending";
      },
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "asc")
        .all()
    ),
    auditLogs: query((ctx) =>
      ctx.db.auditLogs
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "asc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });
    }),
    addThenFail: mutation((ctx) => {
      ctx.db.todos.insert({ text: "custom-partial", ownerId: ctx.auth.userId });
      throw Object.assign(new Error("Custom mutation failed."), {
        hint: "Retry the whole mutation.",
      });
    }),
  },

  hooks: {
    beforeMutation: [
      ({ args, ctx }) => {
        if (args[0] === "before-fails") {
          ctx.db.auditLogs.insert({ text: "before-pending", ownerId: ctx.auth.userId });
          throw Object.assign(new Error("Before hook failed."), {
            hint: "Fix the before hook and retry.",
          });
        }
      },
    ],
    afterMutation: [
      ({ args, ctx }) => {
        if (args[0] === "after-fails") {
          ctx.db.auditLogs.insert({ text: "after-pending", ownerId: ctx.auth.userId });
          throw Object.assign(new Error("After hook failed."), {
            hint: "Fix the after hook and retry.",
          });
        }
        if (args[0] === "denied-pending") {
          ctx.db.auditLogs.insert({ text: "denied-pending", ownerId: ctx.auth.userId });
          return;
        }
        if (args[0] === "mixed-pending") {
          ctx.db.auditLogs.insert({ text: "deny-fast", ownerId: ctx.auth.userId });
          ctx.db.auditLogs.insert({ text: "allow-slow", ownerId: ctx.auth.userId });
          return;
        }
        ctx.db.auditLogs.insert({ text: "after:" + args[0], ownerId: ctx.auth.userId });
      },
    ],
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

      async function runMutationAndRead(id, mutation, args) {
        const result = waitForSocketMessage(socket, (message) => message.id === id && message.type === "mutation.result");
        socket.send(JSON.stringify({ id, type: "mutation.run", mutation, args }));
        return await result;
      }

      async function dumpedTexts(tableName) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
        assert.equal(dumpResult.code, 0, dumpResult.stderr);
        const tables = JSON.parse(dumpResult.stdout).data.tables;
        return tables.find((table) => table.name === tableName).rows.map((row) => row.text);
      }

      assert.deepEqual(await runMutationAndRead("custom-fail", "addThenFail", []), {
        id: "custom-fail",
        type: "mutation.result",
        mutation: "addThenFail",
        data: null,
        error: {
          message: "Custom mutation failed.",
          hint: "Retry the whole mutation.",
        },
      });
      assert.deepEqual(await dumpedTexts("todos"), []);
      assert.deepEqual(await dumpedTexts("auditLogs"), []);

      assert.deepEqual(await runMutationAndRead("before-fail", "addTodo", ["before-fails"]), {
        id: "before-fail",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          message: "Before hook failed.",
          hint: "Fix the before hook and retry.",
        },
      });
      assert.deepEqual(await dumpedTexts("todos"), []);
      assert.deepEqual(await dumpedTexts("auditLogs"), []);

      assert.deepEqual(await runMutationAndRead("after-fail", "addTodo", ["after-fails"]), {
        id: "after-fail",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          message: "After hook failed.",
          hint: "Fix the after hook and retry.",
        },
      });
      assert.deepEqual(await dumpedTexts("todos"), []);
      assert.deepEqual(await dumpedTexts("auditLogs"), []);

      assert.deepEqual(await runMutationAndRead("denied", "addTodo", ["denied-pending"]), {
        id: "denied",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          code: "DENIED",
          message: "Denied.",
          hint: "The current user is not allowed to perform this operation.",
        },
      });
      assert.deepEqual(await dumpedTexts("todos"), []);
      assert.deepEqual(await dumpedTexts("auditLogs"), []);

      assert.deepEqual(await runMutationAndRead("mixed-pending", "addTodo", ["mixed-pending"]), {
        id: "mixed-pending",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          code: "DENIED",
          message: "Denied.",
          hint: "The current user is not allowed to perform this operation.",
        },
      });
      assert.deepEqual(await dumpedTexts("todos"), []);
      assert.deepEqual(await dumpedTexts("auditLogs"), []);

      assert.deepEqual(await runMutationAndRead("retry", "addTodo", ["retry-ok"]), {
        id: "retry",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: null,
      });
      assert.deepEqual(await dumpedTexts("todos"), ["retry-ok"]);
      assert.deepEqual(await dumpedTexts("auditLogs"), ["after:retry-ok"]);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev awaits async mutation handlers and hooks before commit and subscription refresh", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "async-mutation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "async-mutation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "async-mutation-island",

  schema: {
    todos: table({
      text: String(),
      ownerId: String(),
    }),
    auditLogs: table({
      text: String(),
      ownerId: String(),
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "asc")
        .all()
    ),
    auditLogs: query((ctx) =>
      ctx.db.auditLogs
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "asc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation(async (ctx, text: string) => {
      ctx.db.todos.insert({ text: text + ":before-await", ownerId: ctx.auth.userId });
      await Promise.resolve();
      ctx.db.todos.insert({ text: text + ":after-await", ownerId: ctx.auth.userId });
      return { inserted: 2 };
    }),
  },

  hooks: {
    beforeMutation: [
      async ({ ctx }) => {
        await Promise.resolve();
        ctx.db.auditLogs.insert({ text: "before-hook", ownerId: ctx.auth.userId });
      },
    ],
    afterMutation: [
      async ({ ctx, result }) => {
        await Promise.resolve();
        const todoCount = ctx.db.todos.where("ownerId", ctx.auth.userId).all().length;
        ctx.db.auditLogs.insert({
          text: "after-hook:" + result.data.inserted + ":" + todoCount,
          ownerId: ctx.auth.userId,
        });
      },
    ],
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
      socket.send(JSON.stringify({ id: "audits", type: "query.subscribe", query: "auditLogs" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      const mutationResult = waitForSocketMessage(
        socket,
        (message) => message.id === "add" && message.type === "mutation.result",
      );
      const todosRefresh = waitForSocketMessage(
        socket,
        (message) => message.id === "todos" && message.type === "query.result" && message.data.length === 2,
      );
      const auditsRefresh = waitForSocketMessage(
        socket,
        (message) => message.id === "audits" && message.type === "query.result" && message.data.length === 2,
      );
      socket.send(JSON.stringify({ id: "add", type: "mutation.run", mutation: "addTodo", args: ["ship"] }));

      assert.deepEqual(await mutationResult, {
        id: "add",
        type: "mutation.result",
        mutation: "addTodo",
        data: { inserted: 2 },
        error: null,
      });
      assert.deepEqual(
        (await todosRefresh).data.map((todo) => todo.text),
        ["ship:before-await", "ship:after-await"],
      );
      assert.deepEqual(
        (await auditsRefresh).data.map((audit) => audit.text),
        ["before-hook", "after-hook:2:2"],
      );

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      assert.deepEqual(
        tables.find((table) => table.name === "todos").rows.map((row) => row.text),
        ["ship:before-await", "ship:after-await"],
      );
      assert.deepEqual(
        tables.find((table) => table.name === "auditLogs").rows.map((row) => row.text),
        ["before-hook", "after-hook:2:2"],
      );
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev applies Capsule context middleware to WebSocket requests and endpoints", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "middleware-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "middleware-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "TENANT=blue\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "middleware-island",

  schema: {
    todos: table({
      text: String(),
      ownerId: String(),
    }),
    auditLogs: table({
      text: String(),
      ownerId: String(),
    }),
  },

  middleware: [
    (ctx) => ({
      ...ctx,
      tenant: ctx.env.TENANT,
      order: ["first"],
    }),
    (ctx) => {
      if (ctx.request?.headers["x-block"] === "yes") {
        throw Object.assign(new Error("Request blocked by context middleware."), {
          hint: "Remove x-block and retry the request.",
        });
      }
      ctx.db.auditLogs.insert({
        text: ctx.order.concat("second").join(">") + ":" + ctx.tenant + ":" + ctx.kind,
        ownerId: ctx.auth.userId,
      });
      return {
        ...ctx,
        order: ctx.order.concat("second"),
      };
    },
  ],

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    ),
    auditLogs: query((ctx) =>
      ctx.db.auditLogs
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });
    }),
  },

  hooks: {
    afterMutation: [
      ({ ctx }) => {
        ctx.db.auditLogs.insert({
          text: "hook:" + ctx.tenant + ":" + ctx.order.join(">"),
          ownerId: ctx.auth.userId,
        });
      },
    ],
  },

  endpoints: {
    tenant: endpoint({ method: "GET", path: "/tenant" }, (ctx) => ({
      status: 200,
      headers: { "x-order": ctx.order.join(">") },
      body: {
        tenant: ctx.tenant,
        kind: ctx.kind,
      },
    })),
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
      socket.send(JSON.stringify({ id: "auth", type: "auth.get" }));
      const authResult = await readSocketMessage(socket);

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "add", type: "mutation.run", mutation: "addTodo", args: ["from middleware"] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "add",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: null,
      });

      const endpointResponse = await fetch(`${started.data.url}/tenant`, {
        headers: { "x-sporades-session-token": authResult.data.sessionToken },
      });
      assert.equal(endpointResponse.status, 200);
      assert.equal(endpointResponse.headers.get("x-order"), "first>second");
      assert.deepEqual(await endpointResponse.json(), {
        tenant: "blue",
        kind: "endpoint",
      });

      const blockedResponse = await fetch(`${started.data.url}/tenant`, {
        headers: {
          "x-block": "yes",
          "x-sporades-session-token": authResult.data.sessionToken,
        },
      });
      assert.equal(blockedResponse.status, 500);
      assert.deepEqual(await blockedResponse.json(), {
        ok: false,
        data: null,
        error: {
          message: "Request blocked by context middleware.",
          hint: "Remove x-block and retry the request.",
        },
      });

      socket.send(JSON.stringify({ id: "audits", type: "query.subscribe", query: "auditLogs" }));
      const audits = await readSocketMessage(socket);
      const auditTexts = audits.data.map((row) => row.text);
      assert.ok(auditTexts.includes("first>second:blue:endpoint"));
      assert.ok(auditTexts.includes("first>second:blue:mutation"));
      assert.ok(auditTexts.includes("first>second:blue:query"));
      assert.ok(auditTexts.includes("hook:blue:first>second"));
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});
