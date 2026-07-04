Status: done

# Route Runtime Storage Through Adapter

## Parent

.scratch/database-adapter/PRD.md

## What to build

Move SQL-backed runtime storage onto the Database adapter boundary, including auth users/sessions/provider records, file metadata/upload/public URL records, log index rows, and the `sporades` system table.

## Acceptance criteria

- [x] Auth storage uses the Database adapter without changing anonymous, email, Google, sign-out, and session rotation behavior.
- [x] File metadata, upload records, public URL records, and bucket metadata use the Database adapter without changing file byte storage behavior.
- [x] Log index writes, reads, pruning, and JSON output use the Database adapter.
- [x] System metadata reads/writes use the Database adapter.
- [x] Tests cover auth flows, file flows, public URL flows, logs, and system metadata behavior.

## Blocked by

- .scratch/database-adapter/issues/02-route-app-tables-and-migrations-through-adapter.md
