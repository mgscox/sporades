import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { compileScript, parse } from "@vue/compiler-sfc";

export async function mountVueTemplate(projectDir, state) {
  const originalDocument = globalThis.Document;
  const originalShadowRoot = globalThis.ShadowRoot;
  globalThis.Document ??= class Document {};
  globalThis.ShadowRoot ??= class ShadowRoot {};
  const harnessDir = path.join(projectDir, ".vue-template-harness");
  await mkdir(harnessDir, { recursive: true });
  const sourcePath = path.join(projectDir, "client", "App.vue");
  const source = await readFile(sourcePath, "utf8");
  const parsed = parse(source, { filename: sourcePath });
  if (parsed.errors.length > 0) throw parsed.errors[0];
  const compiled = compileScript(parsed.descriptor, { id: "vue-template-behavior", inlineTemplate: true });
  const compiledPath = path.join(projectDir, "client", "App.harness.ts");
  const runtimePath = path.join(projectDir, "node_modules", "vue", "dist", "vue.runtime.esm-bundler.js");
  const clientStub = path.join(harnessDir, "sporades-client.ts");
  const composableStub = path.join(harnessDir, "sporades-composables.ts");
  const appPath = path.join(harnessDir, "App.mjs");
  await Promise.all([
    writeFile(compiledPath, compiled.content),
    writeFile(clientStub, `const state = globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__;
export const auth = state.auth;
export const files = state.files;
export const journey = state.journey;
export const preferences = state.preferences;
`),
    writeFile(composableStub, `const state = globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__;
export const useAuth = () => state.session;
export const useQuery = (name) => state.queries[name];
export const useMutation = (name) => state.mutations[name];
`),
  ]);
  const buildOptions = {
    absWorkingDir: projectDir,
    bundle: true,
    platform: "node",
    format: "esm",
    mainFields: ["module", "main"],
    sourcemap: false,
    logLevel: "silent",
    loader: { ".svg": "dataurl" },
    define: {
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
  };
  await build({
    ...buildOptions,
    entryPoints: [compiledPath],
    outfile: appPath,
    plugins: [{
      name: "vue-template-harness-aliases",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^vue$/ }, () => ({ path: runtimePath, external: true }));
        buildApi.onResolve({ filter: /^sporades\/client$/ }, () => ({ path: clientStub }));
        buildApi.onResolve({ filter: /^\.\/sporades$/ }, () => ({ path: composableStub }));
      },
    }],
  });
  const vue = await import(pathToFileURL(runtimePath).href);
  const reactiveState = {
    ...state,
    session: vue.reactive(state.session),
    queries: Object.fromEntries(Object.entries(state.queries ?? {}).map(([name, value]) => [name, vue.reactive(value)])),
    mutations: Object.fromEntries(Object.entries(state.mutations ?? {}).map(([name, value]) => [name, vue.reactive(value)])),
  };
  globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__ = reactiveState;
  const component = (await import(`${pathToFileURL(appPath).href}?app=${Date.now()}`)).default;
  const root = hostNode("root");
  const renderer = vue.createRenderer({
    patchProp(node, key, _previous, value) { node.props[key] = value; if (key === "value") node.value = value; },
    insert(child, parent, anchor) {
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child);
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); },
    createElement(type) { return hostNode(type); },
    createText(text) { return { ...hostNode("#text"), text }; },
    createComment(text) { return { ...hostNode("#comment"), text }; },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; node.children = []; },
    parentNode(node) { return node.parent; },
    nextSibling(node) { const index = node.parent?.children.indexOf(node) ?? -1; return node.parent?.children[index + 1] ?? null; },
    setScopeId(node, id) { node.props[id] = ""; },
    insertStaticContent(content, parent, anchor) {
      const node = { ...hostNode("#static"), text: content, parent };
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
      return [node, node];
    },
  });
  const app = renderer.createApp(component);
  app.mount(root);
  await settle(vue);

  return {
    root,
    state: reactiveState,
    text: () => nodeText(root),
    find: (predicate) => walk(root).find(predicate),
    findAll: (predicate) => walk(root).filter(predicate),
    findText: (text) => walk(root).find((node) => nodeText(node).includes(text)),
    async setValue(node, value, event = "input") {
      node.value = value;
      await invoke(node.props["onUpdate:modelValue"], value);
      await invoke(node.props[`on${capitalize(event)}`], hostEvent(node));
      await settle(vue);
    },
    async trigger(node, event, values = {}) {
      Object.assign(node, values);
      const emitted = hostEvent(node);
      await invoke(node.props[`on${capitalize(event)}`], emitted);
      await invoke(node.listeners[event], emitted);
      await settle(vue);
    },
    settle: () => settle(vue),
    unmount() {
      app.unmount();
      delete globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__;
      if (originalDocument === undefined) delete globalThis.Document; else globalThis.Document = originalDocument;
      if (originalShadowRoot === undefined) delete globalThis.ShadowRoot; else globalThis.ShadowRoot = originalShadowRoot;
    },
  };
}

function hostNode(type) {
  const node = { type, props: {}, children: [], parent: null, text: "", value: "", files: null, checked: false, listeners: {} };
  node.addEventListener = (name, listener) => { node.listeners[name] = [...(node.listeners[name] ?? []), listener]; };
  node.removeEventListener = (name, listener) => { node.listeners[name] = (node.listeners[name] ?? []).filter((candidate) => candidate !== listener); };
  node.getRootNode = () => ({ activeElement: null });
  return node;
}
function walk(node) { return [node, ...node.children.flatMap(walk)]; }
function nodeText(node) { return `${node.text ?? ""}${node.children.map(nodeText).join("")}`; }
function capitalize(value) { return value[0].toUpperCase() + value.slice(1); }
function hostEvent(node) { return { currentTarget: node, target: node, preventDefault() {}, stopPropagation() {} }; }
async function invoke(handler, event) {
  if (!handler) return;
  for (const callback of Array.isArray(handler) ? handler : [handler]) await callback(event);
}
async function settle(vue) {
  for (let index = 0; index < 5; index += 1) { await Promise.resolve(); await vue.nextTick(); }
}
