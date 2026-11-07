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
  TEST_PROCESS_EVENT_TIMEOUT_MS,
  withTempDir,
  getTestAvailablePort,
  snapshotProjectTree,
  runCli,
  startCli,
  installFakeDocker,
  rawHttpStatus,
  waitForJsonLine,
  waitForJsonEvent,
  captureJsonEvents,
  assertDevRefreshDelivery,
  installFakeReact,
  installVue,
  installSvelte,
  sessionState,
  authStub,
  createSvelteTemplate,
  campfireHarnessState,
  litSource,
  createLitTemplate,
  runProjectTsc,
  createInfernoTemplate,
  litCampfireState,
  withFakeGoogleServer,
  withFakeAppleServer,
  withAppleHttpsTunnel,
  openSocket,
  openSocketWithHeaders,
  readSocketMessage,
  captureSocketMessages,
  waitForSocketClose,
  closeSocketGracefully,
  openWebSocket,
  waitForSocketMessage
} from "./support/dev-fixture.js";



test("real Inferno Photo Library publication steps fail closed and recover", async () => {
  for (const [action, steps] of [["Make public", ["publicUrl", "updatePhotoImageUrl", "updatePhotoPublicUrlId", "updatePhotoIsPublic"]], ["Make private", ["revokePublicUrl", "updatePhotoIsPublic", "updatePhotoImageUrl", "updatePhotoPublicUrlId"]]]) for (const failedStep of steps) await withTempDir(async (dir) => {
    const projectDir = await createInfernoTemplate(dir, `inferno-photo-${action.replace(" ", "-")}-${failedStep}`, "photo-library"); let fail = failedStep; const calls = [];
    const photo = { id: "p1", title: "Crown", fileId: "f1", imageUrl: "/crown", ownerName: "Athos", publicUrlId: "u1", isPublic: action === "Make private", status: action === "Make private" ? "public" : "private" };
    const mutation = (name) => ({ async run(...args) { calls.push(name); return fail === name ? { data: null, error: { message: `${name} failed` } } : { data: null, error: null }; } });
    const source = () => litSource({ data: [], error: null, loading: false }); const personalPhotos = litSource({ data: [photo], error: null, loading: false });
    const harness = await mountInfernoTemplate(projectDir, { auth: authStub(), session: litSource({ auth: { userId: "athos", provider: "google", isAuthenticated: true }, providers: {}, error: null, loading: false }), queries: { publicPhotos: source(), personalPhotos }, files: { async publicUrl() { calls.push("publicUrl"); if (fail === "publicUrl") throw new Error("publicUrl failed"); return { id: "u2", url: "/public" }; }, async revokePublicUrl() { calls.push("revokePublicUrl"); if (fail === "revokePublicUrl") throw new Error("revokePublicUrl failed"); } }, mutations: Object.fromEntries(["updatePhotoImageUrl","updatePhotoPublicUrlId","updatePhotoIsPublic","recordPhoto"].map(name=>[name,mutation(name)])) });
    try { const button = () => [...harness.window.document.querySelectorAll("button")].find(node => node.textContent === action); button().click(); await harness.settle(); assert.deepEqual(calls, steps.slice(0, steps.indexOf(failedStep)+1)); assert.match(harness.text(), new RegExp(`${failedStep} failed`)); calls.length=0;fail=null;button().click();await harness.settle();assert.deepEqual(calls,steps);assert.doesNotMatch(harness.text(), / failed/); } finally { await harness.unmount(); }
  });
});


test("real Inferno Campfire fails consent closed before persisting preference", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createInfernoTemplate(dir, "inferno-campfire-consent-error", "campfire"); let preferenceWrites = 0;
    const session = litSource({ auth: { userId: "athos", provider: "email", isAuthenticated: true }, providers: {}, error: null, loading: false });
    const source = () => litSource({ data: [], error: null, loading: false });
    const harness = await mountInfernoTemplate(projectDir, { auth: authStub(), session, queries: { profiles: source(), messagesGeneral: source(), messagesIdeas: source(), messagesRandom: source(), messagesProtectTheCrown: source() }, journey: { async enable() { return { data: null, error: { message: "Consent refused" } }; }, async set() { return { data: null, error: null }; }, async disable() { return { data: null, error: null }; }, subscribe(listener) { listener({ type: "snapshot", states: [] }); return { unsubscribe() {} }; } }, preferences: { async get() { return { data: { preferences: { campfireShareActivity: false } }, error: null }; }, async update() { preferenceWrites += 1; return { data: null, error: null }; } }, mutations: Object.fromEntries(["sendMessage","toggleReaction","seedCampfire","registerFixture"].map(name=>[name,{async run(){return{data:null,error:null};}}])) });
    try { const share = harness.find('input[role="switch"]'); share.checked = true; share.dispatchEvent(new harness.window.Event("change", { bubbles: true })); await harness.settle(); assert.match(harness.text(), /Consent refused/); assert.equal(preferenceWrites, 0); assert.equal(share.checked, false); } finally { await harness.unmount(); }
  });
});


test("real Inferno Campfire retires stale preference restore without touching its successor", async () => {
  await withTempDir(async dir=>{const projectDir=await createInfernoTemplate(dir,"inferno-campfire-stale-restore","campfire",{toolchain:"vite"});const calls=[];let currentUser="athos",release,started;const firstSet=new Promise(r=>started=r);let count=0;const state=litCampfireState(calls,{async set(v){calls.push(["journey.set",v,currentUser]);if(++count===1){started();await new Promise(r=>release=r);}return{data:null,error:null};}});state.queries.profiles=litSource({data:null,error:null,loading:false});state.session=litSource({...sessionState(),loading:false,auth:{userId:currentUser,provider:"email",isAuthenticated:true}});state.preferences.get=async()=>{calls.push(["preferences.get",currentUser]);return{data:{preferences:{campfireShareActivity:currentUser==="athos"}},error:null};};const harness=await mountInfernoTemplate(projectDir,state);try{await firstSet;currentUser="porthos";state.session.publish({...sessionState(),loading:false,auth:{userId:currentUser,provider:"email",isAuthenticated:true}});await harness.settle();release();await harness.settle();assert.equal(harness.find('input[role="switch"]').checked,false);assert.equal(calls.filter(([n])=>n==="journey.disable").length,1);assert.equal(calls.filter(([n,_v,u])=>n==="journey.set"&&u==="porthos").length,0);assert(calls.some(([n,u])=>n==="preferences.get"&&u==="porthos"));}finally{await harness.unmount();}});
});


for(const failureStage of ["journey.set","preferences.update"])test(`real Inferno Campfire recovers from structured ${failureStage} failure`,async()=>{await withTempDir(async dir=>{const projectDir=await createInfernoTemplate(dir,`inferno-campfire-error-${failureStage.replace(".","-")}`,"campfire");const calls=[];let fail=true;const state=litCampfireState(calls,{async set(v){calls.push(["journey.set",v]);return fail&&failureStage==="journey.set"?{data:null,error:{message:"Journey publication failed"}}:{data:null,error:null};}});state.queries.profiles=litSource({data:null,error:null,loading:false});state.session=litSource({...sessionState(),loading:false,auth:{userId:"athos",provider:"email",isAuthenticated:true}});state.preferences.get=async()=>({data:{preferences:{campfireShareActivity:false}},error:null});state.preferences.update=async v=>{calls.push(["preferences.update",v]);return fail&&failureStage==="preferences.update"?{data:null,error:{message:"Preference save failed"}}:{data:{preferences:v},error:null};};const harness=await mountInfernoTemplate(projectDir,state);const enable=async()=>{const share=harness.find('input[role="switch"]');share.checked=true;share.dispatchEvent(new harness.window.Event("change",{bubbles:true}));await harness.settle();};try{await enable();assert.equal(harness.find('input[role="switch"]').checked,false);assert.match(harness.text(),failureStage==="journey.set"?/Journey publication failed/:/Preference save failed/);assert.equal(calls.filter(([n])=>n==="journey.disable").length,1);if(failureStage==="journey.set")assert.equal(calls.some(([n])=>n==="preferences.update"),false);fail=false;await enable();assert.equal(harness.find('input[role="switch"]').checked,true);assert.doesNotMatch(harness.text(),/publication failed|Preference save failed/);}finally{await harness.unmount();}});});


test("every generated Lit template passes its emitted strict TypeScript project", async () => {
  for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) await withTempDir(async (dir) => {
    const projectDir = await createLitTemplate(dir, `lit-strict-${template}`, template);
    const result = await runProjectTsc(projectDir);
    assert.equal(result.code, 0, `${template}\n${result.stdout}\n${result.stderr}`);
  });
});


test("real Lit Campfire renews typing and cancels it exactly on channel change and disconnect", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createLitTemplate(dir, "lit-campfire-typing-cleanup", "campfire");
    const calls = [], state = litCampfireState(calls); state.session = litSource({ ...sessionState(), loading: false, auth: { userId: "athos", provider: "email", isGuest: false, isAuthenticated: true } });
    const harness = await mountLitTemplate(projectDir, state);
    const typingCount = () => calls.filter(([name, value]) => name === "journey.set" && value?.status === "typing").length;
    try {
      await harness.settle(); let input = harness.find("#message"); input.value = "Still typing"; input.dispatchEvent(new harness.window.Event("input", { bubbles: true })); await harness.settle(); const immediate = typingCount(); assert(immediate >= 1);
      await new Promise((resolve) => setTimeout(resolve, 2600)); assert(typingCount() > immediate, "active typing renews before its four-second TTL");
      const ideas = [...harness.element.shadowRoot.querySelectorAll("nav button")].find((button) => button.textContent.includes("ideas")); ideas.dispatchEvent(new harness.window.Event("click", { bubbles: true })); await harness.settle(); const afterChannel = typingCount(); await new Promise((resolve) => setTimeout(resolve, 2600)); assert.equal(typingCount(), afterChannel, "channel change cancels the old renewal timer");
      input = harness.find("#message"); input.value = "New channel typing"; input.dispatchEvent(new harness.window.Event("input", { bubbles: true })); await harness.settle(); const beforeDisconnect = typingCount(); await harness.disconnect(); await new Promise((resolve) => setTimeout(resolve, 2600)); assert.equal(typingCount(), beforeDisconnect, "disconnect cancels renewal exactly");
    } finally { await harness.unmount(); }
  });
});


