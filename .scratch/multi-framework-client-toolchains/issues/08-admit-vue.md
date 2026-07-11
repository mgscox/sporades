# 08 — Admit Vue with native composables

**What to build:** Capsule authors can scaffold a runnable Vue/Vite Capsule and consume Sporades query, mutation, and auth state through Vue-native composables over the shared client connection.

**Blocked by:** 05 — Add the framework-neutral Vanilla client SDK; 06 — Admit React through Vite.

**Status:** ready-for-agent

- [ ] Configuration and scaffolding accept Vue, select Vite, install the admitted Vue compiler dependencies, and reject unsupported Vue/toolchain combinations structurally.
- [ ] The blank and todo scaffolds use idiomatic Vue Single-File Components, scoped or imported styles, and author-owned source HTML.
- [ ] Vue composables expose query, mutation, and auth state with complete initial state, reactive updates, standard errors, and cleanup through Vue's disposal boundary.
- [ ] Vue uses the shared framework-neutral client connection and existing preferences, Files, App-message, and Journey APIs without framework-specific transport behavior.
- [ ] Vue compiler failures produce bounded structured diagnostics, preserve the last successful public tree, recover after correction, and refresh through Sporades.
- [ ] Vue blank and todo Capsules build and run through Dev, Container, and Hosted release seams with native adapter lifecycle and no Server env leakage.
