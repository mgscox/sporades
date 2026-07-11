# 03 — Migrate Hosted Capsule releases to the public tree

**What to build:** Capsule authors can push, verify, and roll back Hosted Capsule releases containing bounded nested public assets without weakening Host archive validation or atomic release behavior.

**Blocked by:** 01 — Expand the Bundle pipeline with a normalized public tree.

**Status:** ready-for-agent

- [ ] Host push packages the Server Bundle, runtime configuration, and complete normalized public tree rather than enumerating fixed client files.
- [ ] Host helper validation accepts safe nested files while rejecting absolute paths, escaping paths, symlinks, duplicates, normalization collisions, unexpected top-level entries, excess files, excess bytes, and overlong paths.
- [ ] Hosted Capsule installation and startup mount the public tree read-only and serve built HTML plus representative hashed JavaScript, CSS, image, font, and source-map assets.
- [ ] Release verification checks the running Capsule through the installed public tree without assuming `/client.js` exists.
- [ ] Rollback switches one complete release so HTML cannot reference assets from a different release, including after a failed restart or verification attempt.
- [ ] Hosted release listing, inspection, cleanup, SSH, Sealed Server env, and unavailable-route behavior remain coherent and structured.
