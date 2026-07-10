# 09 — Add Inferno Capsules across esbuild and Vite

**What to build:** Capsule authors can scaffold Inferno clients using Inferno's own JSX transformation and native lifecycle semantics, with both esbuild and Vite producing equivalent Sporades release behavior.

**Blocked by:** 02 — Add a framework-neutral Vanilla TypeScript client; 03 — Add the Vite client toolchain through React.

**Status:** ready-for-agent

- [ ] `sporades create` accepts Inferno, supports validated esbuild and Vite combinations, and emits idiomatic Inferno scaffolds for every supported template.
- [ ] Both toolchains use an Inferno-specific JSX transformation and do not depend on React runtime behavior.
- [ ] The Inferno adapter exposes query, mutation, and auth state with correct component lifecycle subscription cleanup.
- [ ] Inferno Capsules run through Dev, Container, and Hosted execution with equivalent output contracts and structured rebuild behavior across both toolchains.
- [ ] Documentation distinguishes Inferno compatibility from React and records the supported refresh behavior without promising unverified state-preserving HMR.
