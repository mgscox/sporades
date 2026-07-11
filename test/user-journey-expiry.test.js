import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createControllableRuntimeClock, createWebSocketHub, openDevDatabase } from "../dist/server-runtime-source.js";

test("Journey state expires and can be renewed under the enabled session using runtime time", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  await withJourneyRuntime(clock, async ({ open }) => {
    const publisher = await open();
    const observer = await open();
    const events = [];
    observer.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === "journey.event") events.push(message.data);
    });
    try {
      const enabled = await send(publisher, { id: "enable", type: "journey.enable", options: {} });
      assert.deepEqual(Object.keys(enabled.data).sort(), ["capture", "enabled", "userId"]);
      const defaulted = await send(publisher, { id: "default", type: "journey.set", state: { status: "online" } });
      assert.equal(defaulted.data.journey.expiresAt, "2030-01-01T00:00:30.000Z");
      const first = await send(publisher, { id: "first", type: "journey.set", state: { status: "editing", ttlSeconds: 1 } });
      assert.equal(first.data.journey.updatedAt, "2030-01-01T00:00:00.000Z");
      assert.equal(first.data.journey.expiresAt, "2030-01-01T00:00:01.000Z");
      await send(observer, { id: "subscription", type: "journey.subscribe" });
      assert.deepEqual(events, [{ type: "snapshot", states: [first.data.journey] }]);

      clock.advanceBy(1_000);
      await clock.runDueTimers();
      await eventually(() => events.length === 2);
      assert.deepEqual(events[1], { type: "removed", state: first.data.journey });
      assert.deepEqual((await send(observer, { id: "empty", type: "journey.list" })).data.journeys, []);
      await clock.runDueTimers();
      assert.equal(events.length, 2, "cleanup emits exactly one removal");

      const renewed = await send(publisher, { id: "renewed", type: "journey.set", state: { status: "reviewing", ttlSeconds: 300 } });
      assert.notEqual(renewed.data.journey.sessionId, undefined);
      assert.equal(renewed.data.journey.expiresAt, "2030-01-01T00:05:01.000Z");
      for (const ttlSeconds of [0, 1.5, 301]) {
        const invalid = await send(publisher, { id: `invalid-${ttlSeconds}`, type: "journey.set", state: { status: "invalid", ttlSeconds } });
        assert.equal(invalid.error.code, "INVALID_JOURNEY_TTL");
      }
    } finally { publisher.close(); observer.close(); }
  });
});

test("Journey creates sessions lazily and rotates at the configured inactivity boundary", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  await withJourneyRuntime(clock, async ({ open }) => {
    const publisher = await open();
    try {
      const enabled = await send(publisher, { id: "enable", type: "journey.enable", options: {} });
      assert.equal(enabled.data.sessionId, undefined);
      const first = await send(publisher, { id: "first", type: "journey.set", state: { status: "first", ttlSeconds: 300 } });
      clock.advanceBy(59_999);
      const before = await send(publisher, { id: "before", type: "journey.set", state: { status: "before", ttlSeconds: 300 } });
      assert.equal(before.data.journey.sessionId, first.data.journey.sessionId);
      clock.advanceBy(60_000);
      const boundary = await send(publisher, { id: "boundary", type: "journey.set", state: { status: "boundary", ttlSeconds: 300 } });
      assert.notEqual(boundary.data.journey.sessionId, first.data.journey.sessionId);
    } finally { publisher.close(); }
  }, { journey: { sessionInactivityMinutes: 1 } });
});

test("Journey inactivity configuration defaults, rounds, clamps, and reports its effective value", async () => {
  const cases = [
    [undefined, 30], [null, 30], ["30", 30], [Number.NaN, 30],
    [0, 1], [1.49, 1], [1.5, 2], [2000, 1440],
  ];
  for (const [value, expected] of cases) {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    await withJourneyRuntime(clock, async ({ database }) => {
      assert.equal(database.journeySessionInactivityMinutes, expected);
      assert.deepEqual(database.runtimeDiagnostics.journey, { sessionInactivityMinutes: expected });
    }, value === undefined ? {} : { journey: { sessionInactivityMinutes: value } });
  }
});

