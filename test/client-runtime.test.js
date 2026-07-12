import assert from "node:assert/strict";
import { test } from "node:test";

import { createClientRuntimeSource } from "../dist/templates/client-runtime-template.js";
import { SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../dist/server-runtime-source.js";

async function importClientRuntime(options = {}) {
  const source = createClientRuntimeSource(options);
  const encoded = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`);
}

test("browser client runtime exposes no Privileged server role authority", async () => {
  const runtime = await importClientRuntime();

  assert.equal(Object.hasOwn(runtime, "privileged"), false);
  assert.equal(Object.hasOwn(runtime.auth, "privileged"), false);
  assert.equal(Object.hasOwn(runtime.auth, "runPrivileged"), false);
  assert.equal(Object.hasOwn(runtime.auth, "asPrivileged"), false);
});

test("Vue composables expose complete reactive state and dispose shared subscriptions", async () => {
  const unsubscribes = [];
  const browser = installBrowserFakes(anonymousAuth, { handlers: {
    "query.subscribe": async () => ({ type: "query.result", data: [{ id: "todo-1", text: "Vue update" }], error: null }),
    "query.unsubscribe": async (message) => { unsubscribes.push(message); return { type: "query.unsubscribe.result", data: { removed: true }, error: null }; },
    "mutation.run": async () => ({ type: "mutation.result", data: null, error: { message: "Vue mutation failed" } }),
  }});
  const disposals = [];
  const reactive = (value) => value;
  try {
    const runtime = await importClientRuntime();
    assert.equal(typeof runtime.createVueComposables, "function");
    const composables = runtime.createVueComposables({ reactive, onScopeDispose: (cleanup) => disposals.push(cleanup) });
    const query = composables.useQuery("todos");
    const mutation = composables.useMutation("addTodo");
    const auth = composables.useAuth();
    assert.deepEqual(query, { data: null, error: null, loading: true });
    assert.deepEqual({ data: mutation.data, error: mutation.error, loading: mutation.loading }, { data: null, error: null, loading: false });
    assert.equal(typeof mutation.run, "function");
    assert.equal(auth.loading, true);
    assert.equal(auth.error, null);
    assert.equal(auth.auth, null);
    assert.deepEqual(auth.providers, {});
    assert.equal(disposals.length, 2, "query and auth own one Vue disposal each");
    assert.equal(browser.sockets.length, 1, "Vue composables share the framework-neutral page connection");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(query, { data: [{ id: "todo-1", text: "Vue update" }], error: null, loading: false });
    assert.equal(auth.loading, false);
    assert.deepEqual(auth.auth, anonymousAuth);
    const failed = await mutation.run("broken");
    assert.equal(failed.error.message, "Vue mutation failed");
    assert.equal(mutation.loading, false);
    assert.equal(mutation.error.message, "Vue mutation failed");
    disposals.forEach((dispose) => dispose());
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(unsubscribes.length, 1);
  } finally { browser.cleanup(); }
});

test("Vue mutation state is pending-counted and latest-invocation deterministic", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return { promise, resolve, reject };
  };
  try {
    const runtime = await importClientRuntime();
    const calls = [];
    runtime.mutations.run = (_name, value) => {
      const call = deferred();
      calls.push({ value, ...call });
      return call.promise;
    };
    const vue = runtime.createVueComposables({ reactive: (value) => value, onScopeDispose() {} });
    const mutation = vue.useMutation("save");

    const first = mutation.run("A");
    const second = mutation.run("B");
    assert.equal(mutation.loading, true);
    calls[1].resolve({ data: { value: "B" }, error: null });
    assert.deepEqual(await second, { data: { value: "B" }, error: null });
    assert.equal(mutation.loading, true, "older A remains pending");
    assert.deepEqual(mutation.data, { value: "B" });
    calls[0].resolve({ data: { value: "A" }, error: null });
    assert.deepEqual(await first, { data: { value: "A" }, error: null });
    assert.equal(mutation.loading, false);
    assert.deepEqual(mutation.data, { value: "B" }, "older completion cannot overwrite latest invocation B");

    const older = mutation.run("older-success");
    const latest = mutation.run("latest-error");
    const structured = { message: "Latest failed", hint: "Fix latest" };
    calls[3].resolve({ data: null, error: structured });
    await latest;
    calls[2].resolve({ data: { value: "stale" }, error: null });
    await older;
    assert.deepEqual(mutation.error, structured);
    assert.equal(mutation.data, null);
    assert.equal(mutation.loading, false);

    const thrown = new Error("Transport rejected");
    const rejected = mutation.run("throws");
    calls[4].reject(thrown);
    await assert.rejects(rejected, (error) => error === thrown);
    assert.deepEqual(mutation.error, { message: "Transport rejected" });
    assert.equal(mutation.loading, false, "rejection decrements pending in finally");
  } finally { browser.cleanup(); }
});

test("Solid primitives expose complete reactive state and release transport observation with their reactive root", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  try {
    const [{ createRoot, createSignal, onCleanup }, runtime] = await Promise.all([import("solid-js"), importClientRuntime()]);
    let queryStarts = 0, queryStops = 0, authStarts = 0, authStops = 0;
    runtime.queries.subscribe = (name, publish) => {
      queryStarts += 1;
      publish({ data: [{ id: "solid-runtime", name }], error: null, loading: false });
      return { unsubscribe() { queryStops += 1; } };
    };
    runtime.auth.subscribe = (publish) => {
      authStarts += 1;
      publish({ auth: anonymousAuth, providers: { anonymous: { enabled: true } }, error: null, loading: false });
      return { unsubscribe() { authStops += 1; } };
    };

    let query, session, dispose;
    createRoot((rootDispose) => {
      dispose = rootDispose;
      const solid = runtime.createSolidPrimitives({ createSignal, onCleanup });
      assert.deepEqual([queryStarts, authStarts], [0, 0], "creating the adapter alone starts no transport observation");
      query = solid.createQuery("todos");
      session = solid.createAuth();
    });

    assert.deepEqual(query(), { data: [{ id: "solid-runtime", name: "todos" }], error: null, loading: false });
    assert.deepEqual(session.state(), { auth: anonymousAuth, providers: { anonymous: { enabled: true } }, error: null, loading: false });
    assert.equal(session.isAuthenticated(), false);
    assert.deepEqual([queryStarts, authStarts], [1, 1]);
    dispose();
    dispose();
    assert.deepEqual([queryStops, authStops], [1, 1], "Solid root disposal releases each owned observation exactly once");
  } finally { browser.cleanup(); }
});

test("Solid mutation state is pending-counted and latest-invocation deterministic", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  try {
    const [{ createRoot, createSignal, onCleanup }, runtime] = await Promise.all([import("solid-js"), importClientRuntime()]);
    const calls = [];
    runtime.mutations.run = (_name, value) => { const call = deferred(); calls.push({ value, ...call }); return call.promise; };
    let mutation, dispose;
    createRoot((rootDispose) => {
      dispose = rootDispose;
      mutation = runtime.createSolidPrimitives({ createSignal, onCleanup }).createMutation("save");
    });
    assert.deepEqual(mutation.state(), { data: null, error: null, loading: false });
    const first = mutation.run("A");
    const latest = mutation.run("B");
    assert.equal(mutation.state().loading, true);
    calls[1].resolve({ data: { value: "B" }, error: null });
    await latest;
    assert.deepEqual(mutation.state(), { data: { value: "B" }, error: null, loading: true });
    calls[0].resolve({ data: { value: "A" }, error: null });
    await first;
    assert.deepEqual(mutation.state(), { data: { value: "B" }, error: null, loading: false });
    const rejected = mutation.run("C");
    calls[2].reject(new Error("Solid transport failed"));
    await assert.rejects(rejected, /Solid transport failed/);
    assert.deepEqual(mutation.state(), { data: null, error: { message: "Solid transport failed" }, loading: false });
    dispose();
  } finally { browser.cleanup(); }
});

test("Lit controllers own query and auth observation through exact host lifecycle", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  try {
    const runtime = await importClientRuntime();
    let queryPublish, authPublish, queryStarts = 0, queryStops = 0, authStarts = 0, authStops = 0;
    runtime.queries.subscribe = (_name, publish) => { queryStarts += 1; queryPublish = publish; return { unsubscribe() { queryStops += 1; } }; };
    runtime.auth.subscribe = (publish) => { authStarts += 1; authPublish = publish; return { unsubscribe() { authStops += 1; } }; };
    const controllers = [], updates = [];
    const host = { addController(controller) { controllers.push(controller); }, requestUpdate() { updates.push("update"); } };
    const lit = runtime.createLitControllers();
    const query = lit.queryController(host, "todos");
    const session = lit.authController(host);
    assert.deepEqual(controllers, [query, session]);
    assert.deepEqual(query.state, { data: null, error: null, loading: true });
    assert.deepEqual(session.state, { auth: null, providers: {}, loading: true, error: null });
    assert.deepEqual([queryStarts, authStarts], [0, 0]);
    for (const controller of controllers) { controller.hostConnected(); controller.hostConnected(); }
    assert.deepEqual([queryStarts, authStarts], [1, 1], "duplicate connect is idempotent");
    queryPublish({ data: [{ id: "lit-1" }], error: null, loading: false });
    authPublish({ auth: anonymousAuth, providers: {}, error: null, loading: false });
    assert.equal(query.state.data[0].id, "lit-1");
    assert.equal(session.isAuthenticated(), false);
    assert.equal(updates.length, 2);
    for (const controller of controllers) { controller.hostDisconnected(); controller.hostDisconnected(); }
    assert.deepEqual([queryStops, authStops], [1, 1], "duplicate disconnect releases once");
    for (const controller of controllers) controller.hostConnected();
    assert.deepEqual([queryStarts, authStarts], [2, 2], "same host reconnect owns fresh subscriptions");
    for (const controller of controllers) controller.hostDisconnected();
    assert.deepEqual([queryStops, authStops], [2, 2]);
  } finally { browser.cleanup(); }
});

test("Lit mutation controller is pending-counted and latest-invocation deterministic", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  try {
    const runtime = await importClientRuntime();
    const calls = [], updates = [];
    runtime.mutations.run = (_name, value) => { const call = deferred(); calls.push({ value, ...call }); return call.promise; };
    const host = { addController() {}, requestUpdate() { updates.push("update"); } };
    const mutation = runtime.createLitControllers().mutationController(host, "save");
    const first = mutation.run("A"), latest = mutation.run("B");
    assert.equal(mutation.state.loading, true);
    calls[1].resolve({ data: { value: "B" }, error: null }); await latest;
    assert.deepEqual(mutation.state, { data: { value: "B" }, error: null, loading: true });
    calls[0].resolve({ data: { value: "A" }, error: null }); await first;
    assert.deepEqual(mutation.state, { data: { value: "B" }, error: null, loading: false });
    const rejected = mutation.run("C"); calls[2].reject(new Error("Lit transport failed"));
    await assert.rejects(rejected, /Lit transport failed/);
    assert.deepEqual(mutation.state, { data: null, error: { message: "Lit transport failed" }, loading: false });
    assert(updates.length >= 5, "each visible mutation state transition requests a host update");
  } finally { browser.cleanup(); }
});

test("Svelte stores lazily own one query and auth observation across subscribers and resubscribe deterministically", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  try {
    const runtime = await importClientRuntime();
    const queryStarts = [], queryStops = [], authStarts = [], authStops = [];
    runtime.queries.subscribe = (name, publish) => {
      queryStarts.push(name);
      publish({ data: [{ id: `todo-${queryStarts.length}` }], error: null, loading: false });
      return { unsubscribe() { queryStops.push(name); } };
    };
    runtime.auth.subscribe = (publish) => {
      authStarts.push("auth");
      publish({ auth: anonymousAuth, providers: { anonymous: { enabled: true } }, error: null, loading: false });
      return { unsubscribe() { authStops.push("auth"); } };
    };
    const svelte = runtime.createSvelteStores();
    const query = svelte.queryStore("todos");
    const auth = svelte.authStore();
    assert.deepEqual(queryStarts, []);
    assert.deepEqual(authStarts, []);
    const queryStates = [], secondQueryStates = [], authStates = [];
    const stopQueryA = query.subscribe((state) => queryStates.push(state));
    const stopQueryB = query.subscribe((state) => secondQueryStates.push(state));
    const stopAuth = auth.subscribe((state) => authStates.push(state));
    assert.deepEqual(queryStarts, ["todos"], "first query subscriber starts one transport observation");
    assert.deepEqual(authStarts, ["auth"]);
    assert.equal(queryStates.at(-1).data[0].id, "todo-1");
    assert.equal(authStates.at(-1).isAuthenticated(), false);
    stopQueryA();
    stopQueryA();
    assert.deepEqual(queryStops, [], "duplicate and non-final teardown do not stop shared observation");
    stopQueryB();
    stopAuth();
    assert.deepEqual(queryStops, ["todos"]);
    assert.deepEqual(authStops, ["auth"]);
    const stopAgain = query.subscribe((state) => queryStates.push(state));
    assert.deepEqual(queryStarts, ["todos", "todos"], "resubscribe starts one fresh observation");
    assert.equal(queryStates.at(-1).data[0].id, "todo-2");
    stopAgain();
    assert.deepEqual(queryStops, ["todos", "todos"]);
  } finally { browser.cleanup(); }
});

test("Svelte mutation stores expose complete state with pending-counted latest-invocation semantics", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  try {
    const runtime = await importClientRuntime();
    const calls = [];
    runtime.mutations.run = (_name, value) => { const call = deferred(); calls.push({ value, ...call }); return call.promise; };
    const mutation = runtime.createSvelteStores().mutationStore("save");
    const states = [];
    const stop = mutation.subscribe((state) => states.push({ ...state }));
    assert.deepEqual(states.at(-1), { data: null, error: null, loading: false });
    const first = mutation.run("A");
    const latest = mutation.run("B");
    assert.equal(states.at(-1).loading, true);
    calls[1].resolve({ data: { value: "B" }, error: null });
    await latest;
    assert.equal(states.at(-1).loading, true);
    assert.deepEqual(states.at(-1).data, { value: "B" });
    calls[0].resolve({ data: { value: "A" }, error: null });
    await first;
    assert.equal(states.at(-1).loading, false);
    assert.deepEqual(states.at(-1).data, { value: "B" });
    const rejected = mutation.run("C");
    calls[2].reject(new Error("Svelte transport failed"));
    await assert.rejects(rejected, /Svelte transport failed/);
    assert.deepEqual(states.at(-1).error, { message: "Svelte transport failed" });
    assert.equal(states.at(-1).loading, false);
    stop();
  } finally { browser.cleanup(); }
});

test("actual Svelte derived-store lifecycle starts and stops Sporades observation exactly once", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  try {
    const [{ derived }, runtime] = await Promise.all([import("svelte/store"), importClientRuntime()]);
    let starts = 0, stops = 0;
    runtime.queries.subscribe = (_name, publish) => {
      starts += 1;
      publish({ data: [{ id: "svelte-runtime" }], error: null, loading: false });
      return { unsubscribe() { stops += 1; } };
    };
    const query = runtime.createSvelteStores().queryStore("todos");
    const ids = derived(query, ($query) => ($query.data ?? []).map((item) => item.id));
    assert.equal(starts, 0);
    const values = [];
    const unsubscribeA = ids.subscribe((value) => values.push(value));
    const unsubscribeB = ids.subscribe((value) => values.push(value));
    assert.equal(starts, 1);
    assert.deepEqual(values.at(-1), ["svelte-runtime"]);
    unsubscribeA();
    assert.equal(stops, 0);
    unsubscribeB();
    assert.equal(stops, 1, "Svelte's final derived subscriber releases the transport once");
  } finally { browser.cleanup(); }
});

test("Svelte query and auth stores give repeated callback objects independent ownership handles", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  try {
    const runtime = await importClientRuntime();
    let queryPublish, authPublish;
    let queryStarts = 0, queryStops = 0, authStarts = 0, authStops = 0;
    runtime.queries.subscribe = (_name, publish) => { queryStarts += 1; queryPublish = publish; return { unsubscribe() { queryStops += 1; } }; };
    runtime.auth.subscribe = (publish) => { authStarts += 1; authPublish = publish; return { unsubscribe() { authStops += 1; } }; };
    const stores = runtime.createSvelteStores();
    const query = stores.queryStore("todos");
    const auth = stores.authStore();
    const queryStates = [], authStates = [];
    const sameQueryCallback = (state) => queryStates.push(state);
    const sameAuthCallback = (state) => authStates.push(state);
    const stopQueryA = query.subscribe(sameQueryCallback);
    const stopQueryB = query.subscribe(sameQueryCallback);
    const stopAuthA = auth.subscribe(sameAuthCallback);
    const stopAuthB = auth.subscribe(sameAuthCallback);
    assert.equal(queryStates.length, 2, "native initial delivery occurs once for each subscription record");
    assert.equal(authStates.length, 2);
    queryPublish({ data: [{ id: "update-1" }], error: null, loading: false });
    authPublish({ auth: anonymousAuth, providers: {}, error: null, loading: false });
    assert.equal(queryStates.length, 4, "one update is delivered to both handles sharing a callback object");
    assert.equal(authStates.length, 4);
    stopQueryA(); stopQueryA(); stopAuthA(); stopAuthA();
    assert.equal(queryStops, 0); assert.equal(authStops, 0);
    queryPublish({ data: [{ id: "update-2" }], error: null, loading: false });
    authPublish({ auth: anonymousAuth, providers: {}, error: null, loading: false });
    assert.equal(queryStates.length, 5, "first unsubscribe leaves the second callback record active");
    assert.equal(authStates.length, 5);
    stopQueryB(); stopAuthB();
    assert.equal(queryStops, 1); assert.equal(authStops, 1);
    const stopQueryAgain = query.subscribe(sameQueryCallback);
    const stopAuthAgain = auth.subscribe(sameAuthCallback);
    assert.equal(queryStarts, 2); assert.equal(authStarts, 2);
    stopQueryAgain(); stopAuthAgain();
    assert.equal(queryStops, 2); assert.equal(authStops, 2);
  } finally { browser.cleanup(); }
});

test("Svelte store publication survives reentrant unsubscribe and preserves ownership after callback errors", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  try {
    const runtime = await importClientRuntime();
    let publish, stops = 0;
    runtime.queries.subscribe = (_name, next) => { publish = next; return { unsubscribe() { stops += 1; } }; };
    const store = runtime.createSvelteStores().queryStore("todos");
    let stopReentrant = () => {};
    let armed = false;
    let reentrantDeliveries = 0;
    stopReentrant = store.subscribe(() => { reentrantDeliveries += 1; if (armed) stopReentrant(); });
    let survivorDeliveries = 0;
    const stopSurvivor = store.subscribe(() => { survivorDeliveries += 1; });
    armed = true;
    publish({ data: [], error: null, loading: false });
    assert.equal(reentrantDeliveries, 2);
    assert.equal(survivorDeliveries, 2, "reentrant removal does not skip the next active record");
    assert.equal(stops, 0);
    let shouldThrow = false;
    const stopThrowing = store.subscribe(() => { if (shouldThrow) throw new Error("subscriber failed"); });
    shouldThrow = true;
    assert.throws(() => publish({ data: [{ id: "safe" }], error: null, loading: false }), /subscriber failed/);
    assert.equal(survivorDeliveries, 3, "throwing callback does not prevent other active deliveries");
    stopThrowing(); stopSurvivor();
    assert.equal(stops, 1, "ownership remains valid and final active record tears down once");
  } finally { browser.cleanup(); }
});

test("Journey metadata rejects symbol-keyed objects before publication", () => {
  const normalize = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "normalizeJourneyState");
  const metadata = { visible: true, [Symbol("private")]: "lost" };
  assert.throws(() => normalize({ status: "editing", metadata }, 30), (error) => error.code === "INVALID_JOURNEY_METADATA");
});

test("Journey declaration rejects non-plain capture policy shapes", () => {
  const normalize = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "normalizeJourneyPolicy");
  for (const capture of [null, [], "focus", Object.create({ focus: true })]) {
    assert.throws(() => normalize({ enabled: true, capture }), /Invalid Journey capture policy/);
  }
});

test("client clears Journey consent on same-token auth identity replacement", async () => {
  const calls = [];
  const browser = installBrowserFakes(anonymousAuth, { handlers: {
    "journey.enable": async (message) => { calls.push(message); return { type: "journey.enable.result", data: { userId: anonymousAuth.userId, capture: {} }, error: null }; },
  }});
  try {
    const runtime = await importClientRuntime();
    await runtime.journey.enable();
    browser.sockets[0].emit("message", { data: JSON.stringify({ type: "auth.session.replace", data: { sessionToken: "session-token", auth: { ...anonymousAuth, userId: "replacement-user" } }, error: null }) });
    browser.sockets[0].readyState = 3; browser.sockets[0].emit("close", {});
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(calls.length, 1, "reconnect must not resume Journey consent for the replacement identity");
  } finally { browser.cleanup(); }
});

test("failed auth transition preserves Journey consent for reconnect", async () => {
  const calls = [];
  const browser = installBrowserFakes(anonymousAuth, { handlers: {
    "journey.enable": async (message) => { calls.push(message); return { type: "journey.enable.result", data: { userId: anonymousAuth.userId, capture: {} }, error: null }; },
    "auth.signOut": async () => ({ type: "error", data: null, error: { message: "nope" } }),
  }});
  try {
    const runtime = await importClientRuntime(); await runtime.journey.enable(); await runtime.auth.signOut();
    browser.sockets[0].readyState = 3; browser.sockets[0].emit("close", {});
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.deepEqual(calls.at(-1).options, {});
  } finally { browser.cleanup(); }
});

test("browser client runtime exposes the explicit Journey session lifecycle over transport", async () => {
  const calls = [];
  const browser = installBrowserFakes(anonymousAuth, {
    handlers: Object.fromEntries(["journey.enable", "journey.set", "journey.list", "journey.disable"].map((type) => [type, async (message) => {
      calls.push(message);
      return { type: `${type}.result`, data: type === "journey.enable" ? { userId: anonymousAuth.userId, capture: { navigation: true, focus: false, interactions: true } } : { ok: true }, error: null };
    }])),
  });
  try {
    const runtime = await importClientRuntime();
    const enabled = await runtime.journey.enable({ capture: { focus: false } });
    assert.equal(Object.hasOwn(enabled.data, "sessionId"), false);
    await runtime.journey.set({ status: "editing", metadata: { document: "roadmap" }, ttlSeconds: 20 });
    await runtime.journey.list();
    assert.deepEqual(calls.map(({ type }) => type), ["journey.enable", "journey.set", "journey.list"]);
    assert.deepEqual(calls[0].options, { capture: { focus: false } });
    assert.deepEqual(calls[1].state, { status: "editing", metadata: { document: "roadmap" }, ttlSeconds: 20 });
    browser.sockets[0].readyState = 3;
    browser.sockets[0].emit("close", {});
    await new Promise((resolve) => setTimeout(resolve, 550));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.at(-1).type, "journey.enable");
    assert.deepEqual(calls.at(-1).options, { capture: { focus: false } });
    await runtime.journey.disable();
  } finally {
    browser.cleanup();
  }
});

test("client-runtime replacement retires the old page consent exactly once", async () => {
  const calls = [];
  let enabled = false;
  const browser = installBrowserFakes(anonymousAuth, { handlers: {
    "journey.enable": async (message) => { calls.push(message); enabled = true; return { type: "journey.enable.result", data: { enabled: true, userId: anonymousAuth.userId, capture: { navigation: false, focus: false, interactions: false } }, error: null }; },
    "journey.set": async (message) => { calls.push(message); return enabled ? { type: "journey.set.result", data: { journey: message.state }, error: null } : { type: "error", data: null, error: { code: "JOURNEY_NOT_ENABLED" } }; },
    "journey.disable": async (message) => { calls.push(message); enabled = false; return { type: "journey.disable.result", data: { ok: true }, error: null }; },
  }});
  const listeners = new Map(); const add = (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  const remove = (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener));
  globalThis.document = { head: { querySelectorAll: () => [] }, documentElement: {}, querySelector: () => null, addEventListener: add, removeEventListener: remove };
  window.addEventListener = add; window.removeEventListener = remove; window.history = { pushState() {}, replaceState() {} };
  window.requestAnimationFrame = (callback) => { queueMicrotask(callback); return 1; }; window.cancelAnimationFrame = () => {};
  try {
    const oldRuntime = await importClientRuntime(); await oldRuntime.journey.enable({ capture: { navigation: false, focus: false, interactions: false } });
    assert.equal((await oldRuntime.journey.set({ status: "manual" })).error, null);
    const replacement = await importClientRuntime(); replacement.journey.list(); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.filter(({ type }) => type === "journey.disable").length, 1);
    assert.equal((await oldRuntime.journey.set({ status: "stale" })).error.code, "JOURNEY_NOT_ENABLED");
    assert.equal(enabled, false, "replacement runtime remains disabled until explicitly enabled");
  } finally { delete globalThis.document; browser.cleanup(); }
});

test("Journey subscriptions deliver platform events and unsubscribe without enabling publication", async () => {
  const calls = [];
  const browser = installBrowserFakes(anonymousAuth, { handlers: {
    "journey.subscribe": async (message) => { calls.push(message); return { type: "journey.event", data: { type: "snapshot", states: [] }, error: null }; },
  }});
  try {
    const runtime = await importClientRuntime();
    const events = [];
    const subscription = runtime.journey.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(events, [{ type: "snapshot", states: [] }]);
    assert.deepEqual(calls.map(({ type }) => type), ["journey.subscribe"]);
    const subscriptionId = calls[0].id;
    browser.sockets[0].emit("message", { data: JSON.stringify({ id: subscriptionId, type: "journey.event", data: { type: "added", state: { sessionId: "j1" } }, error: null }) });
    assert.equal(events.length, 2);
    subscription.unsubscribe();
    browser.sockets[0].emit("message", { data: JSON.stringify({ id: subscriptionId, type: "journey.event", data: { type: "removed", state: { sessionId: "j1" } }, error: null }) });
    assert.equal(events.length, 2);
  } finally { browser.cleanup(); }
});

test("each local Journey subscriber starts with one snapshot and reconnect converges through changes", async () => {
  const calls = [];
  const browser = installBrowserFakes(anonymousAuth, { handlers: {
    "journey.subscribe": async (message) => { calls.push(message); return { type: message.resume ? "journey.sync" : "journey.event", data: { type: "snapshot", states: message.resume ? [{ userId: "u", status: "reviewing", updatedAt: "2", expiresAt: "3" }] : [] }, error: null }; },
  }});
  try {
    const runtime = await importClientRuntime();
    const first = []; const second = [];
    runtime.journey.subscribe((event) => first.push(event));
    runtime.journey.subscribe((event) => second.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(first, [{ type: "snapshot", states: [] }]);
    assert.deepEqual(second, [{ type: "snapshot", states: [] }]);
    browser.sockets[0].readyState = 3; browser.sockets[0].emit("close", {});
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.deepEqual(first.map(({ type }) => type), ["snapshot", "added"]);
    assert.deepEqual(second.map(({ type }) => type), ["snapshot", "added"]);
    assert.equal(first.filter(({ type }) => type === "snapshot").length, 1);
  } finally { browser.cleanup(); }
});

test("Journey capture publishes only safe browser signals after consent and tears down on disable", async () => {
  const calls = [];
  const browser = installBrowserFakes(anonymousAuth, { href: "https://capsule.test/orders/42?token=secret#private", handlers: {
    "journey.enable": async () => ({ type: "journey.enable.result", data: { userId: anonymousAuth.userId, capture: { navigation: true, focus: true, interactions: true } }, error: null }),
    "journey.set": async (message) => { calls.push(message.state); return { type: "journey.set.result", data: { journey: message.state }, error: null }; },
    "journey.disable": async () => ({ type: "journey.disable.result", data: { ok: true }, error: null }),
  }});
  const listeners = new Map();
  const add = (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  const remove = (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener));
  let semanticMeta = null;
  let headMetas = [];
  const head = { querySelectorAll: () => headMetas };
  globalThis.document = { hidden: false, head, documentElement: {}, querySelector: () => semanticMeta, addEventListener: add, removeEventListener: remove };
  const observers = [];
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.observations = []; observers.push(this); }
    observe(target, options) { this.observations.push({ target, options }); }
    disconnect() { this.observations = []; }
    emit(records) {
      for (const record of records) if (record.attributeName && !this.observations.some(({ target }) => target === record.target)) throw new Error("Mutation emitted for an unobserved target");
      this.callback(records);
    }
  };
  window.addEventListener = add; window.removeEventListener = remove;
  window.requestAnimationFrame = (callback) => { queueMicrotask(callback); return 1; };
  window.cancelAnimationFrame = () => {};
  window.history = {
    pushState(_state, _unused, url) { window.location.href = new URL(url, window.location.href).href; return "native-return"; },
    replaceState() { throw new Error("native-error"); },
  };
  const nativePushState = window.history.pushState;
  try {
    const runtime = await importClientRuntime();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [], "capture must not publish before explicit consent");
    await runtime.journey.enable(); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls[0], { status: "viewing", metadata: { page: "/orders/42" } });
    assert.equal(window.history.pushState({}, "", "/checkout?card=4111#raw"), "native-return");
    assert.throws(() => window.history.replaceState({}, "", "/nope"), /native-error/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.at(-1), { status: "viewing", metadata: { page: "/checkout" } });
    for (const listener of listeners.get("popstate") ?? []) listener({ type: "popstate" });
    for (const listener of listeners.get("hashchange") ?? []) listener({ type: "hashchange" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.at(-1).metadata.page, "/checkout", "history signals never expose the raw hash");
    for (const listener of listeners.get("focus") ?? []) listener({ type: "focus" }); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.at(-1).status, "focused");
    for (const listener of listeners.get("blur") ?? []) listener({ type: "blur" }); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.at(-1).status, "away");
    document.hidden = true; for (const listener of listeners.get("visibilitychange") ?? []) listener({ type: "visibilitychange" }); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.at(-1).status, "away"); document.hidden = false;
    const unrelatedCount = calls.length;
    const headObserver = observers.find((observer) => observer.observations.some(({ target }) => target === head));
    assert.deepEqual(headObserver.observations[0].options, { childList: true }, "metadata lifecycle observation is head-only and non-subtree");
    headObserver.emit([{ addedNodes: [{ matches: () => false }], removedNodes: [] }]);
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(calls.length, unrelatedCount);
    semanticMeta = { matches: (selector) => selector === "meta" || selector === 'meta[name="sporades-journey"]', getAttribute: (name) => name === "name" ? "sporades-journey" : "orders.detail" };
    headMetas = [semanticMeta];
    headObserver.emit([{ addedNodes: [semanticMeta], removedNodes: [] }]);
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(calls.at(-1).metadata.page, "orders.detail");
    const metaObserver = observers.find((observer) => observer.observations.some(({ target }) => target === semanticMeta));
    const unrelatedMeta = { matches: (selector) => selector === "meta", getAttribute: (name) => name === "name" ? "description" : "unrelated" };
    headMetas = [semanticMeta, unrelatedMeta]; headObserver.emit([{ addedNodes: [unrelatedMeta], removedNodes: [] }]);
    assert.equal(metaObserver.observations.some(({ target }) => target === unrelatedMeta), false, "ordinary metadata is never attribute-observed");
    const beforeUnrelatedAttribute = calls.length;
    assert.throws(() => metaObserver.emit([{ target: unrelatedMeta, attributeName: "content" }]), /unobserved target/);
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(calls.length, beforeUnrelatedAttribute, "unrelated metadata changes do not publish Journey navigation");
    let alternateName = "description";
    const alternateMeta = { matches: (selector) => selector === "meta" || selector === 'meta[name="sporades-journey"]', getAttribute: (name) => name === "name" ? alternateName : "alternate.page" };
    semanticMeta.getAttribute = () => "orders.revised"; metaObserver.emit([{ target: semanticMeta, attributeName: "content" }]);
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(calls.at(-1).metadata.page, "orders.revised");
    const removedMeta = semanticMeta;
    alternateName = "sporades-journey"; semanticMeta = alternateMeta; headMetas = [alternateMeta]; headObserver.emit([{ addedNodes: [alternateMeta], removedNodes: [removedMeta] }]);
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(calls.at(-1).metadata.page, "alternate.page", "replacing the active meta selects the newly inserted semantic meta");
    semanticMeta = null; headMetas = []; headObserver.emit([{ addedNodes: [], removedNodes: [{ matches: (selector) => selector === "meta" }] }]);
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(calls.at(-1).metadata.page, "/checkout");
    let transitionName = "sporades-journey";
    let transitionContent = "transition.page";
    const transitioningMeta = { matches: (selector) => selector === "meta", getAttribute: (name) => name === "name" ? transitionName : transitionContent };
    semanticMeta = transitioningMeta; headMetas = [transitioningMeta]; headObserver.emit([{ addedNodes: [transitioningMeta], removedNodes: [] }]);
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(calls.at(-1).metadata.page, "transition.page");
    transitionContent = "x".repeat(257); metaObserver.emit([{ target: transitioningMeta, attributeName: "content", oldValue: "transition.page" }]);
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(calls.at(-1).metadata.page, "/checkout", "oversized semantic pages fail safely to the normalized pathname");
    transitionName = "description"; semanticMeta = null;
    metaObserver.emit([{ target: transitioningMeta, attributeName: "name", oldValue: "sporades-journey" }]);
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(calls.at(-1).metadata.page, "/checkout");
    const clickListenerCount = (listeners.get("click") ?? []).length;
    const replacementRuntime = await importClientRuntime(); await replacementRuntime.journey.enable(); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((listeners.get("click") ?? []).length, clickListenerCount, "repeat enable/HMR setup remains idempotent");
    const annotation = { getAttribute: (name) => name === "data-sporades-journey" ? "checkout.started" : null };
    for (const listener of listeners.get("click") ?? []) listener({ type: "click", composedPath: () => [annotation], defaultPrevented: false, secret: "never publish" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.at(-1), { status: "checkout.started", metadata: { page: "/checkout" } });
    const beforePrevented = calls.length;
    for (const listener of listeners.get("click") ?? []) listener({ type: "click", composedPath: () => [annotation], defaultPrevented: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, beforePrevented);
    const beforeInvalid = calls.length;
    const invalid = { getAttribute: () => "inactive" };
    const oversized = { getAttribute: () => "x".repeat(257) };
    for (const value of [invalid, oversized]) for (const listener of listeners.get("click") ?? []) listener({ type: "click", composedPath: () => [value], defaultPrevented: false });
    await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(calls.length, beforeInvalid);
    assert.equal(listeners.has("change"), false); assert.equal(listeners.has("pointerdown"), false); assert.equal(listeners.has("keydown"), false);
    const inner = { getAttribute: () => "dialog.confirmed" }; const outer = { getAttribute: () => "dialog.open" };
    for (const listener of listeners.get("click") ?? []) listener({ type: "click", composedPath: () => [inner, outer], defaultPrevented: false, stopPropagation() {} });
    await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(calls.at(-1).status, "dialog.confirmed", "nearest open-shadow composedPath annotation wins despite stopped propagation");
    const closedHost = { getAttribute: () => "widget.activated" };
    for (const listener of listeners.get("click") ?? []) listener({ type: "click", composedPath: () => [closedHost], defaultPrevented: false });
    await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(calls.at(-1).status, "widget.activated", "closed shadow capture requires and accepts its annotated host");
    await replacementRuntime.journey.set({ status: "manual.override", metadata: { typed: true } });
    assert.equal(calls.at(-1).status, "manual.override");
    const form = { getAttribute: (name) => name === "data-sporades-journey" ? "checkout.form" : null };
    const beforeSubmit = calls.length;
    for (const listener of listeners.get("click") ?? []) listener({ type: "click", composedPath: () => [annotation, form], defaultPrevented: false });
    for (const listener of listeners.get("submit") ?? []) listener({ type: "submit", submitter: annotation, composedPath: () => [form], defaultPrevented: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, beforeSubmit + 1, "native submit activation publishes exactly once");
    assert.equal(calls.at(-1).status, "checkout.started", "submitter annotation wins over its form");
    const plainSubmitter = { getAttribute: () => null };
    const beforeFormSubmit = calls.length;
    for (const listener of listeners.get("click") ?? []) listener({ type: "click", composedPath: () => [plainSubmitter, form], defaultPrevented: false });
    for (const listener of listeners.get("submit") ?? []) listener({ type: "submit", submitter: plainSubmitter, composedPath: () => [form], defaultPrevented: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, beforeFormSubmit + 1, "unannotated submitter activation dedupes by selected annotated form");
    assert.equal(calls.at(-1).status, "checkout.form");
    const beforeEnter = calls.length;
    for (const listener of listeners.get("submit") ?? []) listener({ type: "submit", submitter: null, composedPath: () => [form], defaultPrevented: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, beforeEnter + 1, "Enter-key form submission follows the native submit path");
    const sameStatusClick = { getAttribute: () => "shared.status" };
    const sameStatusForm = { getAttribute: () => "shared.status" };
    const beforeUnrelated = calls.length;
    for (const listener of listeners.get("click") ?? []) listener({ type: "click", composedPath: () => [sameStatusClick], defaultPrevented: false });
    for (const listener of listeners.get("submit") ?? []) listener({ type: "submit", submitter: null, composedPath: () => [sameStatusForm], defaultPrevented: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, beforeUnrelated + 2, "an unrelated same-status click and programmatic submit both publish");
    const nonSubmitButton = { getAttribute: () => null };
    const otherSubmitter = { getAttribute: () => null };
    const beforeRequestSubmit = calls.length;
    for (const listener of listeners.get("click") ?? []) listener({ type: "click", composedPath: () => [nonSubmitButton, form], defaultPrevented: false });
    for (const listener of listeners.get("submit") ?? []) listener({ type: "submit", submitter: otherSubmitter, composedPath: () => [form], defaultPrevented: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, beforeRequestSubmit + 2, "non-submit click and requestSubmit with another submitter remain distinct interactions");
    await replacementRuntime.journey.disable();
    assert.equal((listeners.get("click") ?? []).length, 0);
    for (const type of ["submit", "popstate", "hashchange", "focus", "blur", "visibilitychange"]) assert.equal((listeners.get(type) ?? []).length, 0, `${type} listener is torn down`);
    assert.equal(window.history.pushState, nativePushState, "native History methods are restored on teardown");
    assert.ok(observers.every((observer) => observer.observations.length === 0), "metadata observers are disconnected on teardown");
  } finally { delete globalThis.MutationObserver; delete globalThis.document; browser.cleanup(); }
});

test("Journey capture narrowing can keep a consenting page invisible while manual state remains available", async () => {
  const calls = [];
  const browser = installBrowserFakes(anonymousAuth, { handlers: {
    "journey.enable": async () => ({ type: "journey.enable.result", data: { userId: anonymousAuth.userId, capture: { navigation: false, focus: false, interactions: false } }, error: null }),
    "journey.set": async (message) => { calls.push(message.state); return { type: "journey.set.result", data: { journey: message.state }, error: null }; },
  }});
  globalThis.document = { head: {}, documentElement: {}, querySelector: () => null };
  try {
    const runtime = await importClientRuntime();
    const result = await runtime.journey.enable({ capture: { navigation: false, focus: false, interactions: false } });
    assert.deepEqual(result.data.capture, { navigation: false, focus: false, interactions: false });
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.deepEqual(calls, []);
    await runtime.journey.set({ status: "typing", metadata: { step: 2 }, ttlSeconds: 7 });
    assert.deepEqual(calls, [{ status: "typing", metadata: { step: 2 }, ttlSeconds: 7 }]);
  } finally { delete globalThis.document; browser.cleanup(); }
});

test("same-user reconnect restores consent and narrowed capture policy", async () => {
  const enables = []; const states = [];
  const browser = installBrowserFakes(anonymousAuth, { href: "https://capsule.test/resume", handlers: {
    "journey.enable": async (message) => { enables.push(message); return { type: "journey.enable.result", data: { userId: anonymousAuth.userId, capture: { navigation: true, focus: false, interactions: false } }, error: null }; },
    "journey.set": async (message) => { states.push(message.state); return { type: "journey.set.result", data: { journey: message.state }, error: null }; },
  }});
  const listeners = new Map(); const add = (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  const remove = (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener));
  globalThis.document = { head: { querySelectorAll: () => [] }, documentElement: {}, querySelector: () => null, addEventListener: add, removeEventListener: remove };
  window.addEventListener = add; window.removeEventListener = remove; window.history = { pushState() {}, replaceState() {} };
  window.requestAnimationFrame = (callback) => { queueMicrotask(callback); return 1; }; window.cancelAnimationFrame = () => {};
  try {
    const runtime = await importClientRuntime();
    const enabled = await runtime.journey.enable({ capture: { focus: false, interactions: false } });
    assert.equal(enabled.data.sessionId, undefined); await new Promise((resolve) => setTimeout(resolve, 0));
    browser.sockets[0].readyState = 3; browser.sockets[0].emit("close", {});
    await new Promise((resolve) => setTimeout(resolve, 550)); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(enables.map(({ options }) => options), [
      { capture: { focus: false, interactions: false } },
      { capture: { focus: false, interactions: false } },
    ]);
    assert.equal(states.filter(({ status }) => status === "viewing").length, 2, "capture resumes once after reconnect without duplicate observers");
    assert.equal((listeners.get("focus") ?? []).length, 0); assert.equal((listeners.get("click") ?? []).length, 0);
  } finally { delete globalThis.document; browser.cleanup(); }
});

function installBrowserFakes(auth, options = {}) {
  const storage = new Map();
  const sockets = [];
  const sent = [];
  const handlers = options.handlers ?? {};

  globalThis.localStorage = {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };
  globalThis.window = {
    __SPORADES_CONNECTION_TOKEN: options.connectionToken ?? "fake-page-connection-token",
    location: {
      href: options.href ?? "http://localhost:4000/",
      assign(url) {
        storage.set("assignedLocation", url);
      },
    },
  };
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = FakeWebSocket.CONNECTING;
    listeners = new Map();

    constructor(url) {
      this.url = url;
      sockets.push(this);
      if (options.autoOpen !== false) {
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.emit("open", {});
        });
      }
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(rawMessage) {
      const message = JSON.parse(rawMessage);
      sent.push(message);
      const handler = handlers[message.type];
      if (handler) {
        queueMicrotask(async () => {
          let response;
          try {
            response = await handler(message);
          } catch (error) {
            response = {
              type: "error",
              error: {
                message: error.message,
                hint: "The fake browser handler failed.",
              },
            };
          }
          this.emit("message", {
            data: JSON.stringify({ id: message.id, ...response }),
          });
        });
        return;
      }

      if (message.type === "auth.get") {
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              id: message.id,
              type: "auth.result",
              data: {
                sessionToken: "session-token",
                auth,
                providers: {},
              },
              error: null,
            }),
          });
        });
        return;
      }

      if (message.type === "dev.refresh.subscribe") {
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({ id: message.id, type: "dev.refresh.ready", data: { mode: "full-page", sequence: 0 }, error: null }),
          });
        });
        return;
      }

      if (message.type === "auth.signIn") {
        storage.set("signInMessage", JSON.stringify(message));
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              id: message.id,
              type: "auth.redirect",
              data: { url: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque-state" },
              error: null,
            }),
          });
        });
        return;
      }

      if (message.type === "app.send") {
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              id: message.id,
              type: "app.result",
              message: message.message,
              data: { accepted: message.data },
              error: null,
            }),
          });
        });
        return;
      }

    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  };

  return {
    storage,
    sockets,
    sent,
    openSockets() {
      for (const socket of sockets) {
        socket.readyState = globalThis.WebSocket.OPEN;
        socket.emit("open", {});
      }
    },
    cleanup() {
      delete globalThis.localStorage;
      delete globalThis.window;
      delete globalThis.WebSocket;
    },
  };
}

const anonymousAuth = {
  userId: "anonymous-user",
  displayName: "Anonymous",
  email: null,
  picture: null,
  isAuthenticated: false,
  isGuest: true,
  provider: "anonymous",
};

test("framework-neutral query mutation and auth primitives share reconnecting state", async () => {
  let queryVersion = 0;
  const queryCalls = [];
  const unsubscribeCalls = [];
  const authCalls = [];
  const mutationCalls = [];
  const browser = installBrowserFakes(anonymousAuth, { handlers: {
    "query.subscribe": async (message) => {
      queryCalls.push(message);
      queryVersion += 1;
      return { type: "query.result", data: [{ id: queryVersion, text: `note ${queryVersion}` }], error: null };
    },
    "mutation.run": async (message) => {
      mutationCalls.push(message);
      return { type: "mutation.result", data: { created: message.args[0] }, error: null };
    },
    "query.unsubscribe": async (message) => {
      unsubscribeCalls.push(message);
      return { type: "query.unsubscribe.result", data: { removed: true }, error: null };
    },
    "auth.get": async (message) => {
      authCalls.push(message);
      return {
        type: "auth.result",
        data: { sessionToken: `secret-${authCalls.length}`, transportCredential: "never-public", auth: anonymousAuth, providers: {} },
        error: null,
      };
    },
  }});
  try {
    const runtime = await importClientRuntime();
    assert.equal(typeof runtime.queries.subscribe, "function");
    assert.equal(typeof runtime.mutations.run, "function");
    assert.equal(typeof runtime.auth.get, "function");
    assert.equal(typeof runtime.auth.subscribe, "function");

    const queryStates = [];
    const querySubscription = runtime.queries.subscribe("notes", (state) => queryStates.push(state));
    const authStates = [];
    const authSubscription = runtime.auth.subscribe((state) => authStates.push(state));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(queryStates, [
      { data: null, error: null, loading: true },
      { data: [{ id: 1, text: "note 1" }], error: null, loading: false },
    ]);
    assert.equal(authStates[0].loading, true);
    assert.deepEqual(authStates.at(-1), { auth: anonymousAuth, providers: {}, loading: false, error: null });
    assert.equal(browser.sockets.length, 1, "all primitives share one page connection");

    const latestQueries = [];
    const secondQuery = runtime.queries.subscribe("notes", (state) => latestQueries.push(state));
    const latestAuth = [];
    const secondAuth = runtime.auth.subscribe((state) => latestAuth.push(state));
    assert.deepEqual(latestQueries, [{ data: [{ id: 1, text: "note 1" }], error: null, loading: false }]);
    assert.deepEqual(latestAuth, [{ auth: anonymousAuth, providers: {}, loading: false, error: null }]);
    assert.equal(queryCalls.length, 1, "same-name subscribers share one wire subscription");

    assert.deepEqual(await runtime.mutations.run("addNote", "hello"), {
      id: mutationCalls[0]?.id,
      type: "mutation.result",
      data: { created: "hello" },
      error: null,
    });
    assert.deepEqual(mutationCalls[0].args, ["hello"]);
    assert.deepEqual(await runtime.auth.get(), { data: { auth: anonymousAuth, providers: {} }, error: null });
    assert.doesNotMatch(JSON.stringify(authStates), /secret-|transportCredential|sessionToken/);

    browser.sockets[0].readyState = 3;
    browser.sockets[0].emit("close", {});
    await new Promise((resolve) => setTimeout(resolve, 550));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(queryCalls.length, 2);
    assert.deepEqual(queryStates.at(-1), { data: [{ id: 2, text: "note 2" }], error: null, loading: false });

    querySubscription.unsubscribe(); querySubscription.unsubscribe();
    assert.equal(unsubscribeCalls.length, 0, "the shared wire subscription remains while one listener is active");
    secondQuery.unsubscribe(); secondQuery.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(unsubscribeCalls.length, 1, "last-listener teardown sends one idempotent wire unsubscribe");
    assert.equal(unsubscribeCalls[0].subscriptionId, queryCalls[0].id);
    authSubscription.unsubscribe(); authSubscription.unsubscribe();
    secondAuth.unsubscribe(); secondAuth.unsubscribe();
    browser.sockets.at(-1).readyState = 3;
    browser.sockets.at(-1).emit("close", {});
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(queryCalls.length, 2, "unsubscribed queries do not resubscribe");
    assert.doesNotMatch(JSON.stringify(authStates), /secret-|transportCredential|sessionToken/);

    const disconnectedStates = [];
    const disconnected = runtime.queries.subscribe("disconnected", (state) => disconnectedStates.push(state));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const latestSocket = browser.sockets.at(-1);
    latestSocket.send = () => { throw new Error("transport closed during unsubscribe"); };
    disconnected.unsubscribe(); disconnected.unsubscribe();
    latestSocket.readyState = 3;
    latestSocket.emit("close", {});
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(queryCalls.filter((message) => message.query === "disconnected").length, 1, "failed best-effort unsubscribe cannot resurrect on reconnect");
  } finally { browser.cleanup(); }
});

test("client isAuthenticated returns false for anonymous auth", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  try {
    const runtime = await importClientRuntime();
    assert.equal(await runtime.isAuthenticated(), false);
    assert.equal(browser.storage.get("sporades.sessionToken"), "session-token");
  } finally {
    browser.cleanup();
  }
});

test("client WebSocket URL does not include the stored session token", async () => {
  const browser = installBrowserFakes(anonymousAuth, { autoOpen: false });
  browser.storage.set("sporades.sessionToken", "stored-session-token");
  try {
    const runtime = await importClientRuntime();
    const authPromise = runtime.isAuthenticated();
    browser.openSockets();
    await authPromise;

    assert.equal(browser.sockets.length, 1);
    const url = new URL(browser.sockets[0].url);
    assert.equal(url.pathname, "/__sporades/ws");
    assert.equal(url.searchParams.has("sessionToken"), false);
    assert.equal(String(browser.sockets[0].url).includes("stored-session-token"), false);
  } finally {
    browser.cleanup();
  }
});

test("client performs one full-page refresh from the Sporades transport without another WebSocket", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  let reloads = 0;
  globalThis.window.location.reload = () => { reloads += 1; };
  try {
    const runtime = await importClientRuntime({ devRefresh: true });
    await runtime.auth.get();
    assert.equal(browser.sockets.length, 1);
    assert.equal(browser.sent.filter((message) => message.type === "dev.refresh.subscribe").length, 1, "the sole page transport explicitly joins the Dev refresh broadcast set");
    assert.equal(browser.sockets[0].listeners.get("message")?.length, 1);
    const refreshFrame = { data: JSON.stringify({ id: null, type: "refresh", data: { mode: "full-page", sequence: 1 }, error: null }) };
    browser.sockets[0].emit("message", refreshFrame);
    browser.sockets[0].emit("message", refreshFrame);
    assert.equal(reloads, 1);
    const receipts = browser.sent.filter((message) => message.type === "dev.refresh.received");
    assert.equal(receipts.length, 2, "duplicate delivery is acknowledged again so the server can stop resending");
    assert.deepEqual(receipts[0], { id: null, type: "dev.refresh.received", sequence: 1, sessionToken: "session-token" });
    assert.equal(browser.sockets.length, 1, "refresh reuses the sole Sporades page transport");
  } finally {
    browser.cleanup();
  }
});

test("production client runtime omits the Dev refresh protocol", async () => {
  const source = createClientRuntimeSource();
  assert.doesNotMatch(source, /dev\.refresh\.(?:subscribe|ready|received)/);
  const browser = installBrowserFakes(anonymousAuth);
  try {
    const runtime = await importClientRuntime();
    await runtime.auth.get();
    assert.equal(browser.sent.some((message) => String(message.type).startsWith("dev.refresh.")), false);
  } finally { browser.cleanup(); }
});

test("client isAuthenticated returns true for linked auth", async () => {
  const browser = installBrowserFakes({
    userId: "linked-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "google",
  });
  try {
    const runtime = await importClientRuntime();
    assert.equal(await runtime.isAuthenticated(), true);
  } finally {
    browser.cleanup();
  }
});

test("client sendMessage sends unprefixed app messages over the transport", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  try {
    const runtime = await importClientRuntime();
    const result = await runtime.sendMessage("typing", { roomId: "general" });

    assert.equal(typeof result.id, "number");
    assert.deepEqual(
      {
        ...result,
        id: "request-id",
      },
      {
        id: "request-id",
        type: "app.result",
        message: "typing",
        data: { accepted: { roomId: "general" } },
        error: null,
      },
    );
  } finally {
    browser.cleanup();
  }
});

test("client preferences SDK reads and updates current-user preferences over the transport", async () => {
  let storedPreferences = {};
  const browser = installBrowserFakes(anonymousAuth, {
    handlers: {
      "preferences.get": async (message) => {
        browser.storage.set("preferencesGetMessage", JSON.stringify(message));
        return {
          type: "preferences.result",
          data: { preferences: storedPreferences },
          error: null,
        };
      },
      "preferences.update": async (message) => {
        browser.storage.set("preferencesUpdateMessage", JSON.stringify(message));
        storedPreferences = { ...storedPreferences, ...message.patch };
        return {
          type: "preferences.result",
          data: { preferences: storedPreferences },
          error: null,
        };
      },
    },
  });
  try {
    const runtime = await importClientRuntime();

    const initial = await runtime.preferences.get();
    assert.deepEqual({
      ...initial,
      id: "request-id",
    }, {
      id: "request-id",
      type: "preferences.result",
      data: { preferences: {} },
      error: null,
    });
    assert.deepEqual({ ...JSON.parse(browser.storage.get("preferencesGetMessage")), id: "request-id" }, {
      id: "request-id",
      type: "preferences.get",
    });

    const updated = await runtime.preferences.update({ theme: "dark" });
    assert.deepEqual({
      ...updated,
      id: "request-id",
    }, {
      id: "request-id",
      type: "preferences.result",
      data: { preferences: { theme: "dark" } },
      error: null,
    });
    assert.deepEqual({ ...JSON.parse(browser.storage.get("preferencesUpdateMessage")), id: "request-id" }, {
      id: "request-id",
      type: "preferences.update",
      patch: { theme: "dark" },
      sessionToken: "session-token",
    });
  } finally {
    browser.cleanup();
  }
});

test("client onMessage exposes filterable app message subscriptions", async () => {
  const browser = installBrowserFakes(anonymousAuth);
  try {
    const runtime = await importClientRuntime();
    const received = [];
    const subscription = runtime
      .onMessage()
      .filter((message) => message.type === "typing")
      .subscribe((message) => received.push(message));

    await new Promise((resolve) => setTimeout(resolve, 0));
    browser.sockets[0].emit("message", {
      data: JSON.stringify({
        type: "app.message",
        message: "typing",
        data: { roomId: "general" },
      }),
    });
    browser.sockets[0].emit("message", {
      data: JSON.stringify({
        type: "app.message",
        message: "ignored",
        data: { roomId: "general" },
      }),
    });

    assert.deepEqual(received, [{ type: "typing", data: { roomId: "general" } }]);
    subscription.unsubscribe();
  } finally {
    browser.cleanup();
  }
});

test("client auth.signIn starts a full-page provider redirect and preserves the current URL", async () => {
  const browser = installBrowserFakes(anonymousAuth, { href: "http://localhost:4000/notes?filter=mine#today" });
  try {
    const runtime = await importClientRuntime();
    await runtime.auth.signIn("google");
    assert.deepEqual({ ...JSON.parse(browser.storage.get("signInMessage")), id: "request-id" }, {
      id: "request-id",
      type: "auth.signIn",
      provider: "google",
      returnTo: "http://localhost:4000/notes?filter=mine#today",
    });
    assert.equal(browser.storage.get("sporades.authReturnTo"), "http://localhost:4000/notes?filter=mine#today");
    assert.equal(browser.storage.get("assignedLocation"), "https://accounts.google.com/o/oauth2/v2/auth?state=opaque-state");
  } finally {
    browser.cleanup();
  }
});

test("client auth.signIn sends email credentials without starting a redirect", async () => {
  const emailAuth = {
    userId: "email-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const browser = installBrowserFakes(anonymousAuth, {
    href: "http://localhost:4000/notes?filter=mine#today",
    handlers: {
      "auth.signIn": async (message) => {
        browser.storage.set("emailSignInMessage", JSON.stringify(message));
        return {
          type: "auth.signIn.result",
          data: {
            ok: true,
            sessionToken: "rotated-email-token",
            auth: emailAuth,
          },
          error: null,
        };
      },
    },
  });
  const stateUpdates = [];
  try {
    const runtime = await importClientRuntime();
    const hooks = runtime.createHooks({
      useState(initialState) {
        return [initialState, (nextState) => stateUpdates.push(nextState)];
      },
      useEffect(effect) {
        effect();
      },
    });
    hooks.useAuth();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await runtime.auth.signIn("email", {
      email: "mira@example.com",
      password: "correct horse battery staple",
    });

    assert.deepEqual({ ...JSON.parse(browser.storage.get("emailSignInMessage")), id: "request-id" }, {
      id: "request-id",
      type: "auth.signIn",
      provider: "email",
      credentials: {
        email: "mira@example.com",
        password: "correct horse battery staple",
      },
      sessionToken: "session-token",
    });
    assert.equal(browser.storage.get("assignedLocation"), undefined);
    assert.equal(browser.storage.get("sporades.authReturnTo"), undefined);
    assert.equal(result.type, "auth.signIn.result");
    assert.equal(result.error, null);
    assert.equal(result.data.ok, true);
    assert.equal(browser.storage.get("sporades.sessionToken"), "rotated-email-token");
    assert.deepEqual(
      stateUpdates.map((state) => state.auth?.provider),
      ["anonymous", "email"],
    );
    assert.deepEqual(stateUpdates.at(-1).auth, emailAuth);
  } finally {
    browser.cleanup();
  }
});

test("client auth.signUp sends email credentials through the provider-generic auth surface", async () => {
  const emailAuth = {
    userId: "email-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const browser = installBrowserFakes(anonymousAuth, {
    handlers: {
      "auth.signUp": async (message) => {
        browser.storage.set("signUpMessage", JSON.stringify(message));
        return {
          type: "auth.signUp.result",
          data: {
            ok: true,
            sessionToken: "rotated-sign-up-token",
            auth: emailAuth,
          },
          error: null,
        };
      },
    },
  });
  const stateUpdates = [];
  try {
    const runtime = await importClientRuntime();
    const hooks = runtime.createHooks({
      useState(initialState) {
        return [initialState, (nextState) => stateUpdates.push(nextState)];
      },
      useEffect(effect) {
        effect();
      },
    });
    hooks.useAuth();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await runtime.auth.signUp("email", {
      email: "mira@example.com",
      password: "correct horse battery staple",
      name: "Mira",
    });

    assert.deepEqual({ ...JSON.parse(browser.storage.get("signUpMessage")), id: "request-id" }, {
      id: "request-id",
      type: "auth.signUp",
      provider: "email",
      credentials: {
        email: "mira@example.com",
        password: "correct horse battery staple",
        name: "Mira",
      },
      sessionToken: "session-token",
    });
    assert.equal(result.type, "auth.signUp.result");
    assert.equal(result.error, null);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.auth.provider, "email");
    assert.equal(browser.storage.get("sporades.sessionToken"), "rotated-sign-up-token");
    assert.deepEqual(
      stateUpdates.map((state) => state.auth?.provider),
      ["anonymous", "email"],
    );
    assert.deepEqual(stateUpdates.at(-1).auth, emailAuth);
  } finally {
    browser.cleanup();
  }
});

test("client auth.signOut clears the stored session and refreshes auth state", async () => {
  const linkedAuth = {
    userId: "linked-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "google",
  };
  let currentAuth = linkedAuth;
  let currentToken = "linked-session-token";
  const browser = installBrowserFakes(linkedAuth, {
    handlers: {
      "auth.get": async () => ({
        type: "auth.result",
        data: {
          sessionToken: currentToken,
          auth: currentAuth,
          providers: {},
        },
        error: null,
      }),
      "auth.signOut": async () => {
        currentAuth = anonymousAuth;
        currentToken = "fresh-anonymous-token";
        return {
          type: "auth.signOut.result",
          data: {
            ok: true,
          },
          error: null,
        };
      },
    },
  });
  try {
    const runtime = await importClientRuntime();
    assert.equal(await runtime.isAuthenticated(), true);
    assert.equal(browser.storage.get("sporades.sessionToken"), "linked-session-token");

    const result = await runtime.auth.signOut();

    assert.deepEqual(result.data, { ok: true });
    assert.equal(browser.storage.get("sporades.sessionToken"), "fresh-anonymous-token");
    assert.equal(await runtime.isAuthenticated(), false);
  } finally {
    browser.cleanup();
  }
});

test("client auth.signOut returns structured errors without clearing the session on failure", async () => {
  const linkedAuth = {
    userId: "linked-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "google",
  };
  const browser = installBrowserFakes(linkedAuth, {
    handlers: {
      "auth.get": async () => ({
        type: "auth.result",
        data: {
          sessionToken: "linked-session-token",
          auth: linkedAuth,
          providers: {},
        },
        error: null,
      }),
      "auth.signOut": async () => ({
        type: "error",
        data: null,
        error: {
          message: "Could not sign out.",
          hint: "Retry sign-out.",
        },
      }),
    },
  });
  try {
    const runtime = await importClientRuntime();
    assert.equal(await runtime.isAuthenticated(), true);

    const result = await runtime.auth.signOut();

    assert.deepEqual(result, {
      id: result.id,
      type: "error",
      data: null,
      error: {
        message: "Could not sign out.",
        hint: "Retry sign-out.",
      },
    });
    assert.equal(browser.storage.get("sporades.sessionToken"), "linked-session-token");
    assert.equal(await runtime.isAuthenticated(), true);
  } finally {
    browser.cleanup();
  }
});

test("useAuth receives refreshed anonymous auth state after sign-out", async () => {
  const linkedAuth = {
    userId: "linked-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "google",
  };
  let currentAuth = linkedAuth;
  let currentToken = "linked-session-token";
  const browser = installBrowserFakes(linkedAuth, {
    handlers: {
      "auth.get": async () => ({
        type: "auth.result",
        data: {
          sessionToken: currentToken,
          auth: currentAuth,
          providers: {},
        },
        error: null,
      }),
      "auth.signOut": async () => {
        currentAuth = anonymousAuth;
        currentToken = "fresh-anonymous-token";
        return {
          type: "auth.signOut.result",
          data: { ok: true },
          error: null,
        };
      },
    },
  });
  const stateUpdates = [];
  try {
    const runtime = await importClientRuntime();
    const hooks = runtime.createHooks({
      useState(initialState) {
        return [initialState, (nextState) => stateUpdates.push(nextState)];
      },
      useEffect(effect) {
        effect();
      },
    });

    const authState = hooks.useAuth();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authState.signOut();

    assert.deepEqual(
      stateUpdates.map((state) => state.auth?.provider),
      ["google", "anonymous"],
    );
    assert.equal(browser.storage.get("sporades.sessionToken"), "fresh-anonymous-token");
  } finally {
    browser.cleanup();
  }
});

test("client applies internal auth session replacement messages to localStorage and auth state", async () => {
  const simulatedAuth = {
    userId: "simulated-user",
    displayName: "Mira Vale",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const browser = installBrowserFakes(anonymousAuth);
  const stateUpdates = [];
  const appMessages = [];
  try {
    const runtime = await importClientRuntime();
    runtime.onMessage((message) => appMessages.push(message));
    const hooks = runtime.createHooks({
      useState(initialState) {
        return [initialState, (nextState) => stateUpdates.push(nextState)];
      },
      useEffect(effect) {
        effect();
      },
    });

    hooks.useAuth();
    await new Promise((resolve) => setTimeout(resolve, 0));
    browser.sockets[0].emit("message", {
      data: JSON.stringify({
        id: null,
        type: "auth.session.replace",
        data: {
          sessionToken: "simulated-session-token",
          auth: simulatedAuth,
        },
        error: null,
      }),
    });

    assert.equal(browser.storage.get("sporades.sessionToken"), "simulated-session-token");
    assert.deepEqual(
      stateUpdates.map((state) => state.auth?.provider),
      ["anonymous", "email"],
    );
    assert.deepEqual(stateUpdates.at(-1).auth, simulatedAuth);
    assert.deepEqual(appMessages, []);
  } finally {
    browser.cleanup();
  }
});

test("client files.upload negotiates an upload URL and transfers one file", async () => {
  let negotiatedMessage = null;
  const browser = installBrowserFakes(anonymousAuth, {
    autoOpen: false,
    handlers: {
      "file.uploadUrl": async (message) => {
        negotiatedMessage = message;
        return {
          type: "file.uploadUrl.result",
          data: {
            uploadUrl: "/__sporades/uploads/file-1",
            method: "PUT",
            headers: {},
            file: {
              id: "file-1",
              bucket: "default",
              size: 11,
              type: "text/plain",
              name: "hello.txt",
              path: "/docs/hello.txt",
              version: "version-1",
            },
          },
          error: null,
        };
      },
    },
  });
  const uploads = [];
  globalThis.fetch = async (url, options = {}) => {
    uploads.push({ url, method: options.method, body: await options.body.text() });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          data: {
            file: {
              id: "file-1",
              bucket: "default",
              size: 11,
              type: "text/plain",
              name: "hello.txt",
              path: "/docs/hello.txt",
              version: "version-1",
            },
          },
          error: null,
        };
      },
    };
  };

  try {
    const runtime = await importClientRuntime();
    const events = [];
    const file = new Blob(["hello world"], { type: "text/plain" });
    file.name = "hello.txt";

    const uploadPromise = runtime.files.upload(file, {
      path: "/docs/hello.txt",
      onProgress: (event) => events.push(event),
      onComplete: (event) => events.push(event),
    });
    browser.openSockets();
    const metadata = await uploadPromise;

    assert.deepEqual(uploads, [
      {
        url: "/__sporades/uploads/file-1",
        method: "PUT",
        body: "hello world",
      },
    ]);
    assert.equal(metadata.id, "file-1");
    assert.equal(metadata.bucket, "default");
    assert.equal(metadata.size, 11);
    assert.equal(metadata.type, "text/plain");
    assert.equal(metadata.name, "hello.txt");
    assert.equal(metadata.version, "version-1");
    assert.equal(metadata.path, "/docs/hello.txt");
    assert.equal(negotiatedMessage.file.path, "/docs/hello.txt");
    assert.deepEqual(events.map((event) => event.type), ["progress", "complete"]);
  } finally {
    delete globalThis.fetch;
    browser.cleanup();
  }
});

test("client files.upload uploads arrays sequentially through the single-file path", async () => {
  const negotiatedNames = [];
  const uploadedBodies = [];
  const browser = installBrowserFakes(anonymousAuth, {
    autoOpen: false,
    handlers: {
      "file.uploadUrl": async (message) => {
        negotiatedNames.push(message.file.name);
        const index = negotiatedNames.length;
        return {
          type: "file.uploadUrl.result",
          data: {
            uploadUrl: `/__sporades/uploads/file-${index}`,
            method: "PUT",
            headers: {},
            file: {
              id: `file-${index}`,
              bucket: "default",
              size: message.file.size,
              type: "text/plain",
              name: message.file.name,
              path: `/__sporades/files/private/file-${index}?v=version-${index}`,
              version: `version-${index}`,
            },
          },
          error: null,
        };
      },
    },
  });
  globalThis.fetch = async (_url, options = {}) => {
    uploadedBodies.push(await options.body.text());
    return {
      ok: true,
      status: 200,
      async json() {
        const index = uploadedBodies.length;
        return {
          ok: true,
          data: {
            file: {
              id: `file-${index}`,
              bucket: "default",
              size: uploadedBodies[index - 1].length,
              type: "text/plain",
              name: negotiatedNames[index - 1],
              path: `/__sporades/files/private/file-${index}?v=version-${index}`,
              version: `version-${index}`,
            },
          },
          error: null,
        };
      },
    };
  };

  try {
    const runtime = await importClientRuntime();
    const first = new Blob(["one"], { type: "text/plain" });
    first.name = "one.txt";
    const second = new Blob(["two"], { type: "text/plain" });
    second.name = "two.txt";

    const uploadPromise = runtime.files.upload([first, second]);
    browser.openSockets();
    const results = await uploadPromise;

    assert.deepEqual(negotiatedNames, ["one.txt", "two.txt"]);
    assert.deepEqual(uploadedBodies, ["one", "two"]);
    assert.deepEqual(results.map((file) => file.id), ["file-1", "file-2"]);
  } finally {
    delete globalThis.fetch;
    browser.cleanup();
  }
});

test("client files.download authenticates private reads with a header instead of a URL token", async () => {
  let requestedReference = null;
  const browser = installBrowserFakes(anonymousAuth, {
    autoOpen: false,
    handlers: {
      "file.url": async (message) => {
        requestedReference = message.fileReference;
        return {
          type: "file.url.result",
          data: {
            url: "/__sporades/files/private/file-1?v=version-1",
            file: {
              id: "file-1",
              bucket: "default",
              size: 11,
              type: "text/plain",
              name: "hello.txt",
              path: "/docs/hello.txt",
              version: "version-1",
            },
          },
          error: null,
        };
      },
    },
  });
  const downloads = [];
  globalThis.fetch = async (url, options = {}) => {
    downloads.push({ url, headers: options.headers ?? {} });
    return {
      ok: true,
      status: 200,
      async blob() {
        return new Blob(["hello world"], { type: "text/plain" });
      },
    };
  };

  try {
    const runtime = await importClientRuntime();
    const downloadPromise = runtime.files.download("/docs/hello.txt");
    browser.openSockets();
    const blob = await downloadPromise;

    assert.equal(blob.type, "text/plain");
    assert.equal(requestedReference, "/docs/hello.txt");
    assert.deepEqual(downloads, [
      {
        url: "/__sporades/files/private/file-1?v=version-1",
        headers: { "x-sporades-session-token": "session-token" },
      },
    ]);
    assert.doesNotMatch(downloads[0].url, /sessionToken|session-token/);
  } finally {
    delete globalThis.fetch;
    browser.cleanup();
  }
});

test("client files.publicUrl sends expires using the server wire contract", async () => {
  let publicUrlMessage = null;
  const browser = installBrowserFakes(anonymousAuth, {
    autoOpen: false,
    handlers: {
      "file.publicUrl.create": async (message) => {
        publicUrlMessage = message;
        return {
          type: "file.publicUrl.result",
          data: {
            publicUrl: {
              id: "public-1",
              fileId: "file-1",
              url: "/__sporades/files/public/public-1?v=version-1",
              expiresAt: "2026-07-04T12:00:00.000Z",
              revokedAt: null,
            },
          },
          error: null,
        };
      },
    },
  });

  try {
    const runtime = await importClientRuntime();
    const expires = new Date("2026-07-04T12:00:00.000Z");
    const publicUrlPromise = runtime.files.publicUrl("/docs/hello.txt", { expires });
    browser.openSockets();
    const publicUrl = await publicUrlPromise;

    assert.equal(publicUrl.id, "public-1");
    assert.equal(publicUrlMessage.fileReference, "/docs/hello.txt");
    assert.deepEqual(publicUrlMessage.options, { expires: expires.toISOString() });
    assert.equal("expiresAt" in publicUrlMessage.options, false);
  } finally {
    browser.cleanup();
  }
});
