# 01 — Expand the Bundle pipeline with a normalized public tree

**What to build:** Existing React/esbuild Capsules build and run in a Dev session through the ADR 0032 normalized public-tree contract while legacy Container and Hosted release consumers remain compatible during the migration.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Existing React/esbuild Capsules produce the unchanged Server Bundle plus a validated public tree containing built HTML and `/client.js`.
- [ ] The project HTML remains author-owned source, while the built HTML receives only the existing bounded connection bootstrap when served.
- [ ] Dev sessions serve nested public assets with correct content types, return 404 for missing files, and reject decoded traversal, symlinks, normalization collisions, and unsafe paths.
- [ ] Client builds use a fresh temporary tree and atomically replace the last successful tree only after validation; a failed edit leaves the last successful Dev output available.
- [ ] Structured Dev events distinguish client build success and failure and recover after a corrected edit without restarting the command.
- [ ] Existing React scaffold, `/client.js`, Journey capture, WebSocket, security-policy, and generated Bundle behavior remain green.
