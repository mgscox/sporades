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



// Exact refresh-count fixtures run in the serial lane to avoid worker-pressure races.
for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) test(`sporades dev preserves last-good Svelte ${template} output and recovers with full-page refresh`, async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "svelte-dev", "--template", template, "--framework", "svelte", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "svelte-dev");
    await installSvelte(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    if (template === "photo-library") await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n");
    const appPath = path.join(projectDir, "client", "App.svelte");
    const original = await readFile(appPath, "utf8");
    const child = startCli(["dev", "--json"], { cwd: projectDir });
    const events = captureJsonEvents(child);
    let socket;
    let messages;
    let foreignSocket;
    let foreignMessages;
    try {
      const scrub = (html) => html.replace(/window\.__SPORADES_CONNECTION_TOKEN="[^"]+"/, 'window.__SPORADES_CONNECTION_TOKEN="<token>"');
      const started = await events.next((event) => event.ok && event.data?.event === "started");
      assert.equal(started.ok, true, JSON.stringify(started));
      const initialResponse = await fetch(started.data.url);
      assert.equal(initialResponse.status, 200, "started follows the initial successful build and HTTP listen");
      const initialHtml = scrub(await initialResponse.text());
      socket = await openSocket(started.data.url);
      messages = captureSocketMessages(socket);
      socket.send(JSON.stringify({ id: "svelte-dev-ready", type: "dev.refresh.subscribe" }));
      const ready = await messages.next((message) => message.id === "svelte-dev-ready" && message.type === "dev.refresh.ready");
      assert.deepEqual(ready, { id: "svelte-dev-ready", type: "dev.refresh.ready", data: { mode: "full-page", sequence: 0 }, error: null }, "acknowledgment proves this connection is in the Dev refresh broadcast set");
      if (template === "guestbook") {
        socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: 1 }));
        foreignSocket = await openSocket(started.data.url);
        foreignMessages = captureSocketMessages(foreignSocket);
      }

      const rebuiltSource = original.replace("</main>", '<p data-dev-probe="rebuilt">Svelte rebuilt</p></main>');
      assert.notEqual(rebuiltSource, original, `${template} edit must change generated output`);
      const refresh = messages.next((message) => message.type === "refresh");
      await writeFile(appPath, rebuiltSource);
      const refreshMessage = await refresh.catch((error) => {
        error.message += ` Captured process events: ${JSON.stringify(events.events)}`;
        throw error;
      });
      assert.deepEqual(refreshMessage, { id: null, type: "refresh", data: { mode: "full-page", sequence: 1 }, error: null });
      assert.equal(events.events.some((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success"), false, "rebuild success waits for refresh receipt");
      if (foreignSocket) {
        foreignSocket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: refreshMessage.data.sequence }));
        foreignSocket.send(JSON.stringify({ id: "foreign-ack-barrier", type: "auth.get" }));
        await foreignMessages.next((message) => message.id === "foreign-ack-barrier");
        assert.equal(events.events.some((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success"), false, "foreign acknowledgment cannot release delivery");
      }
      socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: refreshMessage.data.sequence }));
      socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: refreshMessage.data.sequence }));
      const rebuilt = await events.next((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(rebuilt.data.build, { phase: "client", framework: "svelte", toolchain: "vite" });
      assertDevRefreshDelivery(rebuilt.data.refresh, 1);
      // The acknowledged transport retries identical frames every 100 ms. Count
      // distinct payloads so a delayed foreign-client barrier cannot fake a new generation.
      const refreshFrames = () => [...new Map(messages.history.filter(message => message.type === "refresh").map(message => [JSON.stringify(message), message])).values()];
      assert.deepEqual(refreshFrames(), [refreshMessage], "one successful edit emits exactly one refresh generation");
      const lastGood = scrub(await (await fetch(started.data.url)).text());
      assert.notEqual(lastGood, initialHtml, "the successful edit changes the served Vite output tree");
      await writeFile(appPath, '<script lang="ts">const broken = </script><main>{broken}</main>\n');
      const failed = await events.next((event) => !event.ok && event.data?.event === "rebuild");
      assert.deepEqual(failed.data.build, { phase: "client", framework: "svelte", toolchain: "vite" });
      assert.match(failed.error.hint, /Svelte\/Vite client source/);
      assert(JSON.stringify(failed).length < 4096);
      assert.doesNotMatch(JSON.stringify(failed), new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(scrub(await (await fetch(started.data.url)).text()), lastGood);
      assert.deepEqual(refreshFrames(), [refreshMessage], "failed builds preserve last-good output without a new refresh generation");
      const recoveredRefresh = messages.next((message) => message.type === "refresh" && message.data?.sequence === refreshMessage.data.sequence + 1);
      const recoveredSource = original.replace("</main>", '<p data-dev-probe="recovered">Svelte recovered</p></main>');
      assert.notEqual(recoveredSource, original);
      await writeFile(appPath, recoveredSource);
      const recoveredMessage = await recoveredRefresh;
      assert.deepEqual(recoveredMessage, { id: null, type: "refresh", data: { mode: "full-page", sequence: 2 }, error: null });
      assert.equal(events.events.some((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success"), false);
      socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: recoveredMessage.data.sequence }));
      const recovered = await events.next((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(recovered.data.build, { phase: "client", framework: "svelte", toolchain: "vite" });
      assertDevRefreshDelivery(recovered.data.refresh, 2);
      assert.deepEqual(refreshFrames(), [refreshMessage, recoveredMessage], "recovery emits one additional refresh generation");
    } finally {
      messages?.dispose();
      foreignMessages?.dispose();
      await Promise.all([closeSocketGracefully(foreignSocket), closeSocketGracefully(socket)]);
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      events.dispose();
    }
  });
});