// The module-graph server bundle, driven the way a released CLI drives it.
//
// This ran under `SPORADES_SERVER_BUNDLE_MODULE_GRAPH=1` while a second builder existed, and it was
// the only test in this file that exercised the module graph. Ticket 05 deleted the other builder,
// so every test here drives this path now and the variable is gone. The test is kept all the same,
// for the reason below, which no other test in this file covers.
//
// It runs through `bin/sporades.js` on purpose. That file is what `scripts/build-bin.mjs` produces,
// and esbuild rewrites `import.meta.url` for the bundle's entry point only — so a module-graph
// builder that located its entry relative to its own `import.meta.url` would resolve next to `bin/`
// and die with ENOENT here, while passing every test that imported it from `dist/`. Calling the
// builder directly cannot catch that; running the CLI can.
test("sporades dev bundles and serves a Capsule built from the runtime module graph", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "graph-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "graph-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(started.data.event, "started");

      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      // esbuild labels each inlined module with its path. The deleted builder opened with a
      // `// Sporades server bundle` banner and had no such labels, so this pair still distinguishes
      // the two — worth keeping as the check that a released CLI resolved the entry under `dist/`
      // and bundled a graph, rather than falling back to anything else.
      assert.match(serverBundle, /\/\/ dist\/templates\/server-bundle-entry\.js/);
      assert.doesNotMatch(serverBundle, /^\/\/ Sporades server bundle/);
      assert.match(serverBundle, /graph-island/);

      const rootResponse = await fetch(started.data.url);
      assert.equal(rootResponse.status, 200);
      assert.match(await rootResponse.text(), /<script type="module" src="\/client\.js"><\/script>/);

      // `sporades dev` serves from an in-process runtime, so the assertions above prove the CLI
      // *built* the module-graph bundle, not that it runs. `sporades jobs` against a live Dev
      // session is the CLI path that executes the built artifact: it spawns
      // `.sporades/build/server.mjs --sporades-action jobs.inspect`. A bundle that could not boot
      // answers nothing here.
      const jobs = await runCli(["jobs"], { cwd: projectDir });
      assert.equal(jobs.code, 0, jobs.stderr || jobs.stdout);
      assert.deepEqual(JSON.parse(jobs.stdout), {
        ok: true,
        data: { capsule: { name: "graph-island" }, jobs: [] },
        error: null,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev builds and safely serves the normalized public tree", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "public-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "public-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const publicTreesDir = path.join(projectDir, ".sporades", "build", ".public-trees");
      const publicTreeNames = (await readdir(publicTreesDir)).filter((name) => !name.startsWith(".") && name !== "active.json");
      assert.equal(publicTreeNames.length, 1);
      const publicDir = path.join(publicTreesDir, publicTreeNames[0]);
      const sourceHtml = await readFile(path.join(projectDir, "index.html"), "utf8");
      assert.equal(await readFile(path.join(publicDir, "index.html"), "utf8"), sourceHtml);
      assert.equal(await readFile(path.join(publicDir, "client.js"), "utf8"), await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8"));

      const unmarkedHtml = await (await fetch(started.data.url)).text();
      assert.doesNotMatch(unmarkedHtml, /__SPORADES_CONNECTION_TOKEN/);
      const servedResponse = await fetch(started.data.url, { headers: { "sec-fetch-dest": "document" } });
      assert.equal(servedResponse.headers.get("cache-control"), "no-store");
      const servedHtml = await servedResponse.text();
      assert.match(servedHtml, /window\.__SPORADES_CONNECTION_TOKEN=/);
      assert.doesNotMatch(sourceHtml, /__SPORADES_CONNECTION_TOKEN/);
      const pageToken = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(servedHtml)?.[1];
      const refreshedTokenResponse = await fetch(new URL("/__sporades/connection-token", started.data.url), {
        headers: { "x-sporades-connection-token-request": "1" },
      });
      assert.equal(refreshedTokenResponse.status, 200);
      assert.equal(refreshedTokenResponse.headers.get("cache-control"), "no-store");
      const refreshedToken = (await refreshedTokenResponse.json()).token;
      assert.equal(typeof refreshedToken, "string");
      assert.ok(refreshedToken.length > 0);
      assert.notEqual(refreshedToken, pageToken);

      await writeFile(path.join(projectDir, "outside.css"), "body { color: red; }\n");
      await rm(path.join(publicDir, "client.js"));
      await symlink(path.join(projectDir, "outside.css"), path.join(publicDir, "client.js"));
      assert.doesNotMatch(await (await fetch(`${started.data.url}/client.js`)).text(), /color: red/);

      assert.equal((await fetch(`${started.data.url}/assets/missing.css`)).status, 404);
      assert.equal((await fetch(`${started.data.url}/%2e%2e/sporades.json`)).status, 404);
      assert.equal(await rawHttpStatus(started.data.url, "/assets/%2e%2e/client.js"), 404);
      assert.equal(await rawHttpStatus(started.data.url, "/assets%2fmissing.css"), 404);
      assert.equal((await fetch(`${started.data.url}/assets%2f..%2f..%2fsporades.json`)).status, 404);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("Svelte Photo Library keeps authenticated uploads private and drives explicit publication", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createSvelteTemplate(dir, "svelte-photo-behavior", "photo-library");
    const calls = [];
    let failPhotoMutation = null;
    const photo = { id: "photo-private", title: "Secret crown", status: "private", fileId: "file-private", imageUrl: "", publicUrlId: "", isPublic: false };
    const personal = { loading: false, data: [photo], error: null };
    const mutation = (name) => ({ loading: false, error: null, async run(...args) {
      calls.push([name, ...args]);
      if (name === failPhotoMutation) return { data: null, error: new Error("Photo mutation failed") };
      if (name === "updatePhotoIsPublic") photo.isPublic = args[1];
      if (name === "updatePhotoPublicUrlId") photo.publicUrlId = args[1];
      if (name === "updatePhotoImageUrl") photo.imageUrl = args[1];
      globalThis.__SPORADES_SVELTE_TEMPLATE_HARNESS__.controls.queries.personalPhotos.set({ ...personal, data: [{ ...photo }] });
      return { data: null, error: null };
    } });
    const mutations = Object.fromEntries(["recordPhoto", "updatePhotoIsPublic", "updatePhotoImageUrl", "updatePhotoPublicUrlId"].map((name) => [name, mutation(name)]));
    const harness = await mountSvelteTemplate(projectDir, {
      session: sessionState(), queries: { publicPhotos: { loading: false, data: [], error: null }, personalPhotos: personal }, mutations,
      auth: authStub(), journey: {}, preferences: {},
      files: {
        async upload(file) { calls.push(["upload", file.name]); return { id: `file-${file.name}`, name: file.name, type: file.type, size: file.size }; },
        async publicUrl(fileId) { calls.push(["publicUrl", fileId]); return { id: `url-${fileId}`, url: `https://files.example/${fileId}` }; },
        async revokePublicUrl(id) { calls.push(["revokePublicUrl", id]); return { data: null, error: null }; },
      },
    });
    try {
      const fileInput = harness.find('input[type="file"]');
      await harness.trigger(fileInput, "change", { files: [{ name: "guest.png", type: "image/png", size: 10 }] });
      await harness.trigger(harness.find("form"), "submit");
      assert(calls.some(([name]) => name === "publicUrl"));

      calls.length = 0;
      harness.setSession({ ...sessionState(), auth: { userId: "google-user", provider: "google", displayName: "Aramis", isGuest: false } });
      await harness.settle();
      await harness.trigger(fileInput, "change", { files: [{ name: "private.png", type: "image/png", size: 11 }] });
      await harness.trigger(harness.find("form"), "submit");
      assert(calls.some(([name]) => name === "upload"));
      assert.equal(calls.some(([name]) => name === "publicUrl"), false);
      assert.match(harness.text(), /Photo saved privately.*My library.*Secret crown/s);

      calls.length = 0;
      await harness.trigger([...harness.findAll("button")].find((button) => button.textContent === "Make public"), "click");
      assert.deepEqual(calls.map(([name]) => name), ["publicUrl", "updatePhotoImageUrl", "updatePhotoPublicUrlId", "updatePhotoIsPublic"]);
      calls.length = 0;
      await harness.trigger([...harness.findAll("button")].find((button) => button.textContent === "Make private"), "click");
      assert.deepEqual(calls.map(([name]) => name), ["revokePublicUrl", "updatePhotoIsPublic", "updatePhotoImageUrl", "updatePhotoPublicUrlId"]);
      calls.length = 0;
      failPhotoMutation = "updatePhotoImageUrl";
      await harness.trigger([...harness.findAll("button")].find((button) => button.textContent === "Make public"), "click");
      assert.match(harness.text(), /Photo mutation failed/, "structured publication errors render instead of being ignored");
      assert.doesNotMatch(harness.text(), /dummy-secret|GOOGLE_CLIENT_SECRET|credential/i);
    } finally { await harness.unmount(); }
  });
});


test("Svelte Campfire executes messages, preferences, consented TTL activity, and same-store cleanup", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createSvelteTemplate(dir, "svelte-campfire-behavior", "campfire");
    const calls = [];
    let journeySubscriber = () => {};
    const state = campfireHarnessState(calls, { subscribe(callback) { journeySubscriber = callback; return { unsubscribe() { calls.push(["unsubscribe"]); } }; } });
    let finishSend;
    state.mutations.sendMessage.run = async (input) => {
      calls.push(["sendMessage", input]);
      return await new Promise((resolve) => { finishSend = resolve; });
    };
    state.session.auth = { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false };
    const harness = await mountSvelteTemplate(projectDir, state);
    try {
      assert(calls.some(([name]) => name === "preferences.get"));
      assert(calls.some(([name, value]) => name === "journey.set" && value.status === "reading" && value.ttlSeconds === 12));
      assert.equal(harness.find('input[type="checkbox"]').checked, true);
      assert.equal(harness.state.counts.session.started, 2, "auto-subscription and identity watcher share one store identity");

      journeySubscriber({ data: { type: "snapshot", states: [{ sessionId: "p1", userId: "porthos-user", status: "reading", metadata: { channel: "ideas" } }] } });
      await harness.settle();
      assert.match(harness.text(), /A Musketeer is reading #ideas/);
      await harness.setValue(harness.find("#message"), "Protect the crown");
      assert(calls.some(([name, value]) => name === "journey.set" && value.status === "typing" && value.ttlSeconds === 4));
      await harness.trigger(harness.find("form"), "submit");
      assert(calls.some(([name, input]) => name === "sendMessage" && input.body === "Protect the crown"));
      assert.equal(harness.find("form button").disabled, true, "mutation loading state disables duplicate sends");
      finishSend({ data: null, error: null });
      await harness.settle();
      assert(calls.some(([name, value]) => name === "journey.set" && value.status === "posted" && value.ttlSeconds === 8));
      await harness.setValue(harness.find("#message"), "Fail safely");
      await harness.trigger(harness.find("form"), "submit");
      finishSend({ data: null, error: new Error("Message rejected") });
      await harness.settle();
      assert.match(harness.text(), /Message rejected/, "structured mutation errors render through the component");
      const share = harness.find('input[type="checkbox"]');
      await harness.trigger(share, "change", { checked: false });
      assert(calls.some(([name, value]) => name === "preferences.update" && value.campfireShareActivity === false));
      harness.setSession({ ...sessionState(), auth: { userId: "porthos-user", provider: "email", displayName: "Porthos", isGuest: false } });
      await harness.settle();
      assert(calls.some(([name]) => name === "journey.disable"));
    } finally {
      await harness.unmount();
      assert.equal(harness.state.counts.session.active, 0);
      assert.equal(harness.state.counts.session.stopped, 2, "both same-store subscriptions dispose deterministically");
    }
  });
});


