import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { build } from "esbuild";
import { Window } from "happy-dom";
import { compile } from "svelte/compiler";

export async function mountSvelteTemplate(projectDir, initialState) {
  const harnessDir = path.join(projectDir, ".svelte-template-harness");
  await mkdir(harnessDir, { recursive: true });
  const sourcePath = path.join(projectDir, "client", "App.svelte");
  const compiledPath = path.join(projectDir, "client", "App.harness.js");
  const clientStub = path.join(harnessDir, "sporades-client.js");
  const storesStub = path.join(harnessDir, "sporades-stores.js");
  const entryPath = path.join(harnessDir, "entry.js");
  const bundlePath = path.join(harnessDir, "bundle.mjs");
  const compiled = compile(await readFile(sourcePath, "utf8"), {
    filename: sourcePath,
    generate: "client",
    css: "injected",
  });
  await Promise.all([
    writeFile(compiledPath, compiled.js.code),
    writeFile(clientStub, `const state = globalThis.__SPORADES_SVELTE_TEMPLATE_HARNESS__;
export const auth = state.auth;
export const files = state.files;
export const journey = state.journey;
export const preferences = state.preferences;
`),
    writeFile(storesStub, `const state = globalThis.__SPORADES_SVELTE_TEMPLATE_HARNESS__;
export const authStore = () => state.stores.session;
export const queryStore = (name) => state.stores.queries[name];
export const mutationStore = (name) => state.stores.mutations[name];
`),
    writeFile(entryPath, `import { mount, unmount } from "svelte";
import App from "../client/App.harness.js";
const app = mount(App, { target: document.querySelector("#app") });
globalThis.__SPORADES_SVELTE_TEMPLATE_UNMOUNT__ = () => unmount(app);
`),
  ]);
  await build({
    absWorkingDir: projectDir,
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    platform: "browser",
    format: "esm",
    logLevel: "silent",
    loader: { ".svg": "dataurl" },
    plugins: [{
      name: "svelte-template-harness-aliases",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^sporades\/client$/ }, () => ({ path: clientStub }));
        buildApi.onResolve({ filter: /^\.\/sporades$/ }, () => ({ path: storesStub }));
      },
    }],
  });

  const state = createHarnessState(initialState);
  const window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = '<div id="app"></div>';
  const restoreGlobals = installWindowGlobals(window);
  globalThis.__SPORADES_SVELTE_TEMPLATE_HARNESS__ = state;
  await import(`${pathToFileURL(bundlePath).href}?app=${Date.now()}-${Math.random()}`);
  await settle();

  return {
    window,
    document: window.document,
    state,
    text: () => window.document.body.textContent ?? "",
    find: (selector) => window.document.querySelector(selector),
    findAll: (selector) => [...window.document.querySelectorAll(selector)],
    setSession(value) { state.stores.session.set(value); },
    setQuery(name, value) { state.stores.queries[name].set(value); },
    setMutation(name, value) { state.stores.mutations[name].set(value); },
    async setValue(node, value, event = "input") {
      node.value = value;
      node.dispatchEvent(new window.Event(event, { bubbles: true }));
      await settle();
    },
    async trigger(node, event, values = {}) {
      for (const [key, value] of Object.entries(values)) Object.defineProperty(node, key, { configurable: true, writable: true, value });
      node.dispatchEvent(new window.Event(event, { bubbles: true, cancelable: true }));
      await settle();
    },
    settle,
    async unmount() {
      await globalThis.__SPORADES_SVELTE_TEMPLATE_UNMOUNT__?.();
      await settle();
      delete globalThis.__SPORADES_SVELTE_TEMPLATE_UNMOUNT__;
      delete globalThis.__SPORADES_SVELTE_TEMPLATE_HARNESS__;
      restoreGlobals();
      await window.happyDOM.close();
    },
  };
}

function createHarnessState(initial) {
  const counts = { session: storeCount(), queries: {}, mutations: {} };
  const stores = {
    session: writable(initial.session, counts.session),
    queries: Object.fromEntries(Object.entries(initial.queries ?? {}).map(([name, value]) => {
      counts.queries[name] = storeCount();
      return [name, writable(value, counts.queries[name])];
    })),
    mutations: Object.fromEntries(Object.entries(initial.mutations ?? {}).map(([name, value]) => {
      counts.mutations[name] = storeCount();
      return [name, writable(value, counts.mutations[name])];
    })),
  };
  return { ...initial, stores, counts };
}

function writable(initial, counts) {
  let value = initial;
  const subscribers = new Set();
  return {
    subscribe(callback) {
      counts.started += 1;
      counts.active += 1;
      subscribers.add(callback);
      callback(value);
      return () => {
        if (!subscribers.delete(callback)) return;
        counts.active -= 1;
        counts.stopped += 1;
      };
    },
    set(next) {
      value = next;
      for (const subscriber of subscribers) subscriber(value);
    },
    get() { return value; },
    update(update) { this.set(update(value)); },
  };
}

function storeCount() { return { started: 0, active: 0, stopped: 0 }; }

function installWindowGlobals(window) {
  const names = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLFormElement", "HTMLMediaElement", "SVGElement", "Event", "CustomEvent", "Text", "Comment", "Document", "DocumentFragment", "ShadowRoot", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? window : window[name];
    if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"].includes(name) ? value.bind(window) : value });
  }
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
