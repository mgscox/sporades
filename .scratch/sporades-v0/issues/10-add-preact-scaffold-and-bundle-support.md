# Add Preact scaffold and bundle support

Status: done

## What to build

Prove the framework-agnostic client shape by supporting Preact as a second v0 scaffold and bundle target. The create command should generate a Preact todo scaffold, configure esbuild with the correct JSX import source, and use the same client transport and `createHooks` factory pattern as React.

## Acceptance criteria

- [ ] `sporades create <name> --framework preact` creates a runnable Preact scaffold.
- [ ] The Preact scaffold includes the same todo capsule behavior as the React scaffold.
- [ ] `sporades.json` records `client.framework` as `preact`.
- [ ] The client bundle uses the framework-specific JSX import source from `sporades.json`.
- [ ] Preact dependencies are installed by default during scaffold install, and `--no-install` still skips installation.
- [ ] The `createHooks` factory works with Preact primitives without changing app server code.
- [ ] Unsupported frameworks fail with structured errors and hints that list the v0 supported choices.

## Blocked by

- .scratch/sporades-v0/issues/01-create-runnable-react-todo-scaffold.md
- .scratch/sporades-v0/issues/02-start-bundled-dev-session.md
- .scratch/sporades-v0/issues/04-run-todo-query-mutation-loop.md
