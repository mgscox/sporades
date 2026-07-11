# 16 — Admit Inferno through esbuild

**What to build:** Capsule authors can scaffold a runnable Inferno/esbuild Capsule using Inferno's JSX runtime and native component lifecycle rather than depending on React compatibility behavior.

**Blocked by:** 05 — Add the framework-neutral Vanilla client SDK.

**Status:** ready-for-agent

- [ ] Configuration and scaffolding accept Inferno/esbuild, resolve esbuild by default, install Inferno dependencies, and emit accurate project guidance.
- [ ] The blank and todo scaffolds use Inferno's JSX transform, renderer, event behavior, and author-owned HTML without React or React DOM in client output.
- [ ] The Inferno adapter exposes complete query, mutation, and auth state and releases shared transport subscriptions through Inferno component lifecycle boundaries.
- [ ] Inferno uses the framework-neutral connection and existing preferences, Files, App-message, and Journey surfaces directly.
- [ ] Build failures remain structured, last-good Dev output survives correction cycles, and existing esbuild refresh behavior remains explicit.
- [ ] Inferno/esbuild blank and todo Capsules build and run through Dev, Container, and Hosted release seams with lifecycle and Server-env-isolation coverage.