test("Journey enforces per-user capacity without evicting live state and permits replacement", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  await withJourneyRuntime(clock, async ({ open }) => {
    const clients = [];
    try {
      const first = await open(); clients.push(first);
      const auth = await send(first, { id: "auth", type: "auth.get" });
      for (let index = 0; index < 32; index += 1) {
        const client = index === 0 ? first : await open();
        if (index > 0) clients.push(client);
        await send(client, { id: `enable-${index}`, type: "journey.enable", options: {}, sessionToken: auth.data.sessionToken });
        assert.equal((await send(client, { id: `set-${index}`, type: "journey.set", state: { status: `state-${index}` }, sessionToken: auth.data.sessionToken })).error, null);
      }
      const extra = await open(); clients.push(extra);
      await send(extra, { id: "enable-extra", type: "journey.enable", options: {}, sessionToken: auth.data.sessionToken });
      const rejected = await send(extra, { id: "set-extra", type: "journey.set", state: { status: "overflow" }, sessionToken: auth.data.sessionToken });
      assert.equal(rejected.error.code, "JOURNEY_USER_CAPACITY");
      assert.equal((await send(first, { id: "replace", type: "journey.set", state: { status: "replacement" }, sessionToken: auth.data.sessionToken })).error, null);
      assert.equal((await send(extra, { id: "list", type: "journey.list", sessionToken: auth.data.sessionToken })).data.journeys.length, 32);
    } finally { for (const client of clients) client.close(); }
  });
});

test("Journey enforces Capsule capacity, permits replacement, and prunes expiry before admission", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  await withJourneyRuntime(clock, async ({ open }) => {
    const clients = [];
    try {
      for (let index = 0; index < 1_000; index += 1) {
        const client = await open(); clients.push(client);
        await send(client, { id: `enable-${index}`, type: "journey.enable", options: {} });
        const accepted = await send(client, { id: `set-${index}`, type: "journey.set", state: { status: `state-${index}`, ttlSeconds: 1 } });
        assert.equal(accepted.error, null);
      }

      const overflow = await open(); clients.push(overflow);
      await send(overflow, { id: "enable-overflow", type: "journey.enable", options: {} });
      const rejected = await send(overflow, { id: "set-overflow", type: "journey.set", state: { status: "overflow", ttlSeconds: 1 } });
      assert.equal(rejected.error.code, "JOURNEY_CAPSULE_CAPACITY");
      assert.equal((await send(overflow, { id: "full-list", type: "journey.list" })).data.journeys.length, 1_000, "capacity rejection must not evict live state");

      const replacement = await send(clients[0], { id: "replacement", type: "journey.set", state: { status: "replacement", ttlSeconds: 1 } });
      assert.equal(replacement.error, null, "an existing session may replace state at Capsule capacity");
      assert.equal((await send(overflow, { id: "still-full", type: "journey.list" })).data.journeys.length, 1_000);

      clock.advanceBy(1_000);
      const admitted = await send(overflow, { id: "admitted", type: "journey.set", state: { status: "admitted", ttlSeconds: 1 } });
      assert.equal(admitted.error, null, "expired state is pruned before Capsule cap enforcement");
      assert.deepEqual((await send(overflow, { id: "pruned-list", type: "journey.list" })).data.journeys, [admitted.data.journey]);
      await clock.runDueTimers();
    } finally { for (const client of clients) client.close(); }
  });
});

async function withJourneyRuntime(clock, fn, config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-journey-expiry-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "journey-expiry", ...config }, {
    name: "journey-expiry", schema: {}, queries: {}, mutations: {}, endpoints: {}, messages: {}, journey: { enabled: true, ttlSeconds: 30 },
  }, { clock });
  const hub = createWebSocketHub(() => database);
  const server = createServer();
  server.on("upgrade", (request, socket) => hub.accept(request, socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn({ database, open: () => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?connectionToken=${hub.createConnectionToken()}`);
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", reject, { once: true });
    }) });
  } finally {
    hub.disconnectAll();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function send(ws, message) {
  return new Promise((resolve) => {
    const listener = ({ data }) => {
      const response = JSON.parse(data);
      if (response.id !== message.id) return;
      ws.removeEventListener("message", listener);
      resolve(response);
    };
    ws.addEventListener("message", listener);
    ws.send(JSON.stringify(message));
  });
}

async function eventually(predicate) {
  for (let attempts = 0; attempts < 100 && !predicate(); attempts += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), "condition did not become true");
}
