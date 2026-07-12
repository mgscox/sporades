import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { build } from "vite";

export async function mountLitTemplate(projectDir, initial) {
  const outDir = path.join(projectDir, ".lit-template-harness");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const stub = path.join(outDir, "sporades-client.js");
  await writeFile(stub, `const state=globalThis.__SPORADES_LIT_HARNESS__;export const auth=state.auth;
export function createLitControllers(){
 const observed=(host,initial,subscribe)=>{let owned=null;const controller={state:initial,hostConnected(){if(owned)return;owned=subscribe(value=>{controller.state=value;host.requestUpdate();});},hostDisconnected(){if(!owned)return;const current=owned;owned=null;current.unsubscribe();}};host.addController(controller);return controller;};
 const queryController=(host,name)=>observed(host,{data:null,error:null,loading:true},publish=>state.queries[name].subscribe(publish));
 const mutationController=(host,name)=>{let pending=0,latest=0;const controller={state:{data:null,error:null,loading:false},async run(...args){const invocation=++latest;pending++;controller.state={data:null,error:null,loading:true};host.requestUpdate();try{const result=await state.mutations[name].run(...args);if(invocation===latest){controller.state={data:result.error?null:result.data??null,error:result.error??null,loading:pending>1};host.requestUpdate();}return result;}finally{pending--;controller.state={...controller.state,loading:pending>0};host.requestUpdate();}}};host.addController(controller);return controller;};
 const authController=host=>{const controller=observed(host,{auth:null,providers:{},loading:true,error:null},publish=>state.session.subscribe(publish));controller.isAuthenticated=()=>Boolean(controller.state.auth?.isAuthenticated);return controller;};return{queryController,mutationController,authController};}
`);
  await build({ root: projectDir, configFile: false, envFile: false, publicDir: false, logLevel: "silent", build: { write: true, emptyOutDir: false, minify: false, outDir, rollupOptions: { input: path.join(projectDir, "client/index.ts"), output: { entryFileNames: "bundle.mjs" } } }, plugins: [{ name: "lit-harness", enforce: "pre", resolveId(id) { return id === "sporades/client" ? stub : null; } }] });
  const state = { ...initial };
  const window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = "<sporades-app></sporades-app>";
  const restore = installGlobals(window);
  globalThis.__SPORADES_LIT_HARNESS__ = state;
  await import(`${pathToFileURL(path.join(outDir, "bundle.mjs")).href}?${Date.now()}-${Math.random()}`);
  const element = window.document.querySelector("sporades-app");
  await element.updateComplete;
  return {
    window, element, state,
    text: () => element.shadowRoot?.textContent ?? "",
    find: (selector) => element.shadowRoot?.querySelector(selector),
    async settle() { await Promise.resolve(); await element.updateComplete; },
    async disconnect() { element.remove(); await Promise.resolve(); },
    async reconnect() { window.document.body.append(element); await element.updateComplete; },
    async unmount() { element.remove(); await Promise.resolve(); delete globalThis.__SPORADES_LIT_HARNESS__; restore(); await window.happyDOM.close(); },
  };
}

function installGlobals(window) {
  const names = ["window", "document", "navigator", "customElements", "Node", "Element", "HTMLElement", "ShadowRoot", "Document", "DocumentFragment", "Event", "CustomEvent", "CSSStyleSheet", "MutationObserver"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) if (window[name] !== undefined) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: window[name] });
  return () => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } };
}
