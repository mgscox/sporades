# 05 — Add the framework-neutral Vanilla client SDK

**What to build:** Capsule authors can scaffold and run a Vanilla TypeScript Capsule that uses public framework-neutral query subscriptions, mutations, and auth observation alongside the existing preferences, Files, App-message, and Journey APIs.

**Blocked by:** 04 — Contract fixed client-file infrastructure.

**Status:** ready-for-agent

- [ ] Project configuration and `sporades create` accept Vanilla TypeScript, resolve esbuild by default, install only required dependencies, and emit an immediately runnable scaffold with accurate agent guidance.
- [ ] The public client SDK exposes query subscription, mutation execution, current auth reads, and auth subscriptions with standard result, loading, data, provider, and error semantics.
- [ ] Query and auth subscriptions deliver the latest known complete state, resubscribe after transport reconnect, share one page connection, and return idempotent unsubscribe handles.
- [ ] The Vanilla scaffold demonstrates DOM updates from a query, mutation execution, auth state, preferences, Files, App messages, and Journey without importing a UI framework.
- [ ] Existing React and Preact `createHooks` behavior remains source-compatible and coherent with the framework-neutral primitives.
- [ ] Vanilla Capsules build and run through Dev, Container, and Hosted release seams with structured failures and no Server env leakage.
