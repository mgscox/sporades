# 14 — Admit Lit with reactive controllers

**What to build:** Capsule authors can scaffold a runnable Lit/Vite Capsule and consume Sporades query, mutation, and auth state through Lit reactive controllers tied to the host element lifecycle.

**Blocked by:** 05 — Add the framework-neutral Vanilla client SDK; 06 — Admit React through Vite.

**Status:** ready-for-agent

- [ ] Configuration and scaffolding accept Lit/Vite, install admitted dependencies, and reject Lit/esbuild with structured capability guidance.
- [ ] The blank and todo scaffolds use idiomatic Lit Web Components, supported decorators or standard class fields, component styles, and author-owned source HTML.
- [ ] Reactive controllers expose complete query, mutation, and auth state, request host updates, and connect or disconnect shared transport subscriptions with the host lifecycle.
- [ ] Lit uses the framework-neutral client connection and existing preferences, Files, App-message, and Journey behavior without a framework-specific transport.
- [ ] Build failures produce bounded structured diagnostics, preserve last-good output, recover after correction, and refresh through Sporades.
- [ ] Lit blank and todo Capsules build and run through Dev, Container, and Hosted release seams with controller lifecycle and Server-env-isolation coverage.
