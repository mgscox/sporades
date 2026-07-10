# 01 — Normalize public client assets for existing React Capsules

**What to build:** Existing React Capsules continue to build and run through esbuild without author-facing changes, while the Bundle pipeline, Dev session, Container session, Hosted Capsule release path, static serving, inspection, and verification consume a normalized public asset tree rather than assuming one specially handled client file. Revisit ADR 0010 while preserving explicit user ownership of the HTML shell and compatibility with the existing `/client.js` entry.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] An existing React Capsule builds the same server Bundle and a normalized public asset tree containing its user-owned HTML shell and client entry.
- [ ] Dev, Container, and Hosted execution serve the normalized public files with correct content types, nested paths, and path-traversal protection.
- [ ] Container mounts, Host release packaging, release validation, inspection, and doctor checks accept the normalized public asset contract without weakening read-only release guarantees.
- [ ] ADR 0010 is revised or superseded to define HTML ownership and build-time transformation while retaining compatibility with `/client.js` for existing Capsules.
- [ ] Existing React/esbuild behavior and generated Bundle parity remain covered by focused and broad regression tests.