test("Svelte Campfire serializes direct consent against an auth successor", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createSvelteTemplate(dir, "svelte-campfire-race", "campfire");
    const calls = [];
    let releaseEnable;
    let markEnableStarted;
    const enableStarted = new Promise((resolve) => { markEnableStarted = resolve; });
    const state = campfireHarnessState(calls, {
      async enable(options) {
        const userId = globalThis.__SPORADES_SVELTE_TEMPLATE_HARNESS__.controls.session.get().auth?.userId;
        calls.push(["journey.enable", options, userId]);
        markEnableStarted();
        await new Promise((resolve) => { releaseEnable = resolve; });
        return { data: null, error: null };
      },
    });
    state.session.auth = { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false };
    state.preferences.get = async () => ({ data: { preferences: { campfireShareActivity: false } }, error: null });
    const harness = await mountSvelteTemplate(projectDir, state);
    try {
      const share = harness.find('input[type="checkbox"]');
      await harness.trigger(share, "change", { checked: true });
      await enableStarted;
      harness.setSession({ ...sessionState(), auth: { userId: "porthos-user", provider: "email", displayName: "Porthos", isGuest: false } });
      await harness.settle();
      assert.equal(share.checked, false);
      releaseEnable();
      await harness.settle();
      assert.equal(share.checked, false);
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, 1);
      assert.equal(calls.some(([name]) => name === "preferences.update"), false);
    } finally { await harness.unmount(); }
  });
});


test("Vue Vite fails closed for missing, unsupported, and unloadable project compiler packages", async () => {
  for (const scenario of ["missing", "version", "load"]) {
    await withTempDir(async (dir) => {
      const created = await runCli(["create", `vue-compiler-${scenario}`, "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(created.code, 0, created.stderr);
      const projectDir = path.join(dir, `vue-compiler-${scenario}`);
      if (scenario !== "missing") {
        if (scenario === "load") await installVue(projectDir);
        const pluginDir = path.join(projectDir, "node_modules", "@vitejs", "plugin-vue");
        await rm(pluginDir, { recursive: true, force: true });
        await mkdir(pluginDir, { recursive: true });
        await writeFile(path.join(pluginDir, "package.json"), `${JSON.stringify({
          name: "@vitejs/plugin-vue",
          version: scenario === "version" ? "6.0.0" : "5.2.4",
          type: "module",
          main: "./index.js",
        })}\n`);
        await writeFile(path.join(pluginDir, "index.js"), 'throw new Error("project-plugin-load-failure");\n');
      }
      const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
      await assert.rejects(createBundle(projectDir, config), (error) => {
        assert.equal(error.phase, "client");
        assert.equal(error.framework, "vue");
        assert.equal(error.toolchain, "vite");
        assert.match(error.hint, /npm install.*@vitejs\/plugin-vue.*@vue\/compiler-sfc/i);
        if (scenario === "missing") assert.match(error.message, /node_modules.*real directory.*Capsule project/i);
        if (scenario === "version") assert.match(error.message, /does not support.*@vitejs\/plugin-vue version/i);
        if (scenario === "load") assert.match(error.message, /could not load project-owned @vitejs\/plugin-vue.*project-plugin-load-failure/i);
        assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostics: error.diagnostics, stack: error.stack }), new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      });
    });
  }
});


for (const template of ["blank", "todo"]) test(`Solid Vite compiles the ${template} Capsule with project-owned compiler packages in an isolated normalized tree`, async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", `solid-${template}-build`, "--framework", "solid", "--template", template, "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, `solid-${template}-build`);
    await installProjectSolidToolchain(projectDir, repoRoot);
    await writeFile(path.join(projectDir, ".env"), "VITE_SOLID_LEAK=solid-browser-secret\n");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SOLID_SERVER_ONLY=solid-server-secret\n");
    await writeFile(path.join(projectDir, "vite.config.ts"), 'export default { plugins: [{ name: "solid-vite-config-loaded" }] };\n');
    await writeFile(path.join(projectDir, "postcss.config.cjs"), 'throw new Error("solid-postcss-config-loaded");\n');
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    const bundle = await createBundle(projectDir, config, { publishLegacy: false });
    try {
      const files = Object.keys(await snapshotProjectTree(bundle.staticFiles.publicDir)).filter((file) => !file.endsWith("/"));
      assert(files.includes("index.html"), JSON.stringify(files));
      assert(files.some((file) => /^assets\/index-[^/]+\.js$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => /^assets\/index-[^/]+\.css$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => /^assets\/sporades-mark-[^/]+\.svg$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => file.endsWith(".js.map")), JSON.stringify(files));
      assert.equal(files.includes("client.js"), false);
      const output = (await Promise.all(files.map((file) => readFile(path.join(bundle.staticFiles.publicDir, file), "utf8")))).join("\n");
      assert.match(output, template === "todo" ? /Sporades Todos/ : /Blank Sporades Capsule/);
      assert.doesNotMatch(output, /solid-(?:browser|server)-secret|solid-(?:vite|postcss)-config-loaded|SOLID_SERVER_ONLY/);
      assert.doesNotMatch(output, /react-dom|react\/jsx-runtime|\/@vite\/client|react-refresh|vite\/hmr/i);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});


test("Vue Vite rejects a symlinked node_modules root before resolving compiler packages", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "vue-external-node-modules", "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vue-external-node-modules");
    await symlink(path.join(repoRoot, "node_modules"), path.join(projectDir, "node_modules"));
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    await assert.rejects(createBundle(projectDir, config), (error) => {
      assert.match(error.message, /node_modules.*real directory.*Capsule project/i);
      assert.match(error.hint, /npm install/i);
      assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostics: error.diagnostics }), new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
    await assert.rejects(access(path.join(projectDir, ".sporades")), (error) => error.code === "ENOENT");
  });
});


test("prerender warnings appear in human and structured Dev diagnostics", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "prerender-warnings", "--framework", "react", "--toolchain", "vite", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "prerender-warnings");
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.client.prerender = [{ name: "landing", module: "render.mjs" }, { name: "unused", module: "render.mjs" }];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(projectDir, "render.mjs"), 'export default () => "<main>Static shell</main>";');
    const htmlPath = path.join(projectDir, "index.html");
    const original = await readFile(htmlPath, "utf8");
    await writeFile(htmlPath, original.replace('<body>', '<body><!-- sporades:prerender landing --><!-- sporades:prerender landing --><!-- sporades:prerender typo -->'));
    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      assert.deepEqual(started.data.warnings.map((warning) => warning.code), ['PRERENDER_UNKNOWN_MARKER', 'PRERENDER_DUPLICATE_PLACEMENT', 'PRERENDER_UNUSED_FRAGMENT']);
      const rebuilt = waitForJsonEvent(child, (event) => event.data.event === 'rebuild' && event.data.status === 'success');
      await writeFile(htmlPath, original.replace('<body>', '<body><!-- sporades:prerender typo -->'));
      assert.deepEqual((await rebuilt).data.warnings.map((warning) => warning.code), ['PRERENDER_UNKNOWN_MARKER', 'PRERENDER_UNUSED_FRAGMENT', 'PRERENDER_UNUSED_FRAGMENT']);
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    const human = startCli(["dev"], { cwd: projectDir });
    try {
      const output = await new Promise((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error(text)), TEST_PROCESS_EVENT_TIMEOUT_MS);
        human.stdout.on('data', (chunk) => {
          text += chunk;
          if (text.includes('Use Ctrl-C to exit')) { clearTimeout(timer); resolve(text); }
        });
        human.once('error', reject);
      });
      assert.match(output, /Warning \[PRERENDER_UNKNOWN_MARKER\]: Unknown prerender marker "typo"/);
      assert.match(output, /Warning \[PRERENDER_UNUSED_FRAGMENT\]: Configured prerender fragment "landing"/);
    } finally {
      const exited = new Promise((resolve) => human.once('exit', resolve));
      human.kill('SIGTERM');
      await exited;
    }
  });
});


for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) test(`sporades dev preserves last-good Solid ${template} output and recovers through acknowledged refresh`, async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", `solid-${template}-dev`, "--template", template, "--framework", "solid", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, `solid-${template}-dev`);
    await installProjectSolidToolchain(projectDir, repoRoot);
    if (template === "photo-library") await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const appPath = path.join(projectDir, "client", "App.tsx");
    const original = await readFile(appPath, "utf8");
    const child = startCli(["dev", "--json"], { cwd: projectDir });
    const events = captureJsonEvents(child);
    let socket, messages;
    try {
      const scrub = (html) => html.replace(/window\.__SPORADES_CONNECTION_TOKEN="[^"]+"/, 'window.__SPORADES_CONNECTION_TOKEN="<token>"');
      const started = await events.next((event) => event.ok && event.data?.event === "started");
      const initialHtml = scrub(await (await fetch(started.data.url)).text());
      socket = await openSocket(started.data.url);
      messages = captureSocketMessages(socket);
      socket.send(JSON.stringify({ id: "solid-dev-ready", type: "dev.refresh.subscribe" }));
      assert.deepEqual(await messages.next((message) => message.id === "solid-dev-ready"), {
        id: "solid-dev-ready", type: "dev.refresh.ready", data: { mode: "full-page", sequence: 0 }, error: null,
      });

      const rebuiltRefresh = messages.next((message) => message.type === "refresh");
      await writeFile(appPath, original.replace("</main>", '<p data-dev-probe="rebuilt">Solid rebuilt</p></main>'));
      const rebuiltMessage = await rebuiltRefresh;
      assert.deepEqual(rebuiltMessage, { id: null, type: "refresh", data: { mode: "full-page", sequence: 1 }, error: null });
      assert.equal(events.events.some((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success"), false);
      socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: 1 }));
      const rebuilt = await events.next((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(rebuilt.data.build, { phase: "client", framework: "solid", toolchain: "vite" });
      assertDevRefreshDelivery(rebuilt.data.refresh, 1);
      const lastGood = scrub(await (await fetch(started.data.url)).text());
      assert.notEqual(lastGood, initialHtml);

      await writeFile(appPath, "export default function App() { return <main>{</main>; }\n");
      const failed = await events.next((event) => !event.ok && event.data?.event === "rebuild");
      assert.deepEqual(failed.data.build, { phase: "client", framework: "solid", toolchain: "vite" });
      assert.match(failed.error.message, /Client bundle failed/);
      assert.match(failed.error.hint, /SolidJS\/Vite client source/);
      assert(JSON.stringify(failed).length < 4096);
      assert.doesNotMatch(JSON.stringify(failed), new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(scrub(await (await fetch(started.data.url)).text()), lastGood);

      const recoveredRefresh = messages.next((message) => message.type === "refresh");
      await writeFile(appPath, original.replace("</main>", '<p data-dev-probe="recovered">Solid recovered</p></main>'));
      const recoveredMessage = await recoveredRefresh;
      assert.equal(recoveredMessage.data.sequence, 2);
      socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: 2 }));
      const recovered = await events.next((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(recovered.data.build, { phase: "client", framework: "solid", toolchain: "vite" });
      assertDevRefreshDelivery(recovered.data.refresh, 2);
    } finally {
      messages?.dispose();
      await closeSocketGracefully(socket);
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      events.dispose();
    }
  });
});


