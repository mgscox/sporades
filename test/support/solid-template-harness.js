import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { Window } from "happy-dom";
import { build } from "vite";
import solid from "vite-plugin-solid";

export async function mountSolidTemplate(projectDir, initialState) {
  const harnessDir = path.join(projectDir, ".solid-template-harness");
  await rm(harnessDir, { recursive: true, force: true });
  await mkdir(harnessDir, { recursive: true });
  const clientStub = path.join(harnessDir, "sporades-client.ts");
  const entryPath = path.join(harnessDir, "entry.tsx");
  const bundlePath = path.join(harnessDir, "bundle.mjs");
  await Promise.all([
    writeFile(clientStub, `import { createSignal, onCleanup } from "solid-js";
const state = globalThis.__SPORADES_SOLID_TEMPLATE_HARNESS__;
export const auth = state.auth;
export const files = state.files;
export const journey = state.journey;
export const preferences = state.preferences;
export function createSolidPrimitives() {
  function observe(source) {
    const [value, setValue] = createSignal(source.value);
    source.start(setValue);
    onCleanup(() => source.stop(setValue));
    return value;
  }
  function createQuery(name) { return observe(state.controls.queries[name]); }
  function createMutation(name) {
    const source = state.controls.mutations[name];
    const [value, setValue] = createSignal({ data: source.value.data ?? null, error: source.value.error ?? null, loading: source.value.loading ?? false });
    let pending = 0, latestInvocation = 0;
    return { state: value, async run(...args) {
      const invocation = ++latestInvocation; pending += 1; source.counts.runs += 1;
      setValue({ data: null, error: null, loading: true });
      try {
        const result = await source.run(...args);
        if (invocation === latestInvocation) setValue({ data: result.error ? null : result.data ?? null, error: result.error ?? null, loading: pending > 1 });
        return result;
      } catch (error) {
        if (invocation === latestInvocation) setValue({ data: null, error: { message: error instanceof Error ? error.message : String(error) }, loading: pending > 1 });
        throw error;
      } finally {
        pending -= 1; setValue((current) => ({ ...current, loading: pending > 0 }));
      }
    } };
  }
  function createAuth() {
    const value = observe(state.controls.session);
    return { state: value, isAuthenticated: () => Boolean(value().auth?.isAuthenticated), signUp: auth.signUp, signIn: auth.signIn, signOut: auth.signOut };
  }
  return { createQuery, createMutation, createAuth };
}
`),
    writeFile(entryPath, `import { render } from "solid-js/web";
import App from "../client/App";
globalThis.__SPORADES_SOLID_TEMPLATE_UNMOUNT__ = render(() => <App />, document.querySelector("#app"));
`),
  ]);
  await build({
    root: projectDir,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [solid(), {
      name: "solid-template-harness-aliases",
      enforce: "pre",
      resolveId(id) {
        if (id === "sporades/client") return clientStub;
        return null;
      },
    }],
    build: {
      write: true,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      outDir: harnessDir,
      rollupOptions: { input: entryPath, output: { entryFileNames: "bundle.mjs", chunkFileNames: "chunk-[hash].mjs", assetFileNames: "asset-[hash][extname]" } },
    },
  });

  const state = createHarnessState(initialState);
  const window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = '<div id="app"></div>';
  const restoreGlobals = installWindowGlobals(window);
  globalThis.__SPORADES_SOLID_TEMPLATE_HARNESS__ = state;
  await import(`${pathToFileURL(bundlePath).href}?app=${Date.now()}-${Math.random()}`);
  await settle();

  return {
    window,
    document: window.document,
    state,
    text: () => window.document.body.textContent ?? "",
    find: (selector) => window.document.querySelector(selector),
    findAll: (selector) => [...window.document.querySelectorAll(selector)],
    setSession(value) { state.controls.session.publish(value); },
    setQuery(name, value) { state.controls.queries[name].publish(value); },
    async setValue(node, value, event = "input") { node.value = value; node.dispatchEvent(new window.Event(event, { bubbles: true })); await settle(); },
    async trigger(node, event, values = {}) {
      for (const [key, value] of Object.entries(values)) Object.defineProperty(node, key, { configurable: true, writable: true, value });
      node.dispatchEvent(new window.Event(event, { bubbles: true, cancelable: true }));
      await settle();
    },
    settle,
    async unmount() {
      globalThis.__SPORADES_SOLID_TEMPLATE_UNMOUNT__?.();
      await settle();
      delete globalThis.__SPORADES_SOLID_TEMPLATE_UNMOUNT__;
      delete globalThis.__SPORADES_SOLID_TEMPLATE_HARNESS__;
      restoreGlobals();
      await window.happyDOM.close();
    },
  };
}

function createHarnessState(initial) {
  const controls = {
    session: observable(initial.session),
    queries: Object.fromEntries(Object.entries(initial.queries ?? {}).map(([name, value]) => [name, observable(value)])),
    mutations: Object.fromEntries(Object.entries(initial.mutations ?? {}).map(([name, value]) => [name, { value, run: value.run, counts: { runs: 0 } }])),
  };
  return { ...initial, controls, counts: {
    session: controls.session.counts,
    queries: Object.fromEntries(Object.entries(controls.queries).map(([name, source]) => [name, source.counts])),
    mutations: Object.fromEntries(Object.entries(controls.mutations).map(([name, source]) => [name, source.counts])),
  } };
}

function observable(initial) {
  const listeners = new Set();
  const source = { value: initial, counts: { started: 0, active: 0, stopped: 0 },
    start(listener) { source.counts.started += 1; source.counts.active += 1; listeners.add(listener); listener(source.value); },
    stop(listener) { if (!listeners.delete(listener)) return; source.counts.active -= 1; source.counts.stopped += 1; },
    publish(value) { source.value = value; for (const listener of listeners) listener(value); },
  };
  return source;
}

function installWindowGlobals(window) {
  const names = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "HTMLMediaElement", "SVGElement", "Event", "CustomEvent", "Text", "Comment", "Document", "DocumentFragment", "ShadowRoot", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? window : window[name];
    if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"].includes(name) ? value.bind(window) : value });
  }
  return () => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } };
}

async function settle() { for (let index = 0; index < 10; index += 1) await Promise.resolve(); }
