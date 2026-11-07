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
  runCommand,
  startCli,
  packCandidateInto,
  installPackedCandidate,
  installPackedCandidateCli,
  assertGeneratedLifecycleScriptAllowlist,
  rawHttpResponse,
  waitForJsonLine,
  waitForJsonEvent,
  captureJsonEvents,
  assertDevRefreshDelivery,
  installFakeReact,
  installFakePreact,
  installVue,
  installSvelte,
  sessionState,
  authStub,
  createVueCampfire,
  createSvelteTemplate,
  createSolidTemplate,
  campfireHarnessState,
  litSource,
  createLitTemplate,
  createInfernoTemplate,
  litCampfireState,
  openSocket,
  readSocketMessage,
  captureSocketMessages,
  waitForSocketClose,
  closeSocketGracefully,
  waitForSocketMessage
} from "./support/dev-fixture.js";



test("real Lit todo host renders controller state, drives mutation, and reconnects exact ownership", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "lit-todo-behavior", "--framework", "lit", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr || created.stdout);
    const projectDir = path.join(dir, "lit-todo-behavior");
    await installProjectLitToolchain(projectDir, repoRoot);
    const calls = [], queryListeners = new Set(), authListeners = new Set();
    const counts = { queryStarts: 0, queryStops: 0, authStarts: 0, authStops: 0 };
    const harness = await mountLitTemplate(projectDir, {
      auth: authStub(),
      session: { subscribe(listener) { counts.authStarts += 1; authListeners.add(listener); listener({ auth: null, providers: {}, loading: false, error: null }); return { unsubscribe() { if (authListeners.delete(listener)) counts.authStops += 1; } }; } },
      queries: { todos: { subscribe(listener) { counts.queryStarts += 1; queryListeners.add(listener); listener({ data: [{ id: "lit-1", text: "Cross the real host seam" }], error: null, loading: false }); return { unsubscribe() { if (queryListeners.delete(listener)) counts.queryStops += 1; } }; } } },
      mutations: { addTodo: { async run(value) { calls.push(value); return { data: { id: "lit-2" }, error: null }; } } },
    });
    try {
      assert.match(harness.text(), /Sporades Todos.*Cross the real host seam/s);
      assert.deepEqual(counts, { queryStarts: 1, queryStops: 0, authStarts: 1, authStops: 0 });
      const input = harness.find('input[aria-label="Todo"]'); input.value = "Ship Lit"; input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
      harness.find("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true, cancelable: true }));
      await harness.settle();
      assert.deepEqual(calls, ["Ship Lit"]);
      await harness.disconnect(); await harness.disconnect();
      assert.deepEqual(counts, { queryStarts: 1, queryStops: 1, authStarts: 1, authStops: 1 });
      await harness.reconnect();
      assert.deepEqual(counts, { queryStarts: 2, queryStops: 1, authStarts: 2, authStops: 1 });
    } finally { await harness.unmount(); }
    assert.deepEqual(counts, { queryStarts: 2, queryStops: 2, authStarts: 2, authStops: 2 });
  });
});


for (const toolchain of ["esbuild", "vite"]) for (const deferredStage of ["journey.enable", "journey.set", "preferences.update"]) test(`real Inferno ${toolchain} Campfire keeps consent identity-owned while ${deferredStage} is pending`, async () => {
  await withTempDir(async (dir) => { const projectDir=await createInfernoTemplate(dir,`inferno-race-${toolchain}-${deferredStage.replace(".","-")}`,"campfire",{toolchain});const calls=[];let currentUser="athos",release,started;const stageStarted=new Promise(r=>started=r);const wait=async stage=>{if(stage===deferredStage){started();await new Promise(r=>release=r);}};const state=litCampfireState(calls,{async enable(o){calls.push(["journey.enable",o,currentUser]);await wait("journey.enable");return{data:null,error:null};},async set(v){calls.push(["journey.set",v,currentUser]);await wait("journey.set");return{data:null,error:null};}});state.queries.profiles=litSource({data:null,error:null,loading:false});state.session=litSource({...sessionState(),loading:false,auth:{userId:currentUser,provider:"email",isAuthenticated:true}});state.preferences.get=async()=>{calls.push(["preferences.get",currentUser]);return{data:{preferences:{campfireShareActivity:false}},error:null};};state.preferences.update=async v=>{calls.push(["preferences.update",v,currentUser]);await wait("preferences.update");return{data:{preferences:v},error:null};};const harness=await mountInfernoTemplate(projectDir,state);try{await harness.settle();const share=harness.find('input[role="switch"]');share.checked=true;share.dispatchEvent(new harness.window.Event("change",{bubbles:true}));await stageStarted;currentUser="porthos";state.session.publish({...sessionState(),loading:false,auth:{userId:currentUser,provider:"email",isAuthenticated:true}});await harness.settle();assert.equal(share.checked,false);release();await harness.settle();assert.equal(harness.find('input[role="switch"]').checked,false);assert.equal(calls.filter(([n])=>n==="journey.disable").length,1);assert.equal(calls.filter(([n,_v,u])=>n==="journey.set"&&u==="porthos").length,0);assert.equal(calls.filter(([n,_v,u])=>n==="preferences.update"&&u==="porthos").length,0);assert(calls.some(([n,u])=>n==="preferences.get"&&u==="porthos"));}finally{await harness.unmount();}});
});


test("real Lit Guestbook renders query state, mutates, and reconnects controllers", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createLitTemplate(dir, "lit-guestbook-behavior", "guestbook");
    const calls = [], session = litSource({ ...sessionState(), loading: false }), entries = litSource({ data: [{ id: "e1", authorName: "Athos", body: "All for one", createdAt: "2026-07-11T12:00:00.000Z" }], error: null, loading: false });
    const harness = await mountLitTemplate(projectDir, { auth: authStub(), files: {}, journey: {}, preferences: {}, session, queries: { entries }, mutations: { sign: { async run(value) { calls.push(value); return { data: null, error: null }; } } } });
    try {
      assert.match(harness.text(), /Leave a note from this island.*All for one/s);
      const textarea = harness.find("textarea"); textarea.value = "  One for all  "; textarea.dispatchEvent(new harness.window.Event("input", { bubbles: true })); await harness.settle();
      harness.find("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true, cancelable: true })); await harness.settle();
      assert.deepEqual(calls, ["One for all"]); assert.equal(harness.find("textarea").value, "");
      await harness.disconnect(); assert.deepEqual([session.counts.stops, entries.counts.stops], [1, 1]);
      await harness.reconnect(); assert.deepEqual([session.counts.starts, entries.counts.starts], [2, 2]);
    } finally { await harness.unmount(); }
    assert.deepEqual([session.counts.stops, entries.counts.stops], [2, 2]);
  });
});


