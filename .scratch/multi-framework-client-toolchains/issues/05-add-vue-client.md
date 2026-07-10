# 05 — Add Vue Capsules with native composables

**What to build:** Capsule authors can scaffold Vue Single-File Component clients that build through Vite and consume Sporades query, mutation, and auth state through Vue-native composables over the framework-neutral transport seam.

**Blocked by:** 02 — Add a framework-neutral Vanilla TypeScript client; 03 — Add the Vite client toolchain through React.

**Status:** ready-for-agent

- [ ] `sporades create` accepts Vue, selects Vite, installs the supported compiler dependencies, and emits idiomatic Vue scaffolds for every supported template.
- [ ] Vue Single-File Components, scoped styles, CSS, and imported assets compile into the normalized public asset tree.
- [ ] Vue-native composables expose reactive query, mutation, and auth state with correct mount, update, and unmount cleanup behavior.
- [ ] Vue Capsules run through Dev, Container, and Hosted execution with structured compiler diagnostics and rebuild recovery.
- [ ] Type declarations, user guidance, CSP expectations, and framework/toolchain validation describe the supported Vue contract.
