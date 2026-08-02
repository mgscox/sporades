# 02 — Gap-fill missing wrapper config and support framework override

**What to build:** A developer points `--template` at a directory that's missing one or more wrapper files (`sporades.json`, `package.json`, `index.html`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`). Sporades generates sensible defaults for each missing file — a default `sporades.json` with anonymous auth and the resolved framework/toolchain, a `package.json` with framework-specific dependencies, an `index.html` with the correct script src for the toolchain, agent instructions, and a standard `.gitignore`. The `--framework` and `--toolchain` CLI flags override whatever the template's `sporades.json` declares; when neither flags nor template config specify a framework, Sporades defaults to React/esbuild. The resolved pair is validated against the client capability matrix.

**Blocked by:** 01 — Scaffold from a complete user-defined template directory.

**Status:** ready-for-agent

- [ ] If the template has no `sporades.json`, a default is generated with anonymous auth, the resolved framework/toolchain, standard security/deploy/dev blocks, and the project name; the `template` field is omitted.
- [ ] If the template has no `package.json`, one is generated with framework-specific dependencies (same maps as built-in scaffolds), the Sporades dev dependency, `typescript` dev dep, and `dev`/`deploy` scripts.
- [ ] If the template has no `index.html`, a default is generated with the correct script src for the resolved toolchain (`/client.js` for esbuild, `/client/<entry>` for Vite).
- [ ] If the template has no `AGENTS.md` or `CLAUDE.md`, defaults are generated via the existing agent-instruction helper with the resolved framework, toolchain, and template path.
- [ ] If the template has no `.gitignore`, the standard default is generated.
- [ ] Framework/toolchain resolution priority: `--framework`/`--toolchain` CLI flags → template `sporades.json` `client.framework`/`client.toolchain` → default `react`/`esbuild`.
- [ ] The resolved framework/toolchain pair is validated against the client capability matrix; unsupported combinations produce a structured error with an actionable hint.
- [ ] `--framework` override changes both the generated `sporades.json` framework and the `package.json` framework-specific dependencies.
- [ ] Test: missing `sporades.json` — a template without it gets a default generated with `react`/`esbuild` and the project name.
- [ ] Test: missing `package.json` — a template without it gets a generated `package.json` with framework deps and the Sporades dev dep.
- [ ] Test: `--framework` override — template `sporades.json` declares `react`; `--framework preact` is passed; the generated config uses `preact` and `package.json` has Preact dependencies.
- [ ] Test: missing `index.html` — a template without it gets a default with the correct script src for the resolved toolchain.
- [ ] Test: missing `AGENTS.md` / `CLAUDE.md` — defaults are generated.
- [ ] Test: missing `.gitignore` — the standard default is generated.
- [ ] Test: unsupported framework/toolchain combination with `--framework` produces a structured error.
