// @ts-nocheck
import { createClientRuntimeSource } from "./templates/client-runtime-template.js";
const runtime = await import(`data:text/javascript,${encodeURIComponent(createClientRuntimeSource())}`);
export const auth = runtime.auth;
export const files = runtime.files;
export const createHooks = runtime.createHooks;
export const isAuthenticated = runtime.isAuthenticated;
export const onMessage = runtime.onMessage;
export const sendMessage = runtime.sendMessage;
//# sourceMappingURL=client.js.map