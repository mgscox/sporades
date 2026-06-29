# Create a runnable React todo scaffold

Status: done

## What to build

Implement the first visible `sporades create` path: a developer can run the CLI to create a new Sporades scaffold for a todo capsule using React by default. The scaffold should be immediately recognizable as a Sporades project, include project configuration and agent instructions, and honor the create command flags for template, framework, git initialization, install, and JSON output.

## Acceptance criteria

- [ ] `sporades create <name>` creates a project directory with `sporades.json`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `.gitignore`, `.env.sporades.server`, `index.html`, `package.json`, `server/`, `client/`, and `shared/`.
- [ ] The scaffold contains a todo capsule and React client entry that match the PRD's server/client API shape closely enough for later slices to run without replacing the scaffold.
- [ ] `--framework react` is supported as the default, `--template todo` is accepted for v0, and unsupported template/framework values fail with `{ ok: false, data: null, error: { message, hint } }`.
- [ ] By default, create runs dependency install and git initialization; `--no-install` and `--no-git` skip those steps.
- [ ] `--json` prints `{ ok: true, data: { path }, error: null }` on success and structured errors with actionable hints on failure.

## Blocked by

None - can start immediately
