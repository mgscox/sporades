# Sporades

- Read @CONTEXT.md to obtain an overview of this repository
- Read @docs/PRD.md to learn about the Product Requirements

## Code Review Rules

### Public and generated contracts

- Flag a public runtime, browser or trusted API, type, generated bundle or CLI, or documentation change that is not updated in the corresponding shipped surfaces. Safe path: update source, generated artifacts, canonical docs, and focused parity tests together.

### Authorization and sensitive capability boundaries

- Flag any change that widens browser, ACL, File, or Privileged authority without explicit authorization at the current actor and resource boundary. Safe path: use the narrowest context, preserve opaque errors and redaction, and cover deny and revocation paths.

### Persistent runtime invariants

- Flag a write path that can violate transaction, rollback, restart, adapter, or concurrency invariants. Safe path: make the invariant runtime-owned and prove it with focused tests.

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/`; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The repo uses the default mattpocock/skills triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Host provisioning

Cloud Host server creation and Sporades installation use the common contract in `docs/agents/host-provisioning.md`.
