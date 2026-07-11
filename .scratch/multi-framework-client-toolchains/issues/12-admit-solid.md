# 12 — Admit SolidJS with native signals

**What to build:** Capsule authors can scaffold a runnable SolidJS/Vite Capsule and consume Sporades query, mutation, and auth state through native signals or resources with Solid-owned cleanup.

**Blocked by:** 05 — Add the framework-neutral Vanilla client SDK; 06 — Admit React through Vite.

**Status:** ready-for-agent

- [ ] Configuration and scaffolding accept SolidJS, select Vite, install the admitted compiler dependencies, and reject unsupported combinations structurally.
- [ ] The blank and todo scaffolds use SolidJS JSX, correct TypeScript settings, imported styles, and author-owned source HTML without React runtime behavior.
- [ ] The SolidJS adapter exposes complete query, mutation, and auth state through native reactive primitives and disposes subscriptions with the owning reactive root.
- [ ] SolidJS shares the framework-neutral client connection and existing preferences, Files, App-message, and Journey behavior.
- [ ] Compiler failures produce bounded structured diagnostics, preserve last-good output, recover after correction, and refresh through Sporades.
- [ ] SolidJS blank and todo Capsules build and run through Dev, Container, and Hosted release seams with lifecycle and Server-env-isolation coverage.