test("Dev refresh delivery reports bounded timeout and disconnect outcomes without hanging the watcher", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "svelte-refresh-partial", "--framework", "svelte", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "svelte-refresh-partial");
    await installSvelte(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const appPath = path.join(projectDir, "client", "App.svelte");
    const original = await readFile(appPath, "utf8");
    const child = startCli(["dev", "--json"], { cwd: projectDir });
    const events = captureJsonEvents(child);
    const sockets = [];
    const captures = [];
    try {
      const started = await events.next((event) => event.ok && event.data?.event === "started");
      for (const id of ["timeout", "disconnect"]) {
        const socket = await openSocket(started.data.url);
        const capture = captureSocketMessages(socket);
        sockets.push(socket); captures.push(capture);
        socket.send(JSON.stringify({ id, type: "dev.refresh.subscribe" }));
        await capture.next((message) => message.id === id && message.type === "dev.refresh.ready");
      }
      await writeFile(appPath, original.replace("</main>", "<p>Partial refresh delivery</p></main>"));
      await Promise.all(captures.map((capture) => capture.next((message) => message.type === "refresh")));
      sockets[1].close();
      const resent = await captures[0].next((message) => message.type === "refresh");
      assert.equal(resent.data.sequence, 1, "an unacknowledged sequence is resent without advancing");
      const rebuilt = await events.next((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.equal(rebuilt.data.refresh.sequence, 1);
      assert.equal(rebuilt.data.refresh.clientsAttempted, 2);
      assert.equal(rebuilt.data.refresh.clientsDelivered, 0);
      assert.equal(rebuilt.data.refresh.clientsTimedOut, 1);
      assert.equal(rebuilt.data.refresh.clientsDisconnected, 1);
      assert(rebuilt.data.refresh.framesAttempted >= 3, JSON.stringify(rebuilt.data.refresh));
    } finally {
      captures.forEach((capture) => capture.dispose());
      await Promise.all(sockets.map(closeSocketGracefully));
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      events.dispose();
    }
  });
});