test("a packed credential-free blank Capsule installs, typechecks, builds, and boots", { timeout: 120_000 }, async () => {
  await withTempDir(async (dir) => {
    const { packed, candidate, tarballPath } = await packCandidateInto(dir);
    const candidateCli = await installPackedCandidateCli(dir, tarballPath);
    const packedPaths = new Set(candidate.files.map((file) => file.path));
    for (const requiredPath of [
      "README.md",
      "bin/sporades.js",
      "dist/generated-source-manifest.json",
      "dist/stripe-events-runtime.js",
      "dist/stripe-payment-config.js",
      "dist/stripe-payment-integration.js",
      "dist/stripe-webhook-runtime.js",
      "dist/templates/scaffold-template.js",
      "package.json",
      "src/types/server.d.ts",
      "src/types/stripe.d.ts",
    ]) assert.equal(packedPaths.has(requiredPath), true, `packed candidate omitted ${requiredPath}`);

    const createResult = await runCliFrom(
      candidateCli.cliPath,
      ["create", "packed-blank", "--framework", "vanilla", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "packed-blank");
    await assertGeneratedLifecycleScriptAllowlist(projectDir);
    const { installed, packageRoot: installedPackageRoot, cliPath: installedCliPath } = await installPackedCandidate(projectDir, tarballPath);
    const installedPackage = JSON.parse(await readFile(path.join(installedPackageRoot, "package.json"), "utf8"));
    assert.deepEqual(installedPackage.exports["./server/stripe"], {
      types: "./src/types/stripe.d.ts",
      default: "./dist/stripe-payment-integration.js",
    });
    assert.match(installedPackage.dependencies.stripe, /^\^22\./);
    const packedContract = {
      readme: await readFile(path.join(installedPackageRoot, "README.md"), "utf8"),
      integration: await readFile(path.join(installedPackageRoot, "dist", "stripe-payment-integration.js"), "utf8"),
      events: await readFile(path.join(installedPackageRoot, "dist", "stripe-events-runtime.js"), "utf8"),
      scaffold: await readFile(path.join(installedPackageRoot, "dist", "templates", "scaffold-template.js"), "utf8"),
      serverTypes: await readFile(path.join(installedPackageRoot, "src", "types", "server.d.ts"), "utf8"),
      stripeTypes: await readFile(path.join(installedPackageRoot, "src", "types", "stripe.d.ts"), "utf8"),
      manifest: await readFile(path.join(installedPackageRoot, "dist", "generated-source-manifest.json"), "utf8"),
    };
    assert.match(packedContract.readme, /built-in but disabled Stripe payment\s+foundation/i);
    assert.match(packedContract.integration, /createCheckoutSession/);
    assert.match(packedContract.integration, /createCustomerPortalSession/);
    assert.match(packedContract.integration, /verifyWebhookEvent/);
    assert.match(packedContract.events, /dispatchVerifiedStripeEvent/);
    assert.match(packedContract.scaffold, /paymentStripeEvents/);
    assert.match(packedContract.scaffold, /payments[\s\S]{0,80}stripe[\s\S]{0,80}enabled[\s\S]{0,80}false/i);
    assert.match(packedContract.serverTypes, /stripeEvents/);
    assert.match(packedContract.serverTypes, /stripeEvent</);
    assert.match(packedContract.stripeTypes, /VerifiedStripeEvent/);
    for (const manifestPath of ["src/stripe-events-runtime.ts", "src/stripe-payment-integration.ts", "src/stripe-webhook-runtime.ts", "dist/stripe-events-runtime.js", "dist/stripe-payment-integration.js", "dist/stripe-webhook-runtime.js"]) {
      assert.match(packedContract.manifest, new RegExp(manifestPath.replaceAll(".", "\\.")));
    }
    const packedText = (await Promise.all(candidate.files.map(({ path: packedPath }) => readFile(path.join(installedPackageRoot, packedPath), "utf8").catch(() => "")))).join("\n");
    assert.doesNotMatch(packedText, /sk_test_generated_fixture|whsec_generated_fixture|obj_future_1|pending_webhooks|cs_test_generated_|test_generated_portal|Bearer sk_test_/i);

    const typechecked = await runCommand(
      process.execPath,
      [
        path.join(projectDir, "node_modules", "typescript", "bin", "tsc"),
        "--noEmit",
        "--strict",
        "--target", "ES2022",
        "--module", "ESNext",
        "--moduleResolution", "Bundler",
        "--lib", "ES2022,DOM,DOM.Iterable",
        "--skipLibCheck",
        "server/index.ts",
        "server/payments.ts",
        "shared/payments.ts",
        "shared/types.ts",
        "client/index.ts",
      ],
      { cwd: projectDir },
    );
    assert.equal(typechecked.code, 0, typechecked.stderr || typechecked.stdout);

    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const child = spawn(process.execPath, [installedCliPath, "dev", "--json"], {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(started.data.event, "started");
      assert.equal((await fetch(started.data.url)).status, 200);
      await access(path.join(projectDir, ".sporades", "build", "server.mjs"));
      assert.equal((await fetch(`${started.data.url}/stripe/webhook`, { method: "POST", body: "{}" })).status, 404);
      const dumpResult = await runCommand(process.execPath, [installedCliPath, "db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      for (const tableName of ["paymentIntents", "portalIntents"]) {
        assert.deepEqual(tables.find((table) => table.name === tableName)?.rows, []);
      }
      for (const implicitTable of ["customers", "prices", "subscriptions", "entitlements"]) {
        assert.equal(tables.some((table) => table.name === implicitTable), false);
      }
      const jobsResult = await runCommand(process.execPath, [installedCliPath, "jobs"], { cwd: projectDir });
      assert.equal(jobsResult.code, 0, jobsResult.stderr);
      assert.equal(JSON.parse(jobsResult.stdout).data.jobs.some((job) => /^stripe/i.test(job.handler)), false);
      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.doesNotMatch(serverBundle, /(?:from\s+|require\()["']stripe["']/);
      assert.match(serverBundle, /STRIPE_CHECKOUT_RESPONSE_INVALID/);
      assert.match(serverBundle, /STRIPE_PORTAL_RESPONSE_INVALID/);
      assert.match(serverBundle, /STRIPE_WEBHOOK_REJECTED/);
      // Public activation metadata names Stripe; provider mechanics and secret
      // material still belong exclusively to the server bundle.
      assert.doesNotMatch(clientBundle, /StripeResource|api\.stripe\.com|STRIPE_CHECKOUT_RESPONSE_INVALID|STRIPE_PORTAL_RESPONSE_INVALID|STRIPE_WEBHOOK_REJECTED|sk_(?:test|live)_|whsec_/);
      assert.doesNotMatch(`${packed.stdout}${packed.stderr}${candidateCli.installed.stdout}${candidateCli.installed.stderr}${createResult.stdout}${createResult.stderr}${installed.stdout}${installed.stderr}${typechecked.stdout}${typechecked.stderr}${dumpResult.stdout}${dumpResult.stderr}${jobsResult.stdout}${jobsResult.stderr}${serverBundle}${clientBundle}`, /sk_test_generated_fixture|whsec_generated_fixture|obj_future_1|pending_webhooks|cs_test_generated_|test_generated_portal|Bearer sk_test_/i);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


for (const framework of ["react", "preact"]) test(`${framework} Vite rejects a legacy client.js source shell before creating release output`, async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "vite-migration", "--framework", framework, "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vite-migration");
    await (framework === "react" ? installFakeReact : installFakePreact)(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.client.toolchain = "vite";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const before = await snapshotProjectTree(projectDir);

    await assert.rejects(createBundle(projectDir, config), (error) => {
      assert.equal(error.message, `${framework === "react" ? "React" : "Preact"}/Vite requires an author-owned source entry in index.html.`);
      assert.match(error.hint, /replace.*\/client\.js.*\/client\/index\.tsx/i);
      assert.equal(error.phase, "client");
      assert.equal(error.framework, framework);
      assert.equal(error.toolchain, "vite");
      return true;
    });
    assert.deepEqual(await snapshotProjectTree(projectDir), before, "migration preflight performs zero filesystem writes or source mutations");
    await assert.rejects(access(path.join(projectDir, ".sporades")), (error) => error.code === "ENOENT");
  });
});


test("React Vite loads project plugins while Sporades build, output, and environment invariants win", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(
      ["create", "vite-build", "--framework", "react", "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vite-build");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env"), "VITE_BROWSER_LEAK=project-env-secret\n");
    await writeFile(path.join(projectDir, ".env.local"), "VITE_LOCAL_LEAK=local-env-secret\n");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SERVER_ONLY_TOKEN=server-env-secret\n");
    await writeFile(
      path.join(projectDir, "vite.config.ts"),
      `export default {
  root: "client",
  base: "/project-base/",
  publicDir: "public",
  envFile: true,
  envPrefix: "VITE_",
  plugins: [{
    name: "project-html-marker",
    transformIndexHtml(html) { return html.replace("</head>", '<meta name="project-vite-plugin" content="loaded"></head>'); },
  }],
  build: {
    write: true,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: "client/index.tsx", output: { entryFileNames: "project-owned.js" } },
  },
};\n`,
    );
    await writeFile(
      path.join(projectDir, "postcss.config.cjs"),
      `throw new Error("project-local-postcss-config-was-loaded");\n`,
    );
    const clientPath = path.join(projectDir, "client", "index.tsx");
    await writeFile(
      clientPath,
      `${await readFile(clientPath, "utf8")}\nconsole.log(import.meta.env.VITE_BROWSER_LEAK, import.meta.env.VITE_LOCAL_LEAK, import.meta.env.VITE_PROCESS_LEAK);\n`,
    );
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    const sourceHtml = await readFile(path.join(projectDir, "index.html"), "utf8");
    const previousProcessLeak = process.env.VITE_PROCESS_LEAK;
    process.env.VITE_PROCESS_LEAK = "process-env-secret";
    let adapterOutput;
    let bundle;
    try {
      adapterOutput = await buildClientToolchain({
        projectDir,
        frameworkConfig: { framework: "react", entry: "index.tsx", loader: "tsx", jsxImportSource: "react", jsxRuntimeImport: "react/jsx-runtime" },
        toolchain: "vite",
        clientSource: await readFile(clientPath, "utf8"),
        clientSourcePath: clientPath,
        indexHtml: sourceHtml,
        indexHtmlPath: path.join(projectDir, "index.html"),
      });
      bundle = await createBundle(projectDir, config, { publishLegacy: false });
    } finally {
      if (previousProcessLeak === undefined) delete process.env.VITE_PROCESS_LEAK;
      else process.env.VITE_PROCESS_LEAK = previousProcessLeak;
    }
    assert.deepEqual(Object.keys(adapterOutput).sort(), ["diagnostics", "legacyClientBundle", "publicFiles"]);
    assert.deepEqual(adapterOutput.diagnostics, { framework: "react", toolchain: "vite", refresh: "full-page" });
    assert.equal(adapterOutput.legacyClientBundle, null);
    assert.equal(Object.hasOwn(adapterOutput, "output"), false);
    assert.equal(Object.hasOwn(adapterOutput, "rollupOutput"), false);
    try {
      const visit = async (root, current = root) => {
        const files = [];
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const file = path.join(current, entry.name);
          if (entry.isDirectory()) files.push(...await visit(root, file));
          else files.push(path.relative(root, file).split(path.sep).join("/"));
        }
        return files.sort();
      };
      const files = await visit(bundle.staticFiles.publicDir);
      assert(files.includes("index.html"), JSON.stringify(files));
      assert(files.some((file) => /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => /^assets\/index-[A-Za-z0-9_-]+\.js\.map$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => /^assets\/index-[A-Za-z0-9_-]+\.css$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => /^assets\/vite-scaffold-[A-Za-z0-9_-]+\.js$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => /^assets\/vite-scaffold-[A-Za-z0-9_-]+\.js\.map$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => /^assets\/sporades-mark-[A-Za-z0-9_-]+\.svg$/.test(file)), JSON.stringify(files));
      assert.equal(files.includes("client.js"), false);

      const transformedHtml = await readFile(path.join(bundle.staticFiles.publicDir, "index.html"), "utf8");
      assert.notEqual(transformedHtml, sourceHtml);
      assert.match(transformedHtml, /<meta name="project-vite-plugin" content="loaded">/);
      assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), sourceHtml, "Vite never rewrites author-owned source HTML");
      assert.doesNotMatch(transformedHtml, /\/client\/index\.tsx|\/client\.js/);
      assert.match(transformedHtml, /\/assets\/index-[^"']+\.js/);
      const output = (await Promise.all(files.map((file) => readFile(path.join(bundle.staticFiles.publicDir, file), "utf8")))).join("\n");
      assert.doesNotMatch(output, /project-local-postcss-config-was-loaded|project-env-secret|local-env-secret|process-env-secret|server-env-secret|SERVER_ONLY_TOKEN|project-owned\.js/);
      assert.doesNotMatch(output, /\/@vite\/client|react-refresh|vite\/hmr/i);
      assert.deepEqual(Object.keys(bundle.staticFiles).sort(), ["clientBundle", "indexHtml", "publicDir", "publicTree"]);
      assert.equal(bundle.staticFiles.clientBundle, null);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});


test("Svelte Guestbook renders query state and drives mutation loading, errors, and updates", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createSvelteTemplate(dir, "svelte-guestbook-behavior", "guestbook");
    let finishSign;
    const signCalls = [];
    const sign = { loading: false, error: null, async run(body) {
      signCalls.push(body);
      const result = await new Promise((resolve) => { finishSign = resolve; });
      return result;
    } };
    const harness = await mountSvelteTemplate(projectDir, {
      session: sessionState(), queries: { entries: { loading: true, data: null, error: null } }, mutations: { sign },
      auth: authStub(), files: {}, journey: {}, preferences: {},
    });
    try {
      assert.deepEqual(Object.keys(harness.state.stores.mutations.sign).sort(), ["run", "subscribe"]);
      assert.deepEqual(Object.keys(harness.state.counts.mutations.sign.last).sort(), ["data", "error", "loading"]);
      assert.match(harness.text(), /Loading/);
      harness.setQuery("entries", { loading: false, data: null, error: new Error("Guestbook unavailable") });
      await harness.settle();
      assert.match(harness.text(), /Guestbook unavailable/);
      harness.setQuery("entries", { loading: false, error: null, data: [{ id: "entry-1", body: "All for one", authorName: "Athos", authorPicture: "", createdAt: "2026-07-11T12:00:00.000Z" }] });
      await harness.settle();
      assert.match(harness.text(), /Athos.*All for one/s);

      const textarea = harness.find("textarea");
      await harness.setValue(textarea, "  One for all  ");
      await harness.trigger(harness.find("form"), "submit");
      assert.deepEqual(signCalls, ["One for all"]);
      assert.equal(harness.state.counts.mutations.sign.runs, 1, "component invokes the external mutation-store run method");
      assert.equal(harness.find("form button").disabled, true);
      finishSign({ data: null, error: new Error("Signing failed") });
      await harness.settle();
      assert.match(harness.text(), /Signing failed/);
      assert.equal(textarea.value, "  One for all  ");

      await harness.trigger(harness.find("form"), "submit");
      finishSign({ data: null, error: null });
      await harness.settle();
      assert.equal(textarea.value, "");
    } finally {
      await harness.unmount();
      assert.equal(harness.state.counts.session.active, 0);
      assert.equal(harness.state.counts.queries.entries.active, 0);
      assert.equal(harness.state.counts.mutations.sign.active, 0);
    }
  });
});


test("Solid Photo Library keeps authenticated uploads private and drives explicit publication", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createSolidTemplate(dir, "solid-photo-behavior", "photo-library");
    const calls = [];
    const photo = { id: "photo-private", title: "Secret crown", status: "private", fileId: "file-private", imageUrl: "", publicUrlId: "", isPublic: false };
    const mutation = (name) => ({ loading: false, data: null, error: null, async run(...args) {
      calls.push([name, ...args]);
      if (name.startsWith("updatePhoto")) {
        if (name === "updatePhotoIsPublic") photo.isPublic = args[1];
        if (name === "updatePhotoPublicUrlId") photo.publicUrlId = args[1];
        if (name === "updatePhotoImageUrl") photo.imageUrl = args[1];
        globalThis.__SPORADES_SOLID_TEMPLATE_HARNESS__.controls.queries.personalPhotos.publish({ loading: false, error: null, data: [{ ...photo }] });
      }
      return { data: null, error: null };
    } });
    const harness = await mountSolidTemplate(projectDir, {
      session: sessionState(),
      queries: { publicPhotos: { loading: false, data: [], error: null }, personalPhotos: { loading: false, data: [photo], error: null } },
      mutations: Object.fromEntries(["recordPhoto", "updatePhotoIsPublic", "updatePhotoImageUrl", "updatePhotoPublicUrlId"].map((name) => [name, mutation(name)])),
      auth: authStub(),
      files: {
        async upload(file) { calls.push(["upload", file.name]); return { id: `file-${file.name}`, name: file.name, type: file.type, size: file.size }; },
        async publicUrl(fileId) { calls.push(["publicUrl", fileId]); return { id: `url-${fileId}`, url: `https://files.example/${fileId}` }; },
        async revokePublicUrl(id) { calls.push(["revokePublicUrl", id]); return { data: null, error: null }; },
      },
      journey: {}, preferences: {},
    });
    try {
      const fileInput = harness.find('input[type="file"]');
      const form = harness.find("form");
      await harness.trigger(fileInput, "change", { files: [{ name: "guest.png", type: "image/png", size: 10 }] });
      await harness.trigger(form, "submit");
      await harness.settle();
      assert(calls.some(([name]) => name === "publicUrl"), "anonymous upload receives a public URL");

      calls.length = 0;
      harness.setSession({ ...sessionState(), auth: { userId: "google-user", provider: "google", displayName: "Aramis", isGuest: false, isAuthenticated: true } });
      await harness.settle();
      await harness.trigger(fileInput, "change", { files: [{ name: "private.png", type: "image/png", size: 11 }] });
      await harness.trigger(form, "submit");
      await harness.settle();
      assert(calls.some(([name]) => name === "upload"));
      assert.equal(calls.some(([name]) => name === "publicUrl"), false, "authenticated upload stays private by default");
      assert.match(harness.text(), /Photo saved privately/);
      assert.match(harness.text(), /My library.*Secret crown/s);

      calls.length = 0;
      await harness.trigger([...harness.findAll("button")].find((button) => button.textContent === "Make public"), "click");
      await harness.settle();
      assert.deepEqual(calls.map(([name]) => name), ["publicUrl", "updatePhotoImageUrl", "updatePhotoPublicUrlId", "updatePhotoIsPublic"]);
      calls.length = 0;
      await harness.trigger([...harness.findAll("button")].find((button) => button.textContent === "Make private"), "click");
      await harness.settle();
      assert.deepEqual(calls.map(([name]) => name), ["revokePublicUrl", "updatePhotoIsPublic", "updatePhotoImageUrl", "updatePhotoPublicUrlId"]);
    } finally {
      await harness.unmount();
      assert.equal(harness.state.counts.queries.publicPhotos.stopped, 1);
      assert.equal(harness.state.counts.queries.personalPhotos.stopped, 1);
    }
  });
});


for (const failureStage of ["journey.set", "preferences.update"]) test(`Solid Campfire direct consent handles structured ${failureStage} errors`, async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createSolidTemplate(dir, `solid-campfire-error-${failureStage.replaceAll(".", "-")}`, "campfire");
    const calls = [];
    const state = campfireHarnessState(calls, { async set(value) { calls.push(["journey.set", value]); return failureStage === "journey.set" ? { data: null, error: new Error("Journey publication failed") } : { data: null, error: null }; } });
    state.session.auth = { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false, isAuthenticated: true };
    state.preferences.get = async () => ({ data: { preferences: { campfireShareActivity: false } }, error: null });
    state.preferences.update = async (value) => { calls.push(["preferences.update", value]); return failureStage === "preferences.update" ? { data: null, error: new Error("Preference save failed") } : { data: { preferences: value }, error: null }; };
    const harness = await mountSolidTemplate(projectDir, state);
    try {
      const share = harness.find('input[type="checkbox"]'); share.checked = true; await harness.trigger(share, "change"); await harness.settle();
      assert.equal(share.checked, false);
      assert.match(harness.text(), failureStage === "journey.set" ? /Journey publication failed/ : /Preference save failed/);
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, 1);
      if (failureStage === "journey.set") assert.equal(calls.some(([name]) => name === "preferences.update"), false);
    } finally { await harness.unmount(); }
  });
});


