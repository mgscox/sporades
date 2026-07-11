# 02 — Migrate Container sessions to the public tree

**What to build:** Capsule authors can run the normalized public tree in a local Container session with the same URLs and behavior as Dev, while Sporades preserves read-only release hardening and structured inspection.

**Blocked by:** 01 — Expand the Bundle pipeline with a normalized public tree.

**Status:** ready-for-agent

- [ ] Container sessions mount the validated public tree through one read-only directory boundary instead of individual HTML and client-file mounts.
- [ ] A React/esbuild Capsule serves built HTML, `/client.js`, and representative nested CSS, JavaScript, image, font, and source-map paths from a real Container session.
- [ ] Local deployment replacement cannot mix assets from the previous and next public trees, and persistent Capsule data remains outside the read-only release boundary.
- [ ] Container inspection and doctor report the effective framework, toolchain, HTML entry, and bounded public-asset summary without requiring `/client.js`.
- [ ] Unsafe, missing, or over-limit public trees fail before replacing a running Container session and return structured recovery guidance.
- [ ] Existing Container lifecycle, security, SSH, service, and data-persistence tests remain green.
