# 04 — Contract fixed client-file infrastructure

**What to build:** Sporades completes the infrastructure migration so every Dev, Container, and Hosted path consumes one normalized public tree, while existing Capsules continue to expose `/client.js` because their esbuild adapter emits it.

**Blocked by:** 02 — Migrate Container sessions to the public tree; 03 — Migrate Hosted Capsule releases to the public tree.

**Status:** ready-for-agent

- [ ] No serving, mounting, packaging, Host helper, verification, inspection, doctor, security, or cleanup path requires individually handled `index.html` and `client.js` release files.
- [ ] Existing React and Preact/esbuild Capsules retain their source HTML contract and `/client.js` behavior through the public tree without compatibility flags.
- [ ] Public-tree limits and safe-path rules are shared across build, Dev serving, Container deployment, Host packaging, and Host installation rather than reimplemented inconsistently.
- [ ] ADR 0010 is marked superseded and ADR 0032 is tested as the active author-owned source HTML and built public-tree contract.
- [ ] Focused tests prove nested asset parity across Dev, Container, and Hosted release boundaries, including traversal and release-integrity failures.
- [ ] Broad build, deploy, Host, doctor, security, documentation, and generated-output suites remain green after legacy infrastructure branches are removed.