test("Vue Campfire stale preference restore retires deferred activity without touching successor state", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createVueCampfire(dir, "vue-campfire-race");
    const calls = [];
    let resolveFirstSet;
    let firstSetStarted;
    const firstSet = new Promise((resolve) => { firstSetStarted = resolve; });
    let setCount = 0;
    const state = campfireHarnessState(calls, {
      async set(value) {
        calls.push(["journey.set", value, globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__.session.auth?.userId]);
        setCount += 1;
        if (setCount === 1) { firstSetStarted(); await new Promise((resolve) => { resolveFirstSet = resolve; }); }
        return { data: null, error: null };
      },
    });
    state.preferences.get = async () => {
      const userId = globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__.session.auth?.userId;
      calls.push(["preferences.get", userId]);
      return { data: { preferences: { campfireShareActivity: userId === "athos-user" } }, error: null };
    };
    const harness = await mountVueTemplate(projectDir, state);
    try {
      harness.state.session.auth = { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false };
      await firstSet;
      harness.state.session.auth = { userId: "porthos-user", provider: "email", displayName: "Porthos", isGuest: false };
      await harness.settle();
      const disablesBeforeStaleCompletion = calls.filter(([name]) => name === "journey.disable").length;
      resolveFirstSet();
      await harness.settle();
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, disablesBeforeStaleCompletion + 1, "deferred stale activity is retired exactly once");
      assert.equal(harness.find((node) => node.type === "input" && node.props.type === "checkbox").props.checked, false, "stale restore never exposes sharing");
      assert.equal(calls.filter(([name, _value, userId]) => name === "journey.set" && userId === "porthos-user").length, 0, "successor preference state is untouched");
      assert(calls.some(([name, userId]) => name === "preferences.get" && userId === "porthos-user"));
    } finally { harness.unmount(); }
  });
});