test("sporades dev does not activate a client tree when legacy Bundle publication fails", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "publish-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "publish-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      const before = await (await fetch(`${started.data.url}/client.js`)).text();
      const legacyClientPath = path.join(projectDir, ".sporades", "build", "client.js");
      const legacyClientBefore = await readFile(legacyClientPath, "utf8");
      const serverBundle = path.join(projectDir, ".sporades", "build", "server.mjs");
      const savedServerBundle = `${serverBundle}.saved`;
      await rename(serverBundle, savedServerBundle);
      await mkdir(serverBundle);

      const clientPath = path.join(projectDir, "client", "index.tsx");
      const clientSource = await readFile(clientPath, "utf8");
      await writeFile(clientPath, clientSource.replace("Blank Sporades Capsule", "Leaked Candidate Capsule"));
      const failed = await waitForJsonEvent(child, (event) => !event.ok && event.data.event === "rebuild");
      assert.deepEqual(failed.data.build, { phase: "publish", framework: "react", toolchain: "esbuild" });
      assert.match(failed.error.message, /EISDIR|directory/i);
      assert.equal(await (await fetch(`${started.data.url}/client.js`)).text(), before);
      assert.equal(await readFile(legacyClientPath, "utf8"), legacyClientBefore);
      const treeNames = (await readdir(path.join(projectDir, ".sporades", "build", ".public-trees"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
      assert.equal(treeNames.length, 1);

      await rm(serverBundle, { recursive: true });
      await rename(savedServerBundle, serverBundle);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev bundles and serves a scaffolded React photo library capsule", async () => {
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
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      assert.equal(started.ok, true, JSON.stringify(started.error));
      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.match(serverBundle, /recordPhoto/);
      assert.match(serverBundle, /personalPhotos/);
      assert.match(clientBundle, /Photo Library/);
      assert.match(clientBundle, /upload\(/);
      assert.match(clientBundle, /runtimeAvailable/);
      assert.doesNotMatch(clientBundle, /better-auth|googleapis|gapi|accounts\.google/);

      const rootResponse = await fetch(started.data.url);
      assert.equal(rootResponse.status, 200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev applies default security headers and local-only CORS", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "secure-dev-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "secure-dev-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "secure-dev-island",

  endpoints: {
    ping: endpoint({ method: "POST", path: "/integrations/ping" }, () => ({ body: { ok: true } })),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      assert.deepEqual(started.data.security.cors.allowedOriginPatterns, ["http://localhost:*", "http://127.0.0.1:*"]);
      assert.equal(started.data.security.cors.publicDev, false);

      const rootResponse = await fetch(`${started.data.url}/`, {
        headers: { origin: "http://localhost:5173" },
      });
      assert.equal(rootResponse.headers.get("access-control-allow-origin"), "http://localhost:5173");
      assert.equal(rootResponse.headers.get("x-content-type-options"), "nosniff");
      assert.equal(rootResponse.headers.get("referrer-policy"), "no-referrer");
      assert.equal(rootResponse.headers.get("x-frame-options"), "DENY");
      assert.equal(rootResponse.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.match(rootResponse.headers.get("permissions-policy") ?? "", /camera=\(\)/);
      assert.match(rootResponse.headers.get("content-security-policy-report-only") ?? "", /default-src 'self'/);
      assert.equal(rootResponse.headers.get("content-security-policy"), null);
      assert.equal(rootResponse.headers.get("x-powered-by"), null);
      assert.equal(rootResponse.headers.get("server"), null);

      const endpointResponse = await fetch(`${started.data.url}/integrations/ping`, {
        method: "POST",
        headers: { origin: "https://example.test" },
      });
      assert.equal(endpointResponse.status, 200);
      assert.equal(endpointResponse.headers.get("access-control-allow-origin"), null);

      const preflight = await fetch(`${started.data.url}/integrations/ping`, {
        method: "OPTIONS",
        headers: {
          origin: "http://127.0.0.1:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-sporades-session-token",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
      assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /x-sporades-session-token/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades auth clients --json lists multiple clients whose ids target auth as delivery", async () => {
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
    let firstSocket;
    let secondSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      firstSocket = await openSocket(started.data.url);
      secondSocket = await openSocket(started.data.url);

      const listed = await runCli(["auth", "clients", "--json"], { cwd: projectDir });
      assert.equal(listed.code, 0, listed.stderr);
      const clients = JSON.parse(listed.stdout).data.clients;
      assert.equal(clients.length, 2);
      assert.notEqual(clients[0].id, clients[1].id);
      assert.equal(clients[0].auth.provider, "anonymous");
      assert.equal(clients[1].auth.provider, "anonymous");

      const deliveredToFirst = readSocketMessage(firstSocket);
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
          clients[0].id,
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const body = JSON.parse(simulated.stdout);
      assert.deepEqual(body.data.delivery, {
        target: clients[0].id,
        delivered: true,
        clients: 1,
      });
      assert.equal((await deliveredToFirst).type, "auth.session.replace");

      firstSocket.send(JSON.stringify({ id: "first-auth", type: "auth.get" }));
      secondSocket.send(JSON.stringify({ id: "second-auth", type: "auth.get" }));
      const firstAuth = await waitForSocketMessage(firstSocket, (message) => message.id === "first-auth");
      const secondAuth = await waitForSocketMessage(secondSocket, (message) => message.id === "second-auth");
      assert.deepEqual(firstAuth.data.auth, body.data.auth);
      assert.equal(secondAuth.data.auth.provider, "anonymous");
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev keeps existing WebSocket clients connected across client-only rebuilds", async () => {
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
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const authBefore = await readSocketMessage(socket);

      const clientPath = path.join(projectDir, "client", "index.tsx");
      const originalClient = await readFile(clientPath, "utf8");
      await writeFile(clientPath, originalClient.replace("Sporades Todos", "Sporades Less Disruptive Todos"));

      const rebuilt = await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );
      assert.equal(rebuilt.error, null);
      assert.equal(rebuilt.data.port, started.data.port);

      socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
      const authAfter = await readSocketMessage(socket);
      assert.equal(authAfter.data.sessionToken, authBefore.data.sessionToken);
      assert.deepEqual(authAfter.data.auth, authBefore.data.auth);

      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      assert.match(await clientResponse.text(), /Sporades Less Disruptive Todos/);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev gives fresh and migrated Capsule schemas the same nullability and defaults", async () => {
  await withTempDir(async (dir) => {
    const baseServer = `import { Boolean, capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "nullability-island",
  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },
  queries: {
    todos: query((ctx) => ctx.db.todos.where("ownerId", ctx.auth.userId).orderBy("createdAt", "desc").all()),
  },
  mutations: {
    recordTodo: mutation((ctx, text, values = {}) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId, ...values });
    }),
  },
});
`;
    const finalServer = baseServer.replace(
      "done: Boolean().default(false),",
      `done: Boolean().default(false),
      priority: String().default("normal"),
      note: String(),
      reviewed: Boolean(),`,
    );

    async function createProject(projectName, serverSource) {
      const createResult = await runCli(["create", projectName, "--template", "todo", "--no-install", "--no-git", "--json"], {
        cwd: dir,
      });
      assert.equal(createResult.code, 0, createResult.stderr);

      const projectDir = path.join(dir, projectName);
      const configPath = path.join(projectDir, "sporades.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.dev.port = 0;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await writeFile(path.join(projectDir, "server", "index.ts"), serverSource);
      await installFakeReact(projectDir);
      return projectDir;
    }

    async function tableInfo(projectDir) {
      const result = await runCli(["db", "query", "PRAGMA table_info(todos)", "--json"], { cwd: projectDir });
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout).data.rows.map((column) => ({
        name: column.name,
        type: column.type,
        notnull: column.notnull,
        dflt_value: column.dflt_value,
        pk: column.pk,
      }));
    }

    function rowContract(rows) {
      return rows
        .map(({ text, priority, note, reviewed }) => ({ text, priority, note, reviewed }))
        .sort((left, right) => left.text.localeCompare(right.text));
    }

    const freshProjectDir = await createProject("fresh-island", finalServer);
    const freshChild = startCli(["dev", "--json"], { cwd: freshProjectDir });
    let freshSocket;
    let freshRows;
    let freshSchemaInfo;
    try {
      const freshStarted = await waitForJsonLine(freshChild);
      assert.equal(freshStarted.ok, true, JSON.stringify(freshStarted));
      freshSocket = await openSocket(freshStarted.data.url);
      freshSocket.send(JSON.stringify({ id: "fresh-todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual(
        (
          await waitForSocketMessage(
            freshSocket,
            (message) => message.id === "fresh-todos" && message.type === "query.result" && message.query === "todos",
          )
        ).data,
        [],
      );
      const freshMissingResultPromise = waitForSocketMessage(
        freshSocket,
        (message) => message.id === "fresh-missing" && message.type === "mutation.result",
      );
      const freshMissingRefreshPromise = waitForSocketMessage(
        freshSocket,
        (message) =>
          message.id === "fresh-todos" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Fresh missing"),
      );
      freshSocket.send(
        JSON.stringify({ id: "fresh-missing", type: "mutation.run", mutation: "recordTodo", args: ["Fresh missing"] }),
      );
      assert.equal((await freshMissingResultPromise).error, null);
      await freshMissingRefreshPromise;
      const freshSuppliedResultPromise = waitForSocketMessage(
        freshSocket,
        (message) => message.id === "fresh-supplied" && message.type === "mutation.result",
      );
      const freshSuppliedRefreshPromise = waitForSocketMessage(
        freshSocket,
        (message) =>
          message.id === "fresh-todos" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.length === 2 &&
          message.data.some((todo) => todo.text === "Fresh supplied"),
      );
      freshSocket.send(
        JSON.stringify({
          id: "fresh-supplied",
          type: "mutation.run",
          mutation: "recordTodo",
          args: ["Fresh supplied", { priority: "urgent", note: "explicit", reviewed: true }],
        }),
      );
      assert.equal((await freshSuppliedResultPromise).error, null);
      freshRows = (await freshSuppliedRefreshPromise).data;
      freshSchemaInfo = await tableInfo(freshProjectDir);
    } finally {
      freshSocket?.close();
      if (freshChild.exitCode === null) {
        const exited = new Promise((resolve) => freshChild.once("exit", resolve));
        freshChild.kill("SIGTERM");
        await exited;
      }
    }

    const migratedProjectDir = await createProject("migrated-island", baseServer);
    const migratedChild = startCli(["dev", "--json"], { cwd: migratedProjectDir });
    let migratedSocket;
    let migratedRows;
    let migratedSchemaInfo;
    try {
      const migratedStarted = await waitForJsonLine(migratedChild);
      assert.equal(migratedStarted.ok, true, JSON.stringify(migratedStarted));
      migratedSocket = await openSocket(migratedStarted.data.url);
      migratedSocket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(migratedSocket)).data.sessionToken;
      migratedSocket.send(JSON.stringify({ id: "migrated-todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual(
        (
          await waitForSocketMessage(
            migratedSocket,
            (message) => message.id === "migrated-todos" && message.type === "query.result" && message.query === "todos",
          )
        ).data,
        [],
      );
      const migratedBeforeResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "migrated-before" && message.type === "mutation.result",
      );
      const migratedBeforeRefreshPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "migrated-todos" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Fresh missing"),
      );
      migratedSocket.send(
        JSON.stringify({ id: "migrated-before", type: "mutation.run", mutation: "recordTodo", args: ["Fresh missing"] }),
      );
      assert.equal((await migratedBeforeResultPromise).error, null);
      await migratedBeforeRefreshPromise;

      await writeFile(path.join(migratedProjectDir, "server", "index.ts"), finalServer);
      const [rebuilt] = await Promise.all([
        waitForJsonEvent(
          migratedChild,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(migratedSocket),
      ]);
      assert.equal(rebuilt.error, null);
      migratedSocket = await openSocket(migratedStarted.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "migrated-after", type: "query.subscribe", query: "todos" }));
      await waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "migrated-after" && message.type === "query.result" && message.query === "todos",
      );
      const migratedSuppliedResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "migrated-supplied" && message.type === "mutation.result",
      );
      const migratedSuppliedRefreshPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "migrated-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.length === 2 &&
          message.data.some((todo) => todo.text === "Fresh supplied"),
      );
      migratedSocket.send(
        JSON.stringify({
          id: "migrated-supplied",
          type: "mutation.run",
          mutation: "recordTodo",
          args: ["Fresh supplied", { priority: "urgent", note: "explicit", reviewed: true }],
        }),
      );
      assert.equal((await migratedSuppliedResultPromise).error, null);
      migratedRows = (await migratedSuppliedRefreshPromise).data;
      migratedSchemaInfo = await tableInfo(migratedProjectDir);
    } finally {
      migratedSocket?.close();
      if (migratedChild.exitCode === null) {
        const exited = new Promise((resolve) => migratedChild.once("exit", resolve));
        migratedChild.kill("SIGTERM");
        await exited;
      }
    }

    assert.deepEqual(freshSchemaInfo, migratedSchemaInfo);
    assert.deepEqual(rowContract(freshRows), rowContract(migratedRows));
    assert.deepEqual(rowContract(freshRows), [
      { text: "Fresh missing", priority: "normal", note: null, reviewed: null },
      { text: "Fresh supplied", priority: "urgent", note: "explicit", reviewed: true },
    ]);
  });
});


test("sporades dev supports Number fields end-to-end through migrations and runtime APIs", async () => {
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
      assert.equal((await readSocketMessage(socket)).data[0].text, "Keep me");

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
            'import { Boolean, capsule, mutation, query, String, table } from "sporades/server";',
            'import { Boolean, capsule, endpoint, mutation, Number, query, String, table } from "sporades/server";',
          )
          .replace(
            "done: Boolean().default(false),",
            `done: Boolean().default(false),
      effort: Number().default(1.5),`,
          )
          .replace(
            "queries: {",
            `endpoints: {
    todosByEffort: endpoint({ method: "GET", path: "/todos/by-effort" }, (ctx) => ({
      body: {
        todos: ctx.db.todos
          .where("effort", globalThis.Number(ctx.request.query.effort))
          .orderBy("effort", "desc")
          .all(),
      },
    })),
  },

  queries: {`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `updateTodoEffort: mutation((ctx, id: string, effort: number) => {
      ctx.db.todos.update(id, { effort });
    }),

    addTodo: mutation((ctx, text: string, done: boolean, effort: number) => {`,
          )
          .replace(
            "ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });",
            "ctx.db.todos.insert({ text, done, effort, ownerId: ctx.auth.userId });",
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
      assert.equal(migratedRows.data[0].effort, 1.5);

      migratedSocket.send(
        JSON.stringify({
          id: "add-number",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["Numeric work", false, 2.25],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const insertedRows = await waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Numeric work" && todo.effort === 2.25),
      );
      const insertedTodo = insertedRows.data.find((todo) => todo.text === "Numeric work");

      migratedSocket.send(
        JSON.stringify({
          id: "update-number",
          type: "mutation.run",
          mutation: "updateTodoEffort",
          args: [insertedTodo.id, 3.75],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const updatedRows = await waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Numeric work" && todo.effort === 3.75),
      );
      assert.equal(typeof updatedRows.data.find((todo) => todo.text === "Numeric work").effort, "number");

      const endpointResponse = await fetch(`${started.data.url}/todos/by-effort?effort=3.75`);
      assert.equal(endpointResponse.status, 200);
      const endpointBody = await endpointResponse.json();
      assert.deepEqual(
        endpointBody.todos.map((todo) => ({ text: todo.text, effort: todo.effort })),
        [{ text: "Numeric work", effort: 3.75 }],
      );

      const storageResult = await runCli(
        ["db", "query", "SELECT effort, typeof(effort) AS kind FROM todos WHERE text = 'Numeric work'", "--json"],
        { cwd: projectDir },
      );
      assert.equal(storageResult.code, 0, storageResult.stderr);
      assert.deepEqual(JSON.parse(storageResult.stdout).data.rows, [{ effort: 3.75, kind: "real" }]);

      migratedSocket.send(
        JSON.stringify({
          id: "invalid-number",
          type: "mutation.run",
          mutation: "updateTodoEffort",
          args: [insertedTodo.id, "not numeric"],
        }),
      );
      assert.deepEqual(await readSocketMessage(migratedSocket), {
        id: "invalid-number",
        type: "mutation.result",
        mutation: "updateTodoEffort",
        data: null,
        error: {
          message: "Invalid number for field: effort",
          hint: "Pass a finite JavaScript number for Number() fields.",
        },
      });
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


test("sporades dev rejects invalid server env files with structured errors", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SPORADES_TOKEN=reserved\n");
    await installFakeReact(projectDir);

    const result = await runCli(["dev", "--json"], { cwd: projectDir });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid server env file.",
        hint: "Remove reserved SPORADES_ keys from .env.sporades.server.",
      },
    });
  });
});


test("sporades dev rejects Google auth mode when required env values are missing", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.auth = {
      mode: "google",
      google: {
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=client-id\n");
    await installFakeReact(projectDir);

    const result = await runCli(["dev", "--json"], { cwd: projectDir });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Google auth is not fully configured.",
        hint: "Run `sporades auth set google --client-id <id> --client-secret <secret>` or use `--client-json <path>`. Register callback URL http://localhost:4000/__sporades/auth/google/callback.",
      },
    });
  });
});


test("WebSocket email sign-in resolves an existing email account and rejects bad credentials", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "email-signin-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "email-signin-island");
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
  name: "email-signin-island",
  queries: {
    me: query((ctx) => ctx.auth),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    let expiredSocket;
    try {
      const started = await waitForJsonLine(child);
      socket = await openSocket(started.data.url);

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
      assert.equal(signUp.type, "auth.signUp.result");
      const emailUserId = signUp.data.auth.userId;

      socket.send(JSON.stringify({ id: "signout-1", type: "auth.signOut" }));
      assert.equal((await readSocketMessage(socket)).type, "auth.signOut.result");
      socket.send(JSON.stringify({ id: "auth-anon", type: "auth.get" }));
      const anonymousAuth = await readSocketMessage(socket);
      assert.equal(anonymousAuth.data.auth.provider, "anonymous");
      assert.notEqual(anonymousAuth.data.auth.userId, emailUserId);

      socket.send(
        JSON.stringify({
          id: "signin-bad",
          type: "auth.signIn",
          provider: "email",
          credentials: {
            email: "mira@example.com",
            password: "wrong password",
          },
        }),
      );
      const badSignIn = await readSocketMessage(socket);
      assert.equal(badSignIn.type, "error");
      assert.deepEqual(badSignIn.error, {
        message: "Email or password is incorrect.",
        hint: "Check the credentials and try email sign-in again.",
      });

      socket.send(JSON.stringify({ id: "auth-after-bad", type: "auth.get" }));
      const stillAnonymous = await readSocketMessage(socket);
      assert.equal(stillAnonymous.data.auth.userId, anonymousAuth.data.auth.userId);
      assert.equal(stillAnonymous.data.auth.provider, "anonymous");

      socket.send(
        JSON.stringify({
          id: "signin-good",
          type: "auth.signIn",
          provider: "email",
          credentials: {
            email: "mira@example.com",
            password: "correct horse battery staple",
          },
        }),
      );
      const goodSignIn = await readSocketMessage(socket);
      assert.equal(goodSignIn.id, "signin-good");
      assert.equal(goodSignIn.type, "auth.signIn.result");
      assert.equal(goodSignIn.error, null);
      assert.equal(goodSignIn.data.ok, true);
      assert.notEqual(goodSignIn.data.sessionToken, anonymousAuth.data.sessionToken);
      assert.deepEqual(goodSignIn.data.auth, {
        userId: emailUserId,
        displayName: "Mira",
        email: "mira@example.com",
        picture: null,
        isAuthenticated: true,
        isGuest: false,
        provider: "email",
      });

      socket.send(JSON.stringify({ id: "me-1", type: "query.subscribe", query: "me" }));
      assert.deepEqual((await readSocketMessage(socket)).data, goodSignIn.data.auth);

      const { DatabaseSync } = await import("node:sqlite");
      const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
      try {
        sqlite
          .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?")
          .run("2000-01-01T00:00:00.000Z", goodSignIn.data.sessionToken);
      } finally {
        sqlite.close();
      }
      socket.close();
      socket = null;

      expiredSocket = await openSocket(started.data.url, goodSignIn.data.sessionToken);
      expiredSocket.send(JSON.stringify({ id: "auth-expired-linked", type: "auth.get" }));
      const expiredLinked = await readSocketMessage(expiredSocket);
      assert.equal(expiredLinked.data.auth.provider, "anonymous");
      assert.notEqual(expiredLinked.data.auth.userId, emailUserId);
      assert.notEqual(expiredLinked.data.sessionToken, goodSignIn.data.sessionToken);
    } finally {
      socket?.close();
      expiredSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("Google auth callback exchanges the code server-side and links the current anonymous account", async () => {
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
        assert.equal(anonymousAuth.data.auth.isGuest, true);
        assert.equal(anonymousAuth.data.providers.google.configured, true);
        const googlePreRefreshExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const { DatabaseSync } = await import("node:sqlite");
        const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
        try {
          sqlite
            .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?")
            .run(googlePreRefreshExpiry, anonymousAuth.data.sessionToken);
        } finally {
          sqlite.close();
        }

        socket.send(JSON.stringify({ id: "query-1", type: "query.subscribe", query: "todos" }));
        assert.deepEqual((await readSocketMessage(socket)).data, []);
        socket.send(JSON.stringify({ id: "todo-1", type: "mutation.run", mutation: "addTodo", args: ["Keep me"] }));
        assert.equal((await readSocketMessage(socket)).type, "mutation.result");
        assert.equal((await readSocketMessage(socket)).data[0].text, "Keep me");

        socket.send(
          JSON.stringify({
            id: "complete-1",
            type: "auth.completeGoogleSignIn",
            profile: { email: "mallory@example.com", displayName: "Mallory" },
          }),
        );
        const fakeComplete = await readSocketMessage(socket);
        assert.equal(fakeComplete.type, "error");
        assert.match(fakeComplete.error.message, /Unsupported WebSocket message/);

        socket.send(JSON.stringify({ id: "signin-1", type: "auth.signIn", provider: "google", returnTo: `${started.data.url}/notes` }));
        const signIn = await readSocketMessage(socket);
        assert.equal(signIn.id, "signin-1");
        assert.equal(signIn.type, "auth.redirect");
        assert.match(signIn.data.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
        assert.doesNotMatch(signIn.data.url, /client-secret/);
        const signInUrl = new URL(signIn.data.url);
        assert.equal(signInUrl.searchParams.get("client_id"), "client-id");
        assert.equal(signInUrl.searchParams.get("response_type"), "code");
        assert.equal(signInUrl.searchParams.get("scope"), "openid email profile");
        assert.ok(signInUrl.searchParams.get("nonce"));
        assert.ok(signInUrl.searchParams.get("code_challenge"));
        assert.equal(signInUrl.searchParams.get("code_challenge_method"), "S256");
        assert.match(signInUrl.searchParams.get("redirect_uri"), /\/__sporades\/auth\/google\/callback$/);
        assert.notEqual(signInUrl.searchParams.get("state"), anonymousAuth.data.sessionToken);
        google.setNonce(signInUrl.searchParams.get("nonce"));

        const callbackResponse = await fetch(
          `${started.data.url}/__sporades/auth/google/callback?code=server-owned-code&state=${signInUrl.searchParams.get("state")}`,
          { redirect: "manual" },
        );
        assert.equal(callbackResponse.status, 302);
        assert.equal(callbackResponse.headers.get("location"), `${started.data.url}/notes`);
        const tokenRequest = google.requests[0];
        assert.ok(tokenRequest.body.code_verifier);
        assert.deepEqual(tokenRequest, {
          method: "POST",
          path: "/token",
          body: {
            code: "server-owned-code",
            client_id: "client-id",
            client_secret: "client-secret",
            redirect_uri: `${started.data.url}/__sporades/auth/google/callback`,
            grant_type: "authorization_code",
            code_verifier: tokenRequest.body.code_verifier,
          },
        });
        assert.deepEqual(google.requests[1], { method: "GET", path: "/jwks" });

        socket.send(JSON.stringify({ id: "auth-2", type: "auth.get" }));
        const linked = await readSocketMessage(socket);
        assert.equal(linked.type, "auth.result");
        assert.equal(linked.data.sessionToken, anonymousAuth.data.sessionToken);
        assert.deepEqual(linked.data.auth, {
          userId,
          displayName: "Mira",
          email: "mira@example.com",
          picture: "https://example.com/mira.png",
          isAuthenticated: true,
          isGuest: false,
          provider: "google",
        });
        const refreshedSqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
        try {
          const refreshedSession = refreshedSqlite
            .prepare("SELECT expiresAt FROM sporades_auth_sessions WHERE token = ?")
            .get(linked.data.sessionToken);
          assert.ok(Date.parse(refreshedSession.expiresAt) > Date.parse(googlePreRefreshExpiry));
        } finally {
          refreshedSqlite.close();
        }

        socket.send(JSON.stringify({ id: "query-2", type: "query.subscribe", query: "todos" }));
        const todosAfterLink = await readSocketMessage(socket);
        assert.deepEqual(
          todosAfterLink.data.map((todo) => todo.text),
          ["Keep me"],
        );

        socket.send(JSON.stringify({ id: "signout-1", type: "auth.signOut" }));
        const signOut = await readSocketMessage(socket);
        assert.deepEqual(signOut, {
          id: "signout-1",
          type: "auth.signOut.result",
          data: { ok: true },
          error: null,
        });

        socket.send(JSON.stringify({ id: "auth-3", type: "auth.get" }));
        const signedOutAuth = await readSocketMessage(socket);
        assert.notEqual(signedOutAuth.data.sessionToken, linked.data.sessionToken);
        assert.notEqual(signedOutAuth.data.auth.userId, userId);
        assert.deepEqual(signedOutAuth.data.auth, {
          userId: signedOutAuth.data.auth.userId,
          displayName: "Anonymous",
          email: null,
          picture: null,
          isAuthenticated: false,
          isGuest: true,
          provider: "anonymous",
        });

        socket.send(JSON.stringify({ id: "query-3", type: "query.subscribe", query: "todos" }));
        assert.deepEqual((await readSocketMessage(socket)).data, []);
      } finally {
        socket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("Apple HTTPS browser tracer completes form-post auth without client-side Apple SDK code", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "apple-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "apple-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const credentialsPath = path.join(projectDir, "apple.json");
    await writeFile(credentialsPath, JSON.stringify({
      servicesId: "com.example.web",
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    }));
    const setResult = await runCli(["auth", "set", "apple", "--client-json", credentialsPath, "--json"], { cwd: projectDir });
    assert.equal(setResult.code, 0, setResult.stderr);
    const tlsPort = await getTestAvailablePort();
    const publicOrigin = `https://apple.example.test:${tlsPort}`;
    const configured = JSON.parse(await readFile(configPath, "utf8"));
    configured.__sporadesPublicOrigin = publicOrigin;
    await writeFile(configPath, `${JSON.stringify(configured, null, 2)}\n`);

    await withFakeAppleServer(async (apple) => {
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: {
          SPORADES_APPLE_TOKEN_URL: apple.tokenUrl,
          SPORADES_APPLE_JWKS_URL: apple.jwksUrl,
          SPORADES_OAUTH_TEST_ENDPOINTS: "1",
        },
      });
      let httpsSocket;
      try {
        const started = await waitForJsonLine(child);
        assert.equal(started.ok, true, JSON.stringify(started));
        await withAppleHttpsTunnel(started.data.url, tlsPort, async (tunnel) => {
          httpsSocket = await openSocketWithHeaders(started.data.url, {
            host: new URL(tunnel.publicOrigin).host,
            origin: tunnel.publicOrigin,
            "x-forwarded-host": new URL(tunnel.publicOrigin).host,
            "x-forwarded-proto": "https",
          });
          httpsSocket.sendJson({ id: "auth", type: "auth.get" });
          const anonymous = await httpsSocket.readJson();
          assert.equal(anonymous.data.providers.apple.configured, true);
          assert.equal(anonymous.data.providers.apple.runtimeAvailable, true);
          const userId = anonymous.data.auth.userId;
          httpsSocket.sendJson({ id: "todos", type: "query.subscribe", query: "todos" });
          assert.deepEqual((await httpsSocket.readJson()).data, []);
          httpsSocket.sendJson({
            id: "signin",
            type: "auth.signIn",
            provider: "apple",
            returnTo: `${tunnel.publicOrigin}/account`,
          });
          const redirect = await httpsSocket.readJson();
          assert.equal(redirect.type, "auth.redirect");
          const authorization = new URL(redirect.data.url);
          assert.equal(authorization.searchParams.get("redirect_uri"), `${tunnel.publicOrigin}/__sporades/auth/apple/callback`);
          apple.setNonce(authorization.searchParams.get("nonce"));

          const callback = await tunnel.postForm("/__sporades/auth/apple/callback", {
            state: authorization.searchParams.get("state"),
            code: "apple-code",
            user: JSON.stringify({ name: { firstName: "Mira", lastName: "Chen" } }),
          });
          assert.equal(callback.status, 302, callback.body);
          assert.equal(callback.headers.location, `${tunnel.publicOrigin}/account`);
          assert.equal(apple.requests[0].body.redirect_uri, `${tunnel.publicOrigin}/__sporades/auth/apple/callback`);
          assert.ok(apple.requests[0].body.client_secret);

          httpsSocket.sendJson({ id: "linked", type: "auth.get" });
          const linked = await httpsSocket.readJson();
          assert.equal(linked.data.auth.userId, userId);
          assert.equal(linked.data.auth.provider, "apple");
          assert.equal(linked.data.auth.displayName, "Mira Chen");
          assert.equal(linked.data.auth.email, "mira@privaterelay.appleid.com");

          httpsSocket.sendJson({ id: "preference-write", type: "preferences.update", patch: { appleTheme: "orchard" } });
          const preferenceWrite = await httpsSocket.readJson();
          assert.deepEqual(preferenceWrite.data.preferences, { appleTheme: "orchard" });
          httpsSocket.sendJson({ id: "preference-read", type: "preferences.get" });
          const preferenceRead = await httpsSocket.readJson();
          assert.deepEqual(preferenceRead.data.preferences, { appleTheme: "orchard" });

          httpsSocket.sendJson({ id: "todo", type: "mutation.run", mutation: "addTodo", args: ["Verified Apple owner"] });
          assert.equal((await httpsSocket.readJson()).error, null);
          const todoRefresh = await httpsSocket.readJson();
          assert.equal(todoRefresh.data[0].text, "Verified Apple owner");

          httpsSocket.sendJson({ id: "signout", type: "auth.signOut" });
          assert.equal((await httpsSocket.readJson()).type, "auth.signOut.result");
          httpsSocket.sendJson({ id: "signed-out", type: "auth.get" });
          assert.equal((await httpsSocket.readJson()).data.auth.provider, "anonymous");
          const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
          assert.doesNotMatch(clientBundle, /appleid\\.auth|appleid\\.apple\\.com|SignInWithApple|AppleID\\.auth/);
          httpsSocket.close();
          httpsSocket = null;
        });
      } finally {
        httpsSocket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("dev inspection routes require the per-session inspection token while CLI logs send it", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "inspect-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "inspect-island");
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
      assert.equal(session.url, started.data.url);
      assert.match(session.inspectionToken, /^[a-f0-9]{64}$/);

      const unauthenticatedLogs = await fetch(`${started.data.url}/__sporades/debug/logs`);
      assert.equal(unauthenticatedLogs.status, 401);
      assert.deepEqual(await unauthenticatedLogs.json(), {
        ok: false,
        data: null,
        error: {
          message: "Dev inspection token is required.",
          hint: "Use Sporades CLI inspection commands for this Dev session.",
        },
      });

      const invalidLogs = await fetch(`${started.data.url}/__sporades/debug/logs`, {
        headers: { "x-sporades-inspection-token": "not-the-token" },
      });
      assert.equal(invalidLogs.status, 401);
      assert.equal((await invalidLogs.json()).data, null);

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const logs = JSON.parse(logsResult.stdout);
      assert.equal(logs.ok, true);
      assert.equal(logs.data.source, "sqlite");
      assert.equal(logs.data.entries.some((entry) => entry.event === "dev.session.started"), true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades db query rejects write SQL with a structured hint", async () => {
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

      const queryResult = await runCli(["db", "query", "DELETE FROM todos", "--json"], { cwd: projectDir });
      assert.equal(queryResult.code, 1);
      assert.deepEqual(JSON.parse(queryResult.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Only read-only SQL is allowed.",
          hint: "Use a SELECT, WITH, or safe metadata PRAGMA query for `sporades db query`.",
        },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("a scaffolded guestbook trims, validates, and reads shared entries over WebSocket", async () => {
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

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      const socket = await openSocket(started.data.url);
      try {
        socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
        const authResult = await readSocketMessage(socket);
        assert.equal(authResult.data.auth.isGuest, true);
        assert.equal(authResult.data.auth.displayName, "Anonymous");

        socket.send(JSON.stringify({ id: "entries-1", type: "query.subscribe", query: "entries" }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "entries-1",
          type: "query.result",
          query: "entries",
          data: [],
          error: null,
        });

        socket.send(JSON.stringify({ id: "empty-1", type: "mutation.run", mutation: "sign", args: ["   "] }));
        const emptyResult = await readSocketMessage(socket);
        assert.equal(emptyResult.type, "mutation.result");
        assert.equal(emptyResult.error.message, "Write a message before signing.");

        socket.send(JSON.stringify({ id: "long-1", type: "mutation.run", mutation: "sign", args: ["x".repeat(281)] }));
        const longResult = await readSocketMessage(socket);
        assert.equal(longResult.type, "mutation.result");
        assert.equal(longResult.error.message, "Guestbook messages must be 280 characters or fewer.");

        const firstRefreshPromise = waitForSocketMessage(
          socket,
          (message) =>
            message.type === "query.result" &&
            message.query === "entries" &&
            message.data.some((entry) => entry.body === "First note"),
        );
        socket.send(JSON.stringify({ id: "sign-1", type: "mutation.run", mutation: "sign", args: ["  First note  "] }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "sign-1",
          type: "mutation.result",
          mutation: "sign",
          data: null,
          error: null,
        });
        const firstRefresh = await firstRefreshPromise;
        assert.equal(firstRefresh.data.length, 1);
        assert.equal(firstRefresh.data[0].body, "First note");
        assert.equal(firstRefresh.data[0].authorId, authResult.data.auth.userId);
        assert.equal(firstRefresh.data[0].authorName, "Anonymous");
        assert.equal(firstRefresh.data[0].authorPicture, "");

        await new Promise((resolve) => setTimeout(resolve, 5));
        const secondRefreshPromise = waitForSocketMessage(
          socket,
          (message) =>
            message.type === "query.result" &&
            message.query === "entries" &&
            message.data.some((entry) => entry.body === "Second note"),
        );
        socket.send(JSON.stringify({ id: "sign-2", type: "mutation.run", mutation: "sign", args: ["Second note"] }));
        assert.equal((await readSocketMessage(socket)).error, null);
        const secondRefresh = await secondRefreshPromise;
        assert.deepEqual(
          secondRefresh.data.map((entry) => entry.body),
          ["Second note", "First note"],
        );

        const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
        assert.equal(dumpResult.code, 0, dumpResult.stderr);
        const entriesTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "entries");
        assert.deepEqual(entriesTable.columns, ["id", "createdAt", "updatedAt", "body", "authorId", "authorName", "authorPicture"]);
      } finally {
        socket.close();
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev routes client app messages through declared Capsule handlers", async () => {
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
    typing: message((ctx, data) => ({
      handledBy: ctx.auth.userId,
      received: data,
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
      const auth = await readSocketMessage(socket);

      socket.send(
        JSON.stringify({
          id: "typing-1",
          type: "app.send",
          message: "typing",
          data: { roomId: "general", active: true },
        }),
      );

      assert.deepEqual(await readSocketMessage(socket), {
        id: "typing-1",
        type: "app.result",
        message: "typing",
        data: {
          handledBy: auth.data.auth.userId,
          received: { roomId: "general", active: true },
        },
        error: null,
      });
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev awaits async app message handlers before sending app results", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "async-message-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "async-message-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, message } from "sporades/server";

export default capsule({
  name: "async-message-island",

  messages: {
    typing: message(async (ctx, data) => {
      await Promise.resolve();
      ctx.messages.send({ type: "typing", data: { resolved: data.active } });
      return { ok: true, resolved: data.active };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let firstSocket;
    let secondSocket;
    try {
      const started = await waitForJsonLine(child);
      firstSocket = await openSocket(started.data.url);
      firstSocket.send(JSON.stringify({ id: "auth", type: "auth.get" }));
      const auth = await readSocketMessage(firstSocket);
      secondSocket = await openSocket(started.data.url, auth.data.sessionToken);
      secondSocket.send(JSON.stringify({ id: "second-auth", type: "auth.get" }));
      assert.equal((await readSocketMessage(secondSocket)).type, "auth.result");

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
          data: { active: true },
        }),
      );

      assert.deepEqual(await firstAppMessage, {
        type: "app.message",
        message: "typing",
        data: { resolved: true },
      });
      assert.deepEqual(await secondAppMessage, {
        type: "app.message",
        message: "typing",
        data: { resolved: true },
      });
      assert.deepEqual(await sendResult, {
        id: "typing",
        type: "app.result",
        message: "typing",
        data: { ok: true, resolved: true },
        error: null,
      });
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev processes same-socket WebSocket messages in order around async mutations", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "queued-mutation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "queued-mutation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "queued-mutation-island",

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
        .orderBy("createdAt", "asc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation(async (ctx, text: string) => {
      ctx.db.todos.insert({ text: text + ":before-await", ownerId: ctx.auth.userId });
      await new Promise((resolve) => setTimeout(resolve, 25));
      ctx.db.todos.insert({ text: text + ":after-await", ownerId: ctx.auth.userId });
      return { inserted: 2 };
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

      const mutationResult = waitForSocketMessage(
        socket,
        (message) => message.id === "add" && message.type === "mutation.result",
      );
      const queryResult = waitForSocketMessage(
        socket,
        (message) => message.id === "todos-after-add" && message.type === "query.result",
      );
      socket.send(JSON.stringify({ id: "add", type: "mutation.run", mutation: "addTodo", args: ["ship"] }));
      socket.send(JSON.stringify({ id: "todos-after-add", type: "query.subscribe", query: "todos" }));

      assert.deepEqual(await mutationResult, {
        id: "add",
        type: "mutation.result",
        mutation: "addTodo",
        data: { inserted: 2 },
        error: null,
      });
      assert.deepEqual(
        (await queryResult).data.map((todo) => todo.text),
        ["ship:before-await", "ship:after-await"],
      );
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev preserves file lifecycle parity with MinIO-backed storage", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "file-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "file-island");
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
    await mkdir(path.join(projectDir, ".sporades", "services"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".sporades", "services", "credentials.json"),
      `${JSON.stringify(
        {
          databaseUser: "sporades",
          databasePassword: "sporades",
          storageAccessKey: "sporades",
          storageSecretKey: "sporades-minio-local-secret",
        },
        null,
        2,
      )}\n`,
    );

    await withFakeS3CompatibleService(async ({ port, requests, objects }) => {
      const docker = await installFakeDocker(dir);
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: { ...docker.env, FAKE_DOCKER_SERVICE_PORT: String(port) },
      });
      let ownerSocket;
      let otherSocket;
      try {
        await waitForJsonLine(child);
        const storageReady = await waitForJsonEvent(
          child,
          (event) => event.data?.event === "service" && event.data.service === "storage" && event.data.status === "ready",
        );
        assert.equal(storageReady.ok, true);
        assert.equal(storageReady.data.port, port);
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        assert.equal(started.ok, true);

        async function sendAndWait(socket, payload) {
          socket.send(JSON.stringify(payload));
          return await waitForSocketMessage(socket, (message) => message.id === payload.id);
        }

        async function upload(socket, id, file, body) {
          const uploadUrl = await sendAndWait(socket, {
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

        ownerSocket = await openSocket(started.data.url);
        const ownerAuth = await sendAndWait(ownerSocket, { id: "owner-auth", type: "auth.get" });
        otherSocket = await openSocket(started.data.url);
        const otherAuth = await sendAndWait(otherSocket, { id: "other-auth", type: "auth.get" });

        const explicitPath = "/docs/reports/2026/q2/proof.txt";
        const first = await upload(
          ownerSocket,
          "first",
          { name: "proof.txt", type: "text/plain", path: explicitPath },
          "minio-one",
        );
        assert.equal(first.bucket, "default");
        assert.equal(first.path, explicitPath);
        assert.equal(first.name, "proof.txt");
        assert.equal(first.type, "text/plain");
        assert.equal(first.size, 9);
        const firstObjectKey = `capsules/file-island/files/${first.id}/${first.version}`;
        assert.equal(objects.get(firstObjectKey).toString("utf8"), "minio-one");

        const byId = await sendAndWait(ownerSocket, { id: "private-by-id", type: "file.url", fileId: first.id });
        assert.equal(byId.error, null);
        const byPath = await sendAndWait(ownerSocket, { id: "private-by-path", type: "file.url", fileReference: explicitPath });
        assert.equal(byPath.error, null);
        assert.equal(byPath.data.file.id, first.id);
        assert.deepEqual(byPath.data.file, byId.data.file);

        const privateRead = await fetch(new URL(byPath.data.url, started.data.url), {
          headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
        });
        assert.equal(privateRead.status, 200);
        assert.equal(privateRead.headers.get("content-type"), "text/plain");
        assert.equal(await privateRead.text(), "minio-one");

        const unauthorizedLookup = await sendAndWait(otherSocket, {
          id: "unauthorized-path",
          type: "file.url",
          fileReference: explicitPath,
        });
        assert.equal(unauthorizedLookup.type, "error");
        assert.equal(unauthorizedLookup.error.message, "File not found.");
        const unauthorizedRead = await fetch(new URL(byPath.data.url, started.data.url), {
          headers: { "x-sporades-session-token": otherAuth.data.sessionToken },
        });
        assert.equal(unauthorizedRead.status, 404);

        const publicUrl = await sendAndWait(ownerSocket, {
          id: "public-url",
          type: "file.publicUrl.create",
          fileReference: explicitPath,
          options: { noExpiry: true },
        });
        assert.equal(publicUrl.error, null);
        assert.equal(publicUrl.data.publicUrl.fileId, first.id);
        const publicRead = await fetch(new URL(publicUrl.data.publicUrl.url, started.data.url));
        assert.equal(publicRead.status, 200);
        assert.equal(await publicRead.text(), "minio-one");
        const stalePublicUrl = publicUrl.data.publicUrl.url;

        const overwritten = await upload(
          ownerSocket,
          "overwrite",
          { name: "proof-v2.txt", type: "text/plain", path: explicitPath },
          "minio-two",
        );
        assert.equal(overwritten.id, first.id);
        assert.notEqual(overwritten.version, first.version);
        assert.equal(overwritten.path, explicitPath);
        assert.equal(objects.has(firstObjectKey), false);
        const overwrittenObjectKey = `capsules/file-island/files/${overwritten.id}/${overwritten.version}`;
        assert.equal(objects.get(overwrittenObjectKey).toString("utf8"), "minio-two");

        const stalePrivateRead = await fetch(new URL(byPath.data.url, started.data.url), {
          headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
        });
        assert.equal(stalePrivateRead.status, 404);
        const stalePublicRead = await fetch(new URL(stalePublicUrl, started.data.url));
        assert.equal(stalePublicRead.status, 404);

        const nextPrivate = await sendAndWait(ownerSocket, { id: "next-private", type: "file.url", fileReference: explicitPath });
        assert.equal(nextPrivate.error, null);
        assert.equal(nextPrivate.data.file.version, overwritten.version);
        const nextRead = await fetch(new URL(nextPrivate.data.url, started.data.url), {
          headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
        });
        assert.equal(nextRead.status, 200);
        assert.equal(await nextRead.text(), "minio-two");

        const revokedPublicUrl = await sendAndWait(ownerSocket, {
          id: "public-url-next",
          type: "file.publicUrl.create",
          fileId: overwritten.id,
          options: { noExpiry: true },
        });
        assert.equal(revokedPublicUrl.error, null);
        const revoke = await sendAndWait(ownerSocket, {
          id: "revoke-public",
          type: "file.publicUrl.revoke",
          publicUrlId: revokedPublicUrl.data.publicUrl.id,
        });
        assert.equal(revoke.error, null);
        const revokedRead = await fetch(new URL(revokedPublicUrl.data.publicUrl.url, started.data.url));
        assert.equal(revokedRead.status, 404);

        const defaultNamed = await upload(ownerSocket, "default-named", { name: "readme.txt", type: "text/plain" }, "named");
        assert.equal(defaultNamed.path, "/default/readme.txt");

        const deleted = await sendAndWait(ownerSocket, { id: "delete-by-path", type: "file.delete", fileReference: explicitPath });
        assert.equal(deleted.error, null);
        assert.equal(deleted.data.file.id, overwritten.id);
        assert.equal(objects.has(overwrittenObjectKey), false);
        const deletedRead = await fetch(new URL(nextPrivate.data.url, started.data.url), {
          headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
        });
        assert.equal(deletedRead.status, 404);

        const recreated = await upload(
          ownerSocket,
          "recreated",
          { name: "proof.txt", type: "text/plain", path: explicitPath },
          "minio-new",
        );
        assert.notEqual(recreated.id, overwritten.id);
        assert.equal(recreated.path, explicitPath);

        const expiredPublicUrl = await sendAndWait(ownerSocket, {
          id: "expired-public",
          type: "file.publicUrl.create",
          fileReference: explicitPath,
          options: { expires: "2020-01-01T00:00:00.000Z" },
        });
        assert.equal(expiredPublicUrl.error, null);
        const expiredRead = await fetch(new URL(expiredPublicUrl.data.publicUrl.url, started.data.url));
        assert.equal(expiredRead.status, 404);

        const missingDirect = await fetch(new URL(`/__sporades/files/public/missing-public?v=${recreated.version}`, started.data.url));
        assert.equal(missingDirect.status, 404);
        assert(
          requests.some(
            (request) =>
              request.method === "PUT" &&
              request.url === `/sporades-files/capsules/file-island/files/${recreated.id}/${recreated.version}`,
          ),
          JSON.stringify(requests.map((request) => [request.method, request.url])),
        );

        const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
        const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
        assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_ENDPOINT"/);
        assert.doesNotMatch(clientBundle, /SPORADES_SERVICE_STORAGE_/);
        assert.doesNotMatch(clientBundle, /sporades-minio-local-secret/);
      } finally {
        ownerSocket?.close();
        otherSocket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});


test("sporades dev runs todo queries and mutations over WebSocket", async () => {
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
      socket = await openWebSocket(started.data.url.replace("http://", "ws://") + "/__sporades/ws");

      socket.send(JSON.stringify({ id: "q1", type: "query.subscribe", name: "todos" }));
      const emptyResult = await waitForSocketMessage(
        socket,
        (message) => message.type === "query.result" && message.id === "q1",
      );
      assert.deepEqual(emptyResult.data.rows, []);

      socket.send(JSON.stringify({ id: "m1", type: "mutation.run", name: "addTodo", args: ["Buy milk"] }));
      const mutationResult = await waitForSocketMessage(
        socket,
        (message) => message.type === "mutation.result" && message.id === "m1",
      );
      assert.deepEqual(mutationResult, { id: "m1", type: "mutation.result", ok: true, data: null, error: null });

      const refreshedResult = await waitForSocketMessage(
        socket,
        (message) => message.type === "query.result" && message.id === "q1" && message.data.rows.length === 1,
      );
      assert.equal(refreshedResult.data.rows[0].text, "Buy milk");
      assert.equal(refreshedResult.data.rows[0].done, false);
      assert.equal(typeof refreshedResult.data.rows[0].id, "string");
      assert.equal(typeof refreshedResult.data.rows[0].createdAt, "string");
      assert.equal(typeof refreshedResult.data.rows[0].updatedAt, "string");

      const dumpResult = await runCli(["db", "query", "SELECT text, done FROM todos", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      assert.deepEqual(JSON.parse(dumpResult.stdout).data.rows, [{ text: "Buy milk", done: 0 }]);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});
