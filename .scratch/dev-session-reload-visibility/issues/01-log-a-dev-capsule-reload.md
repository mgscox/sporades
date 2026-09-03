# Log a Dev session Capsule reload

Status: complete

## Parent

.scratch/dev-session-reload-visibility/PRD.md

## What to build

Emit a structured `dev.capsule.reloaded` log entry each time a Dev session
reloads the Capsule in place after a server change, and document the event in
the local operations guide as the way to confirm a reload happened.

The entry is emitted from `startDevSession` in `src/cli/sporades.ts`, on the
branch that already distinguishes a Capsule reload from a client-only rebuild,
through the runtime logger so `sporades logs` reads it back like any other
platform event. Its payload lists the tables, mutations, and Jobs the reloaded
Capsule now serves, by name and sorted, so a developer can look for the one
they just added.

## Acceptance criteria

- [ ] A Dev session reload emits one log entry with event `dev.capsule.reloaded`, category `platform`, and level `info`.
- [ ] The entry's data carries sorted `tables`, `mutations`, and `jobs` name arrays taken from the reloaded Capsule.
- [ ] `sporades logs --json` returns the entry, attributed to the running Capsule.
- [ ] A client-only rebuild emits no `dev.capsule.reloaded` entry.
- [ ] The entry contains no Capsule row data, no environment values, and nothing requiring redaction before a log is shared.
- [ ] `docs/guide/local-operations.md` explains that a reload leaves pid and uptime unchanged and points at `sporades logs` and this event.
- [ ] Tests cover a server change producing the entry with the newly added table named in it, and a client-only change producing none.
- [ ] Generated `bin/` and `dist/` artifacts are rebuilt with the source change.

## Blocked by

None - can start immediately
