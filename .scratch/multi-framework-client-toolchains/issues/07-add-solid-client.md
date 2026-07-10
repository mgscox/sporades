# 07 — Add SolidJS Capsules with native signals

**What to build:** Capsule authors can scaffold SolidJS clients using the supported Vite compiler integration and consume Sporades state through native signals or resources rather than emulated React hooks.

**Blocked by:** 02 — Add a framework-neutral Vanilla TypeScript client; 03 — Add the Vite client toolchain through React.

**Status:** ready-for-agent

- [ ] `sporades create` accepts SolidJS, selects Vite, installs the supported compiler dependencies, and emits idiomatic SolidJS scaffolds for every supported template.
- [ ] SolidJS JSX, CSS, and imported assets compile with the correct transform and TypeScript settings into the normalized public asset tree.
- [ ] The SolidJS adapter exposes reactive query, mutation, and auth state through signals or resources with correct ownership and cleanup semantics.
- [ ] SolidJS Capsules run through Dev, Container, and Hosted execution with structured compiler diagnostics and rebuild recovery.
- [ ] Domain and API documentation no longer imply that React-shaped `createHooks` is the SolidJS integration.
