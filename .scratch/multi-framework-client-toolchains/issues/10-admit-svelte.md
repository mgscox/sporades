# 10 — Admit Svelte with native stores

**What to build:** Capsule authors can scaffold a runnable Svelte/Vite Capsule and consume Sporades query, mutation, and auth state through Svelte-native stores with deterministic subscription ownership.

**Blocked by:** 05 — Add the framework-neutral Vanilla client SDK; 06 — Admit React through Vite.

**Status:** ready-for-agent

- [ ] Configuration and scaffolding accept Svelte, select Vite, install the admitted compiler dependencies, and reject unsupported combinations structurally.
- [ ] The blank and todo scaffolds use idiomatic Svelte components, component styles, and author-owned source HTML.
- [ ] Svelte stores expose complete query, mutation, and auth state, start transport observation on subscription, and release it deterministically when the final subscriber leaves.
- [ ] Svelte shares the framework-neutral client connection and uses existing preferences, Files, App-message, and Journey surfaces directly.
- [ ] Compiler failures produce bounded structured diagnostics, preserve last-good output, recover after correction, and use Sporades full-page refresh.
- [ ] Svelte blank and todo Capsules build and run through Dev, Container, and Hosted release seams with adapter cleanup and Server-env-isolation coverage.
