# 06 — Add Svelte Capsules with native stores

**What to build:** Capsule authors can scaffold Svelte clients that build through Vite and consume Sporades state through Svelte-native stores or the current equivalent reactive primitives, with lifecycle cleanup owned by the adapter.

**Blocked by:** 02 — Add a framework-neutral Vanilla TypeScript client; 03 — Add the Vite client toolchain through React.

**Status:** ready-for-agent

- [ ] `sporades create` accepts Svelte, selects Vite, installs the supported compiler dependencies, and emits idiomatic Svelte scaffolds for every supported template.
- [ ] Svelte components, component styles, CSS, and imported assets compile into the normalized public asset tree.
- [ ] The Svelte adapter exposes reactive query, mutation, and auth state with deterministic subscription start and cleanup behavior.
- [ ] Svelte Capsules run through Dev, Container, and Hosted execution with structured compiler diagnostics and rebuild recovery.
- [ ] Type declarations, user guidance, CSP expectations, and framework/toolchain validation describe the supported Svelte contract.
