# 02 — Add a framework-neutral Vanilla TypeScript client

**What to build:** Capsule authors can scaffold and run a Vanilla TypeScript client that uses public framework-neutral Sporades query subscriptions, mutations, auth state, preferences, files, and App messages without React-shaped hooks. Existing React and Preact clients remain compatible through `createHooks`.

**Blocked by:** 01 — Normalize public client assets for existing React Capsules.

**Status:** ready-for-agent

- [ ] `sporades create` accepts Vanilla TypeScript and produces an immediately runnable Capsule with the correct dependencies and authoring guidance.
- [ ] The public client interface exposes bounded subscription and command primitives with explicit unsubscribe and lifecycle behavior.
- [ ] The Vanilla client demonstrates reactive query state, mutation execution, auth state, preferences, files, and App-message usage without importing a UI framework.
- [ ] Existing React/Preact `createHooks` behavior is implemented over or remains coherent with the same transport seam without a breaking change.
- [ ] Vanilla Capsules build and run through Dev, Container, and Hosted execution with structured build failures and no Server env leakage.
