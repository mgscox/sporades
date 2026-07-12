import { createClientRuntimeSource } from "./templates/client-runtime-template.js";
const runtime = await import(`data:text/javascript,${encodeURIComponent(createClientRuntimeSource())}`);
export const auth = runtime.auth;
export const files = runtime.files;
export const preferences = runtime.preferences;
export const journey = runtime.journey;
export const mutations = runtime.mutations;
export const queries = runtime.queries;
export const createHooks = runtime.createHooks;
export const createVueComposables = runtime.createVueComposables;
export const createSolidPrimitives = runtime.createSolidPrimitives;
export const createLitControllers = runtime.createLitControllers;
export const createSvelteStores = runtime.createSvelteStores;
export const isAuthenticated = runtime.isAuthenticated;
export const onMessage = runtime.onMessage;
export const sendMessage = runtime.sendMessage;
//# sourceMappingURL=client.js.map