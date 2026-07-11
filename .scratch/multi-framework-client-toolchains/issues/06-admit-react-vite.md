# 06 — Admit React through Vite

**What to build:** React Capsule authors can explicitly choose Vite and receive transformed author-owned HTML, multi-file client assets, structured Dev recovery, and the same Container and Hosted release behavior as React/esbuild.

**Blocked by:** 04 — Contract fixed client-file infrastructure.

**Status:** ready-for-agent

- [ ] Configuration and scaffolding accept React/Vite while existing React Capsules with no toolchain remain on esbuild.
- [ ] Sporades selects Vite through an internal client-toolchain adapter without exposing Vite result shapes to downstream runtime or Host code.
- [ ] New React/Vite HTML references the project client source entry and builds transformed HTML, JSX, CSS, imported assets, hashed chunks, and source maps into the normalized public tree.
- [ ] Opting an existing `/client.js` source shell into Vite fails before release creation with actionable migration guidance and never rewrites the author's source silently.
- [ ] Sporades remains the only watcher and Dev server, preserves last-good output, emits bounded structured diagnostics, and performs full-page refresh without Vite HMR or another WebSocket.
- [ ] Project-local Vite configuration and environment-file loading are disabled, framework packages resolve from the Capsule project, and Server env values do not enter client output.
- [ ] A React/Vite Capsule runs through Dev, a real Container session, and the Hosted release contract with parity to the built public tree.
