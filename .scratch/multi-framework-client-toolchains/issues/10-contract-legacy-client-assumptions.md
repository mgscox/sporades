# 10 — Contract legacy single-file client assumptions

**What to build:** Sporades completes the move to the normalized public asset contract by removing remaining infrastructure assumptions that every client release is exactly `/client.js`, while continuing to serve that URL whenever a toolchain emits it. Documentation, diagnostics, release validation, security checks, and compatibility reporting describe one coherent final framework/toolchain contract.

**Blocked by:** 04 — Run Preact Capsules through Vite; 05 — Add Vue Capsules with native composables; 06 — Add Svelte Capsules with native stores; 07 — Add SolidJS Capsules with native signals; 08 — Add Lit Capsules with reactive controllers; 09 — Add Inferno Capsules across esbuild and Vite.

**Status:** ready-for-agent

- [ ] No Dev, Container, Hosted, packaging, inspection, doctor, or security path requires a client release to contain exactly one fixed client file.
- [ ] Existing `/client.js` Capsules remain compatible, while nested hashed JavaScript, CSS, and asset paths are served and packaged safely.
- [ ] The documented capability matrix lists every supported framework/toolchain combination and produces structured errors for unsupported combinations.
- [ ] Angular and server-owning meta-frameworks are explicitly outside the supported client-framework contract.
- [ ] Broad tests exercise every supported combination across scaffolding, build, Dev, Container, and Hosted release boundaries, and the roadmap is updated to reflect implementation status.
