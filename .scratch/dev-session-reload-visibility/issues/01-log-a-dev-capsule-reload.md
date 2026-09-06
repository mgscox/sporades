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

- [x] A Dev session reload emits one log entry with event `dev.capsule.reloaded`, category `platform`, and level `info`.
- [x] The entry's data carries sorted `tables`, `mutations`, and `jobs` name arrays taken from the reloaded Capsule.
- [x] `sporades logs --json` returns the entry, attributed to the running Capsule.
- [x] A client-only rebuild emits no `dev.capsule.reloaded` entry.
- [x] The entry contains no Capsule row data, no environment values, and nothing requiring redaction before a log is shared.
- [x] `docs/guide/local-operations.md` explains that a reload leaves pid and uptime unchanged and points at `sporades logs` and this event.
- [x] Tests cover a server change producing the entry with the newly added table named in it, and a client-only change producing none.
- [x] Generated `bin/` and `dist/` artifacts are rebuilt with the source change.

## Blocked by

None - can start immediately

## Completion evidence

Implemented and merged in mgscox/sporades#29 (merge commit `4da7d9ac`).

- Event emitted from `startDevSession` in `src/cli/sporades.ts`, on the branch that
  distinguishes a Capsule reload from a client-only rebuild.
- Payload built by `capsuleReloadSurface`, which bounds itself against the
  Capsule's configured `logs.payloadMaxBytes` and reports per-kind `omitted`
  counts, so the three arrays stay arrays when a large Capsule would otherwise
  overrun the log envelope.
- Emit is awaited inside a best-effort `try`: awaited because `emit` resolves
  only once the Log-index write lands on the Postgres and libSQL services, and
  guarded because a throw would otherwise reach the rebuild catch and roll a
  committed reload back.
- Guide section added to `docs/guide/local-operations.md`.

Tests in `test/dev.test.js`, all passing at merge (247/247 for the file):

- `sporades dev logs a capsule reload that a server change triggered`
- `sporades dev does not log a capsule reload for a client-only change`
- `a capsule reload surface stays structured when it exceeds the log payload cap`

The third was verified to fail without its fix, with `tables is "[TRUNCATED]"`.

One acceptance criterion carries a caveat worth recording: the payload is free of
data needing redaction by construction, since it carries only declaration names.
That is an argument from the code, not from a test asserting redaction.

Known limitation, tracked separately as `.scratch/log-payload-cap-floor/`: a
`logs.payloadMaxBytes` small enough to defeat the envelope itself still strips
`data` from every event, this one included. That is a configuration-contract
defect rather than a defect in this ticket's work.
