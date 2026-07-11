# 18 — Contract and verify the capability matrix

**What to build:** Sporades publishes one coherent, tested framework/toolchain capability matrix whose scaffolds, runtime behavior, releases, types, generated output, documentation, and operator diagnostics tell the same truth.

**Blocked by:** 07 — Admit Preact through Vite; 09 — Complete Vue template parity; 11 — Complete Svelte template parity; 13 — Complete SolidJS template parity; 15 — Complete Lit template parity; 17 — Add Inferno/Vite and complete template parity.

**Status:** ready-for-agent

- [ ] A table-driven conformance suite scaffolds and builds every admitted framework/toolchain pair, loads its built HTML entry, exercises framework-neutral client behavior, and proves Server env isolation.
- [ ] Every pair crosses Dev startup, failed-edit recovery, structured JSONL events, Sporades refresh, nested asset serving, content types, and traversal protection through shared fixtures.
- [ ] Every pair crosses the shared Container and Hosted packaging/helper-validation contract, with at least one esbuild and one Vite Capsule exercised in real Container and Hosted runtime smoke coverage.
- [ ] Unsupported combinations, Angular, and server-owning meta-frameworks fail or remain documented out of scope without partial support paths.
- [ ] Public declarations, generated client runtimes, client subpath exports, package contents, API documentation, user guidance, scaffold README files, and agent instructions agree with the matrix.
- [ ] Doctor and inspection expose the effective framework, toolchain, HTML entry, and bounded public-asset summary without assuming `/client.js`.
- [ ] ADR and documentation tests identify ADR 0032 as active, retain ADR 0010 as superseded history, and move the roadmap item from `ready` to Recently Implemented only after all acceptance evidence passes.
- [ ] Focused and broad build, type, test, generated-output, package, Container, Host, security, and documentation suites pass with no skipped matrix cell.