for (const deferredStage of ["journey.enable", "journey.set", "preferences.update"]) test(`Vue Campfire direct consent is identity-safe while ${deferredStage} is pending`, async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createVueCampfire(dir, `vue-campfire-direct-${deferredStage.replaceAll(".", "-")}`);
    const calls = [];
    let releaseStage;
    let markStageStarted;
    const stageStarted = new Promise((resolve) => { markStageStarted = resolve; });
    const waitAtStage = async (stage) => {
      if (stage !== deferredStage) return;
      markStageStarted();
      await new Promise((resolve) => { releaseStage = resolve; });
    };
    const state = campfireHarnessState(calls, {
      async enable(options) {
        const userId = globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__.session.auth?.userId;
        calls.push(["journey.enable", options, userId]);
        await waitAtStage("journey.enable");
        return { data: null, error: null };
      },
      async set(value) {
        const userId = globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__.session.auth?.userId;
        calls.push(["journey.set", value, userId]);
        await waitAtStage("journey.set");
        return { data: null, error: null };
      },
    });
    state.session.auth = { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false };
    state.preferences.get = async () => {
      const userId = globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__.session.auth?.userId;
      calls.push(["preferences.get", userId]);
      return { data: { preferences: { campfireShareActivity: false } }, error: null };
    };
    state.preferences.update = async (value) => {
      const userId = globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__.session.auth?.userId;
      calls.push(["preferences.update", value, userId]);
      await waitAtStage("preferences.update");
      return { data: { preferences: value }, error: null };
    };
    const harness = await mountVueTemplate(projectDir, state);
    try {
      const share = harness.find((node) => node.type === "input" && node.props.type === "checkbox");
      const consent = harness.trigger(share, "change", { checked: true });
      await stageStarted;
      harness.state.session.auth = { userId: "porthos-user", provider: "email", displayName: "Porthos", isGuest: false };
      await harness.settle();
      assert.equal(share.props.checked, false, "pending consent never exposes stale sharing");
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, 0, "auth retirement waits for the owned action");
      releaseStage();
      await consent;
      await harness.settle();
      assert.equal(share.props.checked, false, "stale consent remains hidden after completion");
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, 1, "stale direct activity is retired exactly once");
      assert.equal(calls.filter(([name, _value, userId]) => name === "journey.set" && userId === "porthos-user").length, 0, "successor receives no stale Journey state");
      assert.equal(calls.filter(([name, _value, userId]) => name === "preferences.update" && userId === "porthos-user").length, 0, "successor preferences are never written by stale consent");
      assert(calls.some(([name, userId]) => name === "preferences.get" && userId === "porthos-user"), "successor restore runs after stale retirement");
    } finally { harness.unmount(); }
  });
});


test("Solid Vite rejects unsupported, unloadable, and external project compiler packages", async () => {
  for (const scenario of ["version", "load", "plugin-external", "runtime-external"]) {
    await withTempDir(async (dir) => {
      const created = await runCli(["create", `solid-compiler-${scenario}`, "--framework", "solid", "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(created.code, 0, created.stderr);
      const projectDir = path.join(dir, `solid-compiler-${scenario}`);
      await installProjectSolidToolchain(projectDir, repoRoot);
      const pluginDir = path.join(projectDir, "node_modules", "vite-plugin-solid");
      if (scenario === "version" || scenario === "load") {
        await rm(pluginDir, { recursive: true, force: true });
        await mkdir(pluginDir, { recursive: true });
        await writeFile(path.join(pluginDir, "package.json"), `${JSON.stringify({
          name: "vite-plugin-solid", version: scenario === "version" ? "3.0.0" : "2.11.0", type: "module", exports: "./index.js",
        })}\n`);
        await writeFile(path.join(pluginDir, "index.js"), 'throw new Error("solid-project-plugin-load-failure");\n');
      } else {
        const packageName = scenario === "plugin-external" ? "vite-plugin-solid" : "solid-js";
        const packageDir = path.join(projectDir, "node_modules", packageName);
        await rm(packageDir, { recursive: true, force: true });
        await symlink(path.join(repoRoot, "node_modules", packageName), packageDir);
      }
      const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
      await assert.rejects(createBundle(projectDir, config), (error) => {
        assert.equal(error.phase, "client");
        assert.equal(error.framework, "solid");
        assert.equal(error.toolchain, "vite");
        assert.match(error.hint, /npm install.*vite-plugin-solid.*solid-js/i);
        if (scenario === "version") assert.match(error.message, /does not support.*vite-plugin-solid version/i);
        if (scenario === "load") assert.match(error.message, /could not load project-owned vite-plugin-solid.*solid-project-plugin-load-failure/i);
        if (scenario.endsWith("external")) assert.match(error.message, new RegExp(`could not resolve project-owned ${scenario === "plugin-external" ? "vite-plugin-solid" : "solid-js"}`, "i"));
        assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostics: error.diagnostics }), new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      });
      await assert.rejects(access(path.join(projectDir, ".sporades")), (error) => error.code === "ENOENT");
    });
  }
});





test("legacy-bound Dev rolls back client and action Bundles when replacement Runtime fails", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "activation-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "activation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const initialBundle = await createBundle(projectDir, config);
    const containerServer = await readFile(initialBundle.paths.serverBundle);
    await writeFile(path.join(projectDir, ".sporades", "binding.json"), JSON.stringify({
      containerId: "legacy-container", containerName: "legacy-container",
      clientRelease: { framework: "react", toolchain: "esbuild", publicTree: "legacy-public-tree" },
    }));

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      const before = await (await fetch(`${started.data.url}/client.js`)).text();
      const legacyServerPath = path.join(projectDir, ".sporades", "build", "server.mjs");
      const legacyClientPath = path.join(projectDir, ".sporades", "build", "client.js");
      const legacyServerBefore = await readFile(legacyServerPath, "utf8");
      assert.deepEqual(Buffer.from(legacyServerBefore), containerServer);
      const legacyClientBefore = await readFile(legacyClientPath, "utf8");
      const devSession = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      const actionBundlePath = path.join(projectDir, ".sporades", "build", ".dev-actions", devSession.actionBundleId, "server.mjs");
      const actionBefore = await readFile(actionBundlePath);
      const serverPath = path.join(projectDir, "server", "index.ts");
      const clientPath = path.join(projectDir, "client", "index.tsx");
      const serverSource = await readFile(serverPath, "utf8");
      const clientSource = await readFile(clientPath, "utf8");
      await writeFile(serverPath, `${serverSource}\nthrow new Error("replacement Runtime failed");\n`);
      await writeFile(clientPath, clientSource.replace("Blank Sporades Capsule", "Premature Runtime Capsule"));

      const failed = await waitForJsonEvent(child, (event) => !event.ok && event.data.event === "rebuild");
      assert.deepEqual(failed.data.build, { phase: "runtime", framework: "react", toolchain: "esbuild" });
      assert.match(failed.error.message, /replacement Runtime failed/);
      assert.equal(await (await fetch(`${started.data.url}/client.js`)).text(), before);
      assert.equal(await readFile(legacyServerPath, "utf8"), legacyServerBefore);
      assert.equal(await readFile(legacyClientPath, "utf8"), legacyClientBefore);
      assert.deepEqual(await readFile(actionBundlePath), actionBefore);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("failed Dev listen removes its private action Bundle with embedded Server env", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "failed-action-start", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "failed-action-start");
    await installFakeReact(projectDir);
    const occupied = createServer().listen(0, "127.0.0.1");
    try {
      await new Promise((resolve) => occupied.once("listening", resolve));
      const configPath = path.join(projectDir, "sporades.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.dev.port = occupied.address().port;
      await writeFile(configPath, `${JSON.stringify(config)}\n`);
      await writeFile(path.join(projectDir, ".env.sporades.server"), "STALE_SECRET=private-old-value\n", { mode: 0o600 });
      const failed = await runCli(["dev", "--json"], { cwd: projectDir });
      assert.notEqual(failed.code, 0);
      assert.match(failed.stdout + failed.stderr, /EADDRINUSE|address already in use/i);
      const actionRoot = path.join(projectDir, ".sporades", "build", ".dev-actions");
      assert.deepEqual(await readdir(actionRoot).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
    } finally {
      occupied.close();
    }
  });
});


test("failed Dev watcher setup removes its session and private action Bundle", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "failed-watch-start", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "failed-watch-start");
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "STALE_SECRET=watcher-old-secret\n", { mode: 0o600 });
    const preload = path.join(dir, "fail-second-watch.cjs");
    // Linux recursive watches also call fs.watch internally without recursive=true.
    await writeFile(preload, `const fs = require("node:fs");\nconst moduleApi = require("node:module");\nconst originalWatch = fs.watch;\nlet count = 0;\nfs.watch = (...args) => {\n  if (args[1]?.recursive === true && ++count === 2) throw Object.assign(new Error("injected watch failure"), { code: "EMFILE" });\n  return originalWatch(...args);\n};\nmoduleApi.syncBuiltinESMExports();\n`);
    const failed = await runCli(["dev", "--json"], { cwd: projectDir, env: { NODE_OPTIONS: `--require=${preload}` } });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stdout + failed.stderr, /injected watch failure/);
    const actionRoot = path.join(projectDir, ".sporades", "build", ".dev-actions");
    assert.deepEqual(await readdir(actionRoot).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
    await assert.rejects(access(path.join(projectDir, ".sporades", "dev-session.json")), { code: "ENOENT" });
  });
});


test("Dev action cleanup survives session metadata write and shutdown removal failures", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "action-metadata-failure", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "action-metadata-failure");
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    const sessionPath = path.join(projectDir, ".sporades", "dev-session.json");
    const actionRoot = path.join(projectDir, ".sporades", "build", ".dev-actions");
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await mkdir(sessionPath);
    const failed = await runCli(["dev", "--json"], { cwd: projectDir });
    assert.notEqual(failed.code, 0);
    assert.deepEqual(await readdir(actionRoot), []);
    await rm(sessionPath, { recursive: true });
    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      await waitForJsonEvent(child, (event) => event.data?.event === "started");
      const id = JSON.parse(await readFile(sessionPath, "utf8")).actionBundleId;
      const ownedDir = path.join(actionRoot, id);
      await access(path.join(ownedDir, "server.mjs"));
      await rm(sessionPath);
      await mkdir(sessionPath);
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("exit", resolve));
      await assert.rejects(access(ownedDir), { code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); }
    }
  });
});


