import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { build } from "esbuild";
import { Window } from "happy-dom";

export async function mountInfernoTemplate(projectDir, initial) {
  const harnessDir = path.join(projectDir, ".inferno-template-harness");
  await rm(harnessDir, { recursive: true, force: true });
  await mkdir(harnessDir, { recursive: true });
  const clientStub = path.join(harnessDir, "sporades-client.js");
  const entry = path.join(harnessDir, "entry.ts");
  const bundle = path.join(harnessDir, "bundle.mjs");
  await Promise.all([
    writeFile(clientStub, `const state=globalThis.__SPORADES_INFERNO_HARNESS__;export const auth=state.auth;export const files=state.files;export const journey=state.journey;export const preferences=state.preferences;export const onMessage=state.onMessage;export const sendMessage=state.sendMessage;
export function createInfernoAdapters(){
 const observed=(host,initial,subscribe)=>{let owned=null;const adapter={state:initial,componentDidMount(){if(owned)return;owned=subscribe(value=>{adapter.state=value;try{host.forceUpdate();}catch{}});},componentWillUnmount(){if(!owned)return;const current=owned;owned=null;current.unsubscribe();}};return adapter;};
 const queryAdapter=(host,name)=>observed(host,{data:null,error:null,loading:true},publish=>state.queries[name].subscribe(publish));
 const authAdapter=host=>{const adapter=observed(host,{auth:null,providers:{},loading:true,error:null},publish=>state.session.subscribe(publish));adapter.isAuthenticated=()=>Boolean(adapter.state.auth?.isAuthenticated);return adapter;};
 const mutationAdapter=(host,name)=>{let pending=0,latest=0;const adapter={state:{data:null,error:null,loading:false},async run(...args){const invocation=++latest;pending++;adapter.state={data:null,error:null,loading:true};try{host.forceUpdate();}catch{}try{const result=await state.mutations[name].run(...args);if(invocation===latest)adapter.state={data:result.error?null:result.data??null,error:result.error??null,loading:pending>1};return result;}catch(error){const normalized={message:error instanceof Error?error.message:String(error)};if(invocation===latest)adapter.state={data:null,error:normalized,loading:pending>1};return{data:null,error:normalized};}finally{pending--;adapter.state={...adapter.state,loading:pending>0};try{host.forceUpdate();}catch{}}}};return adapter;};
 return{queryAdapter,mutationAdapter,authAdapter};}
`),
    writeFile(entry, `import { render } from "inferno";import { mountInfernoApp } from "../client/index";const root=document.querySelector("#app");globalThis.__SPORADES_INFERNO_UNMOUNT__=()=>render(null,root);globalThis.__SPORADES_INFERNO_REMOUNT__=()=>mountInfernoApp(root);`),
  ]);
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", platform: "browser", jsx: "transform", jsxFactory: "createElement", loader: { ".svg": "dataurl", ".css": "css" }, plugins: [{ name: "inferno-harness", setup(buildApi) { buildApi.onResolve({ filter: /^sporades\/client$/ }, () => ({ path: clientStub })); } }] });

  const window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = '<div id="app"></div>';
  const restore = installGlobals(window);
  globalThis.__SPORADES_INFERNO_HARNESS__ = initial;
  await import(`${pathToFileURL(bundle).href}?${Date.now()}-${Math.random()}`);
  await settle();
  return {
    window,
    text: () => window.document.body.textContent ?? "",
    find: (selector) => window.document.querySelector(selector),
    settle,
    async disconnect() { globalThis.__SPORADES_INFERNO_UNMOUNT__?.(); await settle(); },
    async reconnect() { globalThis.__SPORADES_INFERNO_REMOUNT__?.(); await settle(); },
    async unmount() { globalThis.__SPORADES_INFERNO_UNMOUNT__?.(); await settle(); delete globalThis.__SPORADES_INFERNO_UNMOUNT__; delete globalThis.__SPORADES_INFERNO_REMOUNT__; delete globalThis.__SPORADES_INFERNO_HARNESS__; restore(); await window.happyDOM.close(); },
  };
}

function installGlobals(window) {
  const names = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "SVGElement", "File", "Blob", "Event", "CustomEvent", "Text", "Comment", "Document", "DocumentFragment", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) { const value = name === "window" ? window : window[name]; if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"].includes(name) ? value.bind(window) : value }); }
  return () => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } };
}

async function settle() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }
