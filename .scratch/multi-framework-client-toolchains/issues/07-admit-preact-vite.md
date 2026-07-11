# 07 — Admit Preact through Vite

**What to build:** Preact Capsule authors can select Vite without pulling React into their Capsule and retain equivalent Sporades SDK, rebuild, and release behavior across the supported Preact toolchains.

**Blocked by:** 06 — Admit React through Vite.

**Status:** ready-for-agent

- [ ] Configuration and scaffolding accept Preact/esbuild and Preact/Vite while missing toolchain configuration preserves the esbuild default.
- [ ] Preact/Vite uses Preact's JSX transform, runtime, dependencies, and refresh-neutral output without importing React or React DOM.
- [ ] Existing Preact scaffolds and public `createHooks` behavior remain source-compatible across both toolchains.
- [ ] Preact/Vite reports structured build failures, preserves last-good output, recovers after a corrected edit, and uses Sporades full-page refresh rather than promising HMR.
- [ ] Preact/Vite builds and runs through Dev, Container, and Hosted release seams with normalized public-tree and Server-env-isolation checks.
- [ ] User and agent documentation explains the default, explicit Vite selection, migration requirement, and supported refresh behavior.