test("sporades dev routes registered capsule endpoints and preserves non-matching HTTP behavior", async () => {
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
    ping: endpoint(
      { method: "POST", path: "/integrations/ping" },
      (ctx: { request: { query: Record<string, string> } }) =>
        String((ctx.request.query.source as string) ?? "missing"),
    ),
    literalEncodedPath: endpoint(
      { method: "GET", path: "/%2e%2e" },
      (ctx: { request: { path: string; query: Record<string, string> } }) =>
        JSON.stringify({ path: ctx.request.path, source: ctx.request.query.source }),
    ),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.ok(started.data, JSON.stringify(started));

      const endpointResponse = await fetch(`${started.data.url}/integrations/ping?source=test`, { method: "POST" });
      assert.equal(endpointResponse.status, 200);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^text\/plain/);
      assert.equal(await endpointResponse.text(), "test");

      for (const [target, source] of [["/%2e%2e?source=origin", "origin"], ["http://unrelated.example/%2e%2e?source=absolute", "absolute"]]) {
        const response = await rawHttpResponse(started.data.url, target, { headers: { host: "wrong.example" } });
        assert.match(response, /^HTTP\/1\.1 200 /, response);
        assert.match(response, /"path":"\/%2e%2e"/, response);
        assert.match(response, new RegExp(`"source":"${source}"`), response);
      }

      const methodMissResponse = await fetch(`${started.data.url}/integrations/ping`);
      assert.equal(methodMissResponse.status, 404);
      assert.equal(await methodMissResponse.text(), "Not found");

      const pathMissResponse = await fetch(`${started.data.url}/integrations/missing`, { method: "POST" });
      assert.equal(pathMissResponse.status, 404);
      assert.equal(await pathMissResponse.text(), "Not found");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev endpoint handlers can read and write Capsule data with the table API", async () => {
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
        body: ctx.db.todos
          .where("ownerId", ctx.auth.userId)
          .orderBy("createdAt", "desc")
          .all(),
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

      const endpointResponse = await fetch(`${started.data.url}/integrations/todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "From endpoint" }),
      });
      assert.equal(endpointResponse.status, 200);
      const rows = await endpointResponse.json();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].text, "From endpoint");
      assert.equal(rows[0].done, false);
      assert.equal(typeof rows[0].id, "string");
      assert.equal(typeof rows[0].createdAt, "string");
      assert.equal(typeof rows[0].updatedAt, "string");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades auth as email returns a localStorage session payload that resolves through auth.get", async () => {
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
    await writeFile(path.join(projectDir, "server", "index.ts"), `import { capsule } from "sporades/server";\nexport default capsule({ name: "auth-island", auth: { registration: { admit: ({ admission }) => ({ allow: admission === undefined || admission?.admission === null || admission?.invitation === "invite-1" }), finalize: async () => {} } } });\n`);
    await installFakeReact(projectDir);

    const admissionAtLimit = { invitation: "invite-1", padding: "" }; admissionAtLimit.padding = "x".repeat(4096 - Buffer.byteLength(JSON.stringify(admissionAtLimit)));
    const encodedAtLimit = JSON.stringify(admissionAtLimit); assert.equal(Buffer.byteLength(encodedAtLimit), 4096);
    const encodedOverLimit = `${encodedAtLimit.slice(0, -3)}é"}`; assert.equal(Buffer.byteLength(encodedOverLimit), 4097);
    for (const admission of ["{", encodedOverLimit]) {
      const rejected = await runCli(["auth", "as", "email", "--email", "mira@example.com", "--registration", admission, "--json"], { cwd: projectDir });
      assert.equal(rejected.code, 1); assert.match(JSON.parse(rejected.stdout).error.message, /Registration admission input/);
    }

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    let expiredSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const omitted = await runCli(["auth", "as", "email", "--email", "omitted@example.com", "--json"], { cwd: projectDir }); assert.equal(omitted.code, 0, omitted.stderr);
      const explicitNull = await runCli(["auth", "as", "email", "--email", "nested-null@example.com", "--registration", '{"admission":null}', "--json"], { cwd: projectDir }); assert.equal(explicitNull.code, 0, explicitNull.stderr);

      const simulated = await runCli(
        [
          "auth",
          "as",
          "email",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira Vale",
          "--registration",
          encodedAtLimit,
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const body = JSON.parse(simulated.stdout);
      assert.equal(body.ok, true);
      assert.equal(body.error, null);
      assert.equal(body.data.localStorage.key, "sporades.sessionToken");
      assert.equal(typeof body.data.localStorage.value, "string");
      assert.deepEqual(body.data.auth, {
        userId: body.data.auth.userId,
        displayName: "Mira Vale",
        email: "mira@example.com",
        picture: null,
        isAuthenticated: true,
        isGuest: false,
        provider: "email",
      });
      const { DatabaseSync } = await import("node:sqlite");
      const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
      try {
        const storedSession = sqlite
          .prepare("SELECT expiresAt FROM sporades_auth_sessions WHERE token = ?")
          .get(body.data.localStorage.value);
        assert.match(storedSession.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.ok(Date.parse(storedSession.expiresAt) > Date.now());
      } finally {
        sqlite.close();
      }

      socket = await openSocket(started.data.url, body.data.localStorage.value);
      socket.send(JSON.stringify({ id: "auth-after-simulation", type: "auth.get" }));
      const resolved = await readSocketMessage(socket);
      assert.deepEqual(resolved.data.auth, body.data.auth);
      assert.equal(resolved.data.sessionToken, body.data.localStorage.value);

      const expiringSqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
      try {
        expiringSqlite
          .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?")
          .run("2000-01-01T00:00:00.000Z", body.data.localStorage.value);
      } finally {
        expiringSqlite.close();
      }
      socket.close();
      socket = null;

      expiredSocket = await openSocket(started.data.url, body.data.localStorage.value);
      expiredSocket.send(JSON.stringify({ id: "auth-expired-simulation", type: "auth.get" }));
      const expiredResolved = await readSocketMessage(expiredSocket);
      assert.equal(expiredResolved.data.auth.provider, "anonymous");
      assert.notEqual(expiredResolved.data.sessionToken, body.data.localStorage.value);
    } finally {
      socket?.close();
      expiredSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades auth clients --json lists a connected browser client with safe metadata", async () => {
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
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);

      const listed = await runCli(["auth", "clients", "--json"], { cwd: projectDir });
      assert.equal(listed.code, 0, listed.stderr);
      const body = JSON.parse(listed.stdout);
      assert.equal(body.ok, true);
      assert.equal(body.data.clients.length, 1);
      assert.match(body.data.clients[0].id, /^client-[a-z0-9]+$/);
      assert.equal(body.data.clients[0].auth.provider, "anonymous");
      assert.equal(body.data.clients[0].auth.isAuthenticated, false);
      assert.equal(body.data.clients[0].auth.email, null);
      assert.equal(typeof body.data.clients[0].connectedAt, "string");
      assert.equal(typeof body.data.clients[0].lastSeenAt, "string");

      const rawJson = JSON.stringify(body);
      assert.equal(rawJson.includes("sessionToken"), false);
      assert.equal(rawJson.includes("localStorage"), false);
      assert.equal(rawJson.includes("token"), false);
      assert.equal(rawJson.includes("password"), false);
      assert.equal(rawJson.includes("secret"), false);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades auth clients returns a structured error when the dev server lacks client listing support", async () => {
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
      const result = await runCli(["auth", "clients", "--port", String(server.address().port), "--json"], {
        cwd: projectDir,
      });
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Dev session does not support auth client listing.",
          hint: "Start a current `sporades dev` session for this project, then retry `sporades auth clients`.",
        },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});


test("sporades auth as email --client current delivers the session to the most recently connected browser client", async () => {
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
    let currentSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      firstSocket = await openSocket(started.data.url);
      currentSocket = await openSocket(started.data.url);
      const deliveredToCurrent = readSocketMessage(currentSocket);

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
        delivered: true,
        clients: 1,
      });

      const delivery = await deliveredToCurrent;
      assert.deepEqual(delivery, {
        id: null,
        type: "auth.session.replace",
        data: {
          sessionToken: body.data.localStorage.value,
          auth: body.data.auth,
        },
        error: null,
      });

      firstSocket.send(JSON.stringify({ id: "first-auth", type: "auth.get" }));
      const firstAuth = await readSocketMessage(firstSocket);
      assert.equal(firstAuth.id, "first-auth");
      assert.equal(firstAuth.data.auth.provider, "anonymous");

      currentSocket.send(JSON.stringify({ id: "current-auth", type: "auth.get" }));
      const currentAuth = await readSocketMessage(currentSocket);
      assert.equal(currentAuth.id, "current-auth");
      assert.deepEqual(currentAuth.data.auth, body.data.auth);
      assert.equal(currentAuth.data.sessionToken, body.data.localStorage.value);
    } finally {
      firstSocket?.close();
      currentSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades auth as email --client all delivers the session to every connected browser client", async () => {
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
      const deliveredToFirst = readSocketMessage(firstSocket);
      const deliveredToSecond = readSocketMessage(secondSocket);

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
          "all",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const body = JSON.parse(simulated.stdout);
      assert.equal(body.ok, true);
      assert.deepEqual(body.data.delivery, {
        target: "all",
        delivered: true,
        clients: 2,
      });

      const firstDelivery = await deliveredToFirst;
      const secondDelivery = await deliveredToSecond;
      assert.equal(firstDelivery.type, "auth.session.replace");
      assert.equal(firstDelivery.data.sessionToken, body.data.localStorage.value);
      assert.deepEqual(firstDelivery.data.auth, body.data.auth);
      assert.equal(secondDelivery.type, "auth.session.replace");
      assert.equal(secondDelivery.data.sessionToken, body.data.localStorage.value);
      assert.deepEqual(secondDelivery.data.auth, body.data.auth);
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev returns structured endpoint errors without crashing the session", async () => {
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
    broken: endpoint({ method: "POST", path: "/integrations/broken" }, () => {
      throw new Error("broken integration");
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const endpointResponse = await fetch(`${started.data.url}/integrations/broken`, { method: "POST" });
      assert.equal(endpointResponse.status, 500);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(await endpointResponse.json(), {
        ok: false,
        data: null,
        error: {
          message: "Endpoint handler failed.",
          hint: "Check the endpoint handler and retry the request.",
        },
      });

      const rootResponse = await fetch(started.data.url);
      assert.equal(rootResponse.status, 200);
      assert.match(await rootResponse.text(), /<script type="module" src="\/client\.js"><\/script>/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


for (const capability of CLIENT_CAPABILITIES) test(`matrix Dev conformance preserves last-good output and recovers for ${capability.framework}/${capability.toolchain}`, async () => {
  await withTempDir(async (dir) => {
    const name = `matrix-${capability.framework}-${capability.toolchain}`;
    const created = await runCli(["create", name, "--template", "todo", "--framework", capability.framework, "--toolchain", capability.toolchain, "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, name);
    await (capability.framework === "vanilla" ? async () => {}
      : capability.framework === "react" ? installFakeReact
      : capability.framework === "preact" ? installFakePreact
      : capability.framework === "inferno" ? (project) => installProjectInfernoToolchain(project, repoRoot)
      : capability.framework === "lit" ? (project) => installProjectLitToolchain(project, repoRoot)
      : capability.framework === "solid" ? (project) => installProjectSolidToolchain(project, repoRoot)
      : capability.framework === "vue" ? installVue
      : installSvelte)(projectDir);
    const clientPath = path.join(projectDir, "client", capability.build.entry);
    const authored = await readFile(clientPath, "utf8");
    await Promise.all([
      writeFile(path.join(projectDir, "client", "matrix-nested.ts"), 'import icon from "./matrix.svg"; import font from "./matrix.woff2"; export const matrixAsset = `${icon}:${font}`;\n'),
      writeFile(path.join(projectDir, "client", "matrix.css"), '@font-face{font-family:Matrix;src:url("./matrix.woff2")} .matrix-proof{background:url("./matrix.svg")}\n'),
      writeFile(path.join(projectDir, "client", "matrix.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>\n'),
      writeFile(path.join(projectDir, "client", "matrix.woff2"), "matrix-font-bytes\n"),
    ]);
    const original = `${authored}\nimport "./matrix.css"; import("./matrix-nested.ts").then(({ matrixAsset }) => console.log(matrixAsset));\n`;
    await writeFile(clientPath, original);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8")); config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket, messages;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url); messages = captureSocketMessages(socket);
      const behavior = capability.framework === "vanilla" ? { query: "notes", mutation: "addNote" } : { query: "todos", mutation: "addTodo" };
      socket.send(JSON.stringify({ id: "matrix-auth", type: "auth.get" }));
      assert.equal((await messages.next((message) => message.id === "matrix-auth")).type, "auth.result");
      socket.send(JSON.stringify({ id: "matrix-query", type: "query.subscribe", query: behavior.query }));
      assert.deepEqual((await messages.next((message) => message.id === "matrix-query")).data, []);
      socket.send(JSON.stringify({ id: "matrix-mutation", type: "mutation.run", mutation: behavior.mutation, args: [`matrix ${capability.framework}/${capability.toolchain}`] }));
      assert.equal((await messages.next((message) => message.id === "matrix-mutation")).type, "mutation.result");
      assert.equal((await messages.next((message) => message.id === "matrix-query")).data[0].text, `matrix ${capability.framework}/${capability.toolchain}`);
      socket.send(JSON.stringify({ id: "matrix-refresh", type: "dev.refresh.subscribe" }));
      assert.deepEqual((await messages.next((message) => message.id === "matrix-refresh")).data, { mode: "full-page", sequence: 0 });
      const entryUrl = capability.toolchain === "esbuild" ? `${started.data.url}/client.js` : started.data.url;
      const first = await fetch(entryUrl);
      assert.equal(first.status, 200);
      assert.match(first.headers.get("content-type") ?? "", capability.toolchain === "esbuild" ? /javascript/ : /text\/html/);
      const normalize = (text) => text.replace(/window\.__SPORADES_CONNECTION_TOKEN="[^"]+"/, 'window.__SPORADES_CONNECTION_TOKEN="<token>"');
      const lastGood = normalize(await first.text());
      const active = JSON.parse(await readFile(path.join(projectDir, ".sporades", "build", ".public-trees", "active.json"), "utf8"));
      const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", active.tree);
      const visit = async (root, current = root) => (await Promise.all((await readdir(current, { withFileTypes: true })).map(async (entry) => {
        const target = path.join(current, entry.name);
        return entry.isDirectory() ? visit(root, target) : path.relative(root, target).split(path.sep).join("/");
      }))).flat().sort();
      const publicFiles = await visit(publicRoot);
      assert(publicFiles.some((file) => file.includes("/") && file.endsWith(".js")), JSON.stringify(publicFiles));
      for (const extension of [".js", ".js.map", ".css", ".svg", ".woff2"]) assert(publicFiles.some((file) => file.endsWith(extension)), `${capability.framework}/${capability.toolchain} emits ${extension}: ${publicFiles}`);
      const mime = { ".html": /text\/html/, ".js": /javascript/, ".map": /json/, ".css": /text\/css/, ".svg": /image\/svg\+xml/, ".woff": /font\/woff/, ".woff2": /font\/woff2/ };
      for (const file of publicFiles) {
        assert(!file.startsWith("/") && !file.split("/").includes("..") && !file.includes("\\"), file);
        const response = await fetch(`${started.data.url}/${file}`);
        assert.equal(response.status, 200, file);
        const extension = file.endsWith(".js.map") ? ".map" : path.extname(file);
        if (mime[extension]) assert.match(response.headers.get("content-type") ?? "", mime[extension], file);
        assert((await response.arrayBuffer()).byteLength > 0, file);
      }
      const nested = await fetch(`${started.data.url}/nested/route`);
      assert.equal(nested.status, 404); assert.match(nested.headers.get("content-type") ?? "", /text\/plain/);
      assert.equal((await fetch(`${started.data.url}/%2e%2e/server/index.ts`)).status, 404);
      await writeFile(clientPath, `${original}\nexport const = ;\n`);
      const failed = await waitForJsonEvent(child, (event) => !event.ok && event.data?.event === "rebuild" && event.data.status === "failed");
      assert.deepEqual(failed.data.build, { phase: "client", framework: capability.framework, toolchain: capability.toolchain });
      assert.equal(messages.history.filter((message) => message.type === "refresh").length, 0, "failed edits never request refresh");
      assert.equal(normalize(await (await fetch(entryUrl)).text()), lastGood);
      const refresh = messages.next((message) => message.type === "refresh");
      await writeFile(clientPath, `${original}\n// matrix recovery\n`);
      const refreshMessage = await refresh;
      assert.equal(refreshMessage.data.mode, "full-page");
      socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: refreshMessage.data.sequence }));
      const recovered = await waitForJsonEvent(child, (event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(recovered.data.build, { phase: "client", framework: capability.framework, toolchain: capability.toolchain });
      assert.equal(recovered.data.refresh.clientsAttempted, 1);
      assert.equal(recovered.data.refresh.clientsDelivered, 1);
      assert.equal(recovered.data.refresh.clientsTimedOut, 0);
      assert.doesNotMatch(await (await fetch(entryUrl)).text(), /SERVER_ONLY|server-only|\/@vite\/client|react-refresh|vite\/hmr/i);
    } finally {
      messages?.dispose(); socket?.close();
      child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev restarts server runtime and accepts new WebSocket connections after rebuild", async () => {
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
          "todos: table({",
          `notes: table({
      text: String(),
    }),
    todos: table({`,
        ),
      );

      const [rebuilt] = await pendingSchemaRebuild;
      assert.equal(rebuilt.error, null);

      reconnectedSocket = await openSocket(started.data.url);
      reconnectedSocket.send(JSON.stringify({ id: "query-1", type: "query.subscribe", query: "todos" }));
      assert.deepEqual(await readSocketMessage(reconnectedSocket), {
        id: "query-1",
        type: "query.result",
        query: "todos",
        data: [],
        error: null,
      });

      const listResult = await runCli(["db", "list", "--json"], { cwd: projectDir });
      assert.equal(listResult.code, 0, listResult.stderr);
      assert.deepEqual(JSON.parse(listResult.stdout).data.tables, [
        "notes",
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
      ]);
    } finally {
      reconnectedSocket?.close();
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev does not log a capsule reload for a client-only change", async () => {
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

      const clientPath = path.join(projectDir, "client", "index.tsx");
      const originalClient = await readFile(clientPath, "utf8");
      await writeFile(clientPath, `${originalClient}\nconsole.log("client-only edit");\n`);

      const rebuilt = await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );
      assert.equal(rebuilt.error, null);
      assert.equal(rebuilt.data.build.phase, "client");

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const entries = JSON.parse(logsResult.stdout).data.entries;

      assert.equal(entries.some((entry) => entry.event === "dev.capsule.reloaded"), false);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev treats Date fields without defaults as nullable in a fresh database", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "fresh-date-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "fresh-date-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, Date, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "Fresh Dates",
  schema: {
    todos: table({
      text: String(),
      dueAt: Date(),
      ownerId: String(),
    }),
  },
  queries: {
    todos: query((ctx) => ctx.db.todos.where("ownerId", ctx.auth.userId).all()),
  },
  mutations: {
    recordTodo: mutation((ctx, text, dueAt) => {
      ctx.db.todos.insert({
        text,
        dueAt: dueAt === null ? null : new globalThis.Date(dueAt),
        ownerId: ctx.auth.userId,
      });
    }),
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

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      const recordNullDateResultPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "record-null-date" && message.type === "mutation.result",
      );
      const rowsWithNullDatePromise = waitForSocketMessage(
        socket,
        (message) => message.id === "todos" && message.data.some((todo) => todo.text === "No date yet"),
      );
      socket.send(
        JSON.stringify({
          id: "record-null-date",
          type: "mutation.run",
          mutation: "recordTodo",
          args: ["No date yet", null],
        }),
      );
      assert.equal((await recordNullDateResultPromise).error, null);
      const rowsWithNullDate = await rowsWithNullDatePromise;
      assert.equal(rowsWithNullDate.data.find((todo) => todo.text === "No date yet").dueAt, null);

      const recordJsDateResultPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "record-js-date" && message.type === "mutation.result",
      );
      const rowsWithJsDatePromise = waitForSocketMessage(
        socket,
        (message) =>
          message.id === "todos" &&
          message.data.some((todo) => todo.text === "Has date" && todo.dueAt === "2026-06-01T11:12:13.000Z"),
      );
      socket.send(
        JSON.stringify({
          id: "record-js-date",
          type: "mutation.run",
          mutation: "recordTodo",
          args: ["Has date", "2026-06-01T11:12:13.000Z"],
        }),
      );
      assert.equal((await recordJsDateResultPromise).error, null);
      await rowsWithJsDatePromise;

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const todosTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "todos");
      assert.equal(todosTable.rows.find((row) => row.text === "No date yet").dueAt, null);
      assert.equal(todosTable.rows.find((row) => row.text === "Has date").dueAt, "2026-06-01T11:12:13.000Z");
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


test("sporades dev applies additive Json field migrations with decoded defaults", async () => {
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
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(socket)).data.sessionToken;
      socket.send(JSON.stringify({ id: "todos-before", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);
      socket.send(JSON.stringify({ id: "add-before", type: "mutation.run", mutation: "addTodo", args: ["Keep me"] }));
      assert.equal((await readSocketMessage(socket)).error, null);
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
          .replace("import { Boolean,", "import { Boolean, Json,")
          .replace(
            "done: Boolean().default(false),",
            `done: Boolean().default(false),
      meta: Json().default({ tags: ["migrated"], archived: false }),`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `updateTodoMeta: mutation((ctx, id: string, meta: unknown) => {
      ctx.db.todos.update(id, { meta });
    }),

    addTodo: mutation((ctx, text: string) => {`,
          ),
      );

      const [rebuilt] = await pendingSchemaRebuild;
      assert.equal(rebuilt.error, null);
      socket = null;

      migratedSocket = await openSocket(started.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "todos-after", type: "query.subscribe", query: "todos" }));
      const migratedRows = await readSocketMessage(migratedSocket);
      assert.equal(migratedRows.error, null);
      assert.deepEqual(migratedRows.data[0].meta, { tags: ["migrated"], archived: false });

      const updatedMeta = { tags: ["after"], nested: { count: 1 }, values: [true, null, "ok"] };
      const updatedRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "todos-after" && message.data[0]?.meta?.nested?.count === 1,
      );
      migratedSocket.send(
        JSON.stringify({
          id: "update-meta",
          type: "mutation.run",
          mutation: "updateTodoMeta",
          args: [migratedRows.data[0].id, updatedMeta],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).error, null);
      const updatedRows = await updatedRowsPromise;
      assert.deepEqual(updatedRows.data[0].meta, updatedMeta);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const todosTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "todos");
      assert.match(todosTable.rows[0].meta, /^\{/);
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


test("sporades dev handles missing server env files gracefully", async () => {
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
    await rm(path.join(projectDir, ".env.sporades.server"));
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev rejects unsupported auth providers with structured JSON", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.auth = {
      providers: {
        anonymous: true,
        mastodon: true,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const result = await runCli(["dev", "--json"], { cwd: projectDir });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unsupported auth provider: mastodon",
        hint: "Use supported auth providers: anonymous, email, google, microsoft, apple, facebook.",
      },
    });
  });
});


test("sporades logs expose runtime-owned Privileged audit events without letting ctx.log forge them", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "audit-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "audit-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "WEBHOOK_SECRET=env-secret-123\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "Audit Island",
  endpoints: {
    forge: endpoint({ method: "POST", path: "/forge-audit" }, (ctx) => {
      ctx.log.info("forged audit", {
        category: "audit",
        event: "privileged.succeeded",
        actorKind: "privileged-server-role",
        safe: "ordinary app data",
      });
      return { status: 200, body: { ok: true } };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], {
      cwd: projectDir,
      env: { SPORADES_TEST_ENABLE_PRIVILEGED_AUDIT_DEBUG: "1" },
    });
    try {
      const started = await waitForJsonLine(child);
      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));

      const forgedResponse = await fetch(`${started.data.url}/forge-audit`, { method: "POST" });
      assert.equal(forgedResponse.status, 200);

      const auditResponse = await fetch(`${started.data.url}/__sporades/debug/privileged-audit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sporades-inspection-token": session.inspectionToken,
        },
        body: JSON.stringify({
          actorKind: "privileged-server-role",
          operation: "runtime.audit.inspect",
          surface: "sporades/dev-debug",
          correlation: { id: "corr-dev-audit" },
          targetResourceKind: "log-index",
          outcome: "completed",
          source: "runtime",
          metadata: {
            visible: "safe",
            authorization: "Bearer should-not-leak",
            rawRequestBody: { secret: "raw-body-secret" },
          },
        }),
      });
      assert.equal(auditResponse.status, 200);

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const logs = JSON.parse(logsResult.stdout);
      assert.equal(logs.ok, true);

      const auditEvents = logs.data.entries.filter((entry) => entry.category === "audit");
      assert.equal(auditEvents.length, 1);
      const [auditEvent] = auditEvents;
      assert.equal(auditEvent.event, "privileged.completed");
      assert.equal(auditEvent.data.schema, "sporades.privileged-audit.v1");
      assert.equal(auditEvent.data.actorKind, "privileged-server-role");
      assert.equal(auditEvent.data.operation, "runtime.audit.inspect");
      assert.equal(auditEvent.data.surface, "sporades/dev-debug");
      assert.deepEqual(auditEvent.correlation, { id: "corr-dev-audit" });
      assert.equal(auditEvent.data.targetResourceKind, "log-index");
      assert.equal(auditEvent.data.outcome, "completed");
      assert.equal(auditEvent.data.metadata.visible, "safe");
      assert.equal(auditEvent.data.metadata.authorization, "[REDACTED]");
      assert.equal(auditEvent.data.metadata.rawRequestBody, "[REDACTED]");
      assert.equal(JSON.stringify(auditEvent).includes("should-not-leak"), false);
      assert.equal(JSON.stringify(auditEvent).includes("raw-body-secret"), false);

      const forgedLog = logs.data.entries.find((entry) => entry.message === "forged audit");
      assert.equal(forgedLog.category, "app");
      assert.equal(forgedLog.event, "ctx.log");
      assert.equal(forgedLog.data.category, "audit");
      assert.equal(forgedLog.data.event, "privileged.succeeded");

      const tailResult = await runCli(["logs", "tail", "--json"], { cwd: projectDir });
      assert.equal(tailResult.code, 0, tailResult.stderr);
      const tailEvents = tailResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(tailEvents.some((entry) => entry.category === "audit" && entry.event === "privileged.completed"), true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("a scaffolded Campfire proves fixtures, chat, reactions, and consented Journey over public WebSocket behavior", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "campfire-island", "--template", "campfire", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "campfire-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    const sockets = [];
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      const athos = await openSocket(started.data.url);
      const porthos = await openSocket(started.data.url);
      const aramis = await openSocket(started.data.url);
      const dartagnan = await openSocket(started.data.url);
      sockets.push(athos, porthos, aramis, dartagnan);

      async function request(socket, message) {
        const response = waitForSocketMessage(socket, (candidate) => candidate.id === message.id);
        socket.send(JSON.stringify(message));
        return response;
      }

      const emptyChannels = await request(athos, { id: "channels-empty", type: "query.subscribe", query: "channels" });
      assert.deepEqual(emptyChannels.data, [], "starting Campfire must not seed demo fixtures implicitly");

      const athosSignup = await request(athos, { id: "athos-signup", type: "auth.signUp", provider: "email", credentials: { email: "athos@campfire.example", password: "all-for-one-campfire", name: "Athos" } });
      const porthosSignup = await request(porthos, { id: "porthos-signup", type: "auth.signUp", provider: "email", credentials: { email: "porthos@campfire.example", password: "all-for-one-campfire", name: "Porthos" } });
      const aramisSignup = await request(aramis, { id: "aramis-signup", type: "auth.signUp", provider: "email", credentials: { email: "aramis@campfire.example", password: "all-for-one-campfire", name: "Aramis" } });
      const dartagnanSignup = await request(dartagnan, { id: "dartagnan-signup", type: "auth.signUp", provider: "email", credentials: { email: "dartagnan@campfire.example", password: "all-for-one-campfire", name: "d'Artagnan" } });
      assert.equal(athosSignup.error, null);
      assert.equal(porthosSignup.error, null);
      assert.equal(aramisSignup.error, null);
      assert.equal(dartagnanSignup.error, null);
      const athosSecondSession = await openSocket(started.data.url, athosSignup.data.sessionToken);
      sockets.push(athosSecondSession);
      await request(athos, { id: "register-athos", type: "mutation.run", mutation: "registerFixture", args: ["athos"] });
      await request(porthos, { id: "register-porthos", type: "mutation.run", mutation: "registerFixture", args: ["porthos"] });
      await request(aramis, { id: "register-aramis", type: "mutation.run", mutation: "registerFixture", args: ["aramis"] });
      await request(dartagnan, { id: "register-dartagnan", type: "mutation.run", mutation: "registerFixture", args: ["dartagnan"] });
      await request(athos, { id: "ordinary-before-seed", type: "mutation.run", mutation: "sendMessage", args: [{ channel: "general", body: "An ordinary message arrived first." }] });
      const firstSeed = await request(athos, { id: "seed-first", type: "mutation.run", mutation: "seedCampfire", args: [] });
      const secondSeed = await request(athos, { id: "seed-second", type: "mutation.run", mutation: "seedCampfire", args: [] });
      assert.deepEqual({ created: firstSeed.data.created.length, alreadyPresent: firstSeed.data.alreadyPresent.length, failed: firstSeed.data.failed.length }, { created: 8, alreadyPresent: 0, failed: 0 });
      assert.deepEqual({ created: secondSeed.data.created.length, alreadyPresent: secondSeed.data.alreadyPresent.length, failed: secondSeed.data.failed.length }, { created: 0, alreadyPresent: 8, failed: 0 });
      const dump = JSON.parse((await runCli(["db", "dump", "--json"], { cwd: projectDir })).stdout).data.tables;
      assert.equal(dump.find((table) => table.name === "channels").rows.length, 4);
      assert.equal(dump.find((table) => table.name === "messages").rows.length, 5);
      assert.equal(dump.find((table) => table.name === "messages").rows.filter((row) => row.seedKey === "general-welcome").length, 1);
      assert.equal(dump.find((table) => table.name === "profiles").rows.length, 4);

      const crownBefore = await request(athos, { id: "messages-athos", type: "query.subscribe", query: "messagesProtectTheCrown" });
      await request(porthos, { id: "messages-porthos", type: "query.subscribe", query: "messagesProtectTheCrown" });
      assert.ok(crownBefore.data.every((row) => row.channel === "protect-the-crown"), "server query must omit other-channel rows");
      const porthosRefresh = waitForSocketMessage(porthos, (message) => message.query === "messagesProtectTheCrown" && message.data?.some((row) => row.body === "Hold the western gate."));
      const sent = await request(athos, { id: "send-message", type: "mutation.run", mutation: "sendMessage", args: [{ channel: "protect-the-crown", body: "  Hold the western gate.  ", authorId: porthosSignup.data.auth.userId }] });
      assert.equal(sent.error, null);
      const porthosMessages = await porthosRefresh;
      const durableMessage = porthosMessages.data.find((row) => row.body === "Hold the western gate.");
      assert.equal(durableMessage.authorId, athosSignup.data.auth.userId, "server must ignore attempted client authorship");
      assert.equal(porthosMessages.data.find((row) => row.id === durableMessage.id).authorName, "Athos");
      assert.equal((await request(athos, { id: "empty-message", type: "mutation.run", mutation: "sendMessage", args: [{ channel: "general", body: "  " }] })).error.message, "Write a message before sending.");
      assert.equal((await request(athos, { id: "long-message", type: "mutation.run", mutation: "sendMessage", args: [{ channel: "general", body: "x".repeat(501) }] })).error.message, "Messages must be 500 characters or fewer.");

      async function toggle(socket, id, kind) {
        const refreshA = waitForSocketMessage(athos, (message) => message.query === "messagesProtectTheCrown");
        const refreshP = waitForSocketMessage(porthos, (message) => message.query === "messagesProtectTheCrown");
        const result = await request(socket, { id, type: "mutation.run", mutation: "toggleReaction", args: [{ messageId: durableMessage.id, kind, userId: "forged-user" }] });
        const refreshed = await Promise.all([refreshA, refreshP]);
        const message = refreshed[0].data.find((row) => row.id === durableMessage.id);
        return { result, keys: Object.keys(message.reactions) };
      }
      assert.equal((await toggle(athos, "up-on", "up")).result.data.active, true);
      const withBoth = await toggle(athos, "down-on", "down");
      assert.deepEqual(withBoth.keys.sort(), [`${athosSignup.data.auth.userId}:down`, `${athosSignup.data.auth.userId}:up`].sort());
      const removedUp = await toggle(athos, "up-off", "up");
      assert.equal(removedUp.result.data.active, false);
      assert.deepEqual(removedUp.keys, [`${athosSignup.data.auth.userId}:down`]);
      const porthosUp = await toggle(porthos, "porthos-up", "up");
      assert.ok(porthosUp.keys.includes(`${porthosSignup.data.auth.userId}:up`));
      const raced = await Promise.all([
        request(athos, { id: "race-up-1", type: "mutation.run", mutation: "toggleReaction", args: [{ messageId: durableMessage.id, kind: "up" }] }),
        request(athosSecondSession, { id: "race-up-2", type: "mutation.run", mutation: "toggleReaction", args: [{ messageId: durableMessage.id, kind: "up" }] }),
        request(athos, { id: "race-up-3", type: "mutation.run", mutation: "toggleReaction", args: [{ messageId: durableMessage.id, kind: "up" }] }),
      ]);
      assert.ok(raced.every((result) => result.error === null));
      const messageDump = JSON.parse((await runCli(["db", "dump", "--json"], { cwd: projectDir })).stdout).data.tables.find((table) => table.name === "messages").rows;
      const durableAfterRace = messageDump.find((row) => row.id === durableMessage.id);
      assert.ok(Object.keys(durableAfterRace.reactions).filter((key) => key === `${athosSignup.data.auth.userId}:up`).length <= 1, "durable reaction map structurally permits at most one user/kind entry after a race");

      const gated = await request(athos, { id: "journey-gated", type: "journey.set", state: { status: "typing", metadata: { channel: "general" }, ttlSeconds: 1 } });
      assert.equal(gated.error.code, "JOURNEY_NOT_ENABLED");
      assert.equal((await request(athos, { id: "journey-enable", type: "journey.enable", options: { capture: { navigation: false, focus: false, interactions: false } } })).error, null);
      await request(porthos, { id: "journey-subscribe", type: "journey.subscribe" });
      const typingEvent = waitForSocketMessage(porthos, (message) => message.type === "journey.event" && message.data?.state?.status === "typing");
      const typing = await request(athos, { id: "journey-typing", type: "journey.set", state: { status: "typing", metadata: { channel: "general" }, ttlSeconds: 1 } });
      assert.equal(typing.error, null);
      const published = (await typingEvent).data.state;
      assert.deepEqual(published.metadata, { channel: "general" });
      assert.doesNotMatch(JSON.stringify(published), /athos@|all-for-one|Hold the western|messageId|https?:|\?/i);
      const late = await openSocket(started.data.url);
      sockets.push(late);
      const lateSnapshot = await request(late, { id: "late-subscribe", type: "journey.subscribe" });
      assert.equal(lateSnapshot.data.type, "snapshot");
      assert.ok(lateSnapshot.data.states.some((state) => state.sessionId === published.sessionId));
      const expired = await waitForSocketMessage(porthos, (message) => message.type === "journey.event" && message.data?.type === "removed" && message.data?.state?.sessionId === published.sessionId);
      assert.equal(expired.data.state.status, "typing");

      const readingEvent = waitForSocketMessage(porthos, (message) => message.type === "journey.event" && message.data?.state?.status === "reading");
      await request(athos, { id: "journey-reading", type: "journey.set", state: { status: "reading", metadata: { channel: "ideas" }, ttlSeconds: 12 } });
      await readingEvent;
      const removed = waitForSocketMessage(porthos, (message) => message.type === "journey.event" && message.data?.type === "removed");
      await request(athos, { id: "journey-disable", type: "journey.disable" });
      await removed;
      assert.equal((await request(athos, { id: "journey-after-disable", type: "journey.set", state: { status: "reading" } })).error.code, "JOURNEY_NOT_ENABLED");
      await request(athos, { id: "journey-enable-again", type: "journey.enable", options: {} });
      await request(athos, { id: "journey-before-signout", type: "journey.set", state: { status: "reading", metadata: { channel: "random" }, ttlSeconds: 12 } });
      await request(athos, { id: "athos-signout", type: "auth.signOut" });
      assert.equal((await request(athos, { id: "journey-after-auth", type: "journey.set", state: { status: "reading" } })).error.code, "JOURNEY_NOT_ENABLED");
    } finally {
      for (const socket of sockets) socket.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev rolls back multi-write App message app-table failures", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "message-rollback-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "message-rollback-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, message, String, table } from "sporades/server";

export default capsule({
  name: "message-rollback-island",

  schema: {
    notes: table({
      text: String(),
      ownerId: String(),
    }),
  },

  messages: {
    record: message((ctx, data) => {
      ctx.db.notes.insert({ text: data.text + ":committed", ownerId: ctx.auth.userId });
      return { ok: true };
    }),
    explode: message((ctx, data) => {
      ctx.db.notes.insert({ text: data.text + ":first", ownerId: ctx.auth.userId });
      ctx.db.notes.insert({ text: data.text + ":second", ownerId: ctx.auth.userId });
      throw new Error("Message write failed.");
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

      socket.send(JSON.stringify({ id: "record", type: "app.send", message: "record", data: { text: "before" } }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "record",
        type: "app.result",
        message: "record",
        data: { ok: true },
        error: null,
      });

      socket.send(JSON.stringify({ id: "explode", type: "app.send", message: "explode", data: { text: "rollback" } }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "explode",
        type: "app.result",
        message: "explode",
        data: null,
        error: {
          message: "Message write failed.",
          hint: "Check the Capsule message handler and retry the app message.",
        },
      });

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      assert.deepEqual(
        tables.find((table) => table.name === "notes").rows.map((row) => row.text),
        ["before:committed"],
      );
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev runs imported-helper Capsule mutation handlers from the bundled module", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "helper-mutation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "helper-mutation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "todo-text.ts"),
      `export function cleanTodoText(value: string) {
  return "helper:" + value.trim().replace(/\\s+/g, " ");
}
`,
    );
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";
import { cleanTodoText } from "./todo-text";

export default capsule({
  name: "helper-mutation-island",

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
        text: cleanTodoText(text),
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
        ["helper:imported helper"],
      );
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});
