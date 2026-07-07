# Define doctor command and check envelope

Status: done

## Parent

.scratch/sporades-doctor/PRD.md

## What to build

Define and implement the first `sporades doctor` command surface with a stable
read-only diagnostic envelope. The slice should establish command parsing,
human output, JSON output, severity/status vocabulary, exit-code behavior, and
the internal check runner contract used by later slices.

## Acceptance criteria

- [ ] `sporades doctor --help` documents `--session`, `--host`, `--subname`, `--strict`, and `--json`.
- [ ] `sporades doctor --json` returns a stable top-level JSON envelope with check results.
- [ ] Each check has stable `id`, `title`, `scope`, `status`, `severity`, `message`, optional `hint`, optional `commands`, and optional non-secret `details`.
- [ ] Human output groups checks by severity and stays concise.
- [ ] Normal mode exits non-zero only when at least one check fails.
- [ ] `--strict` exits non-zero when any check warns or fails.
- [ ] Unknown sessions or incompatible option combinations fail with structured errors and hints.
- [ ] The command is read-only and does not start, stop, push, reset, repair, import, export, rotate, or delete state.
- [ ] Tests cover command parsing, JSON envelope shape, human output basics, and exit-code behavior.

## Blocked by

None - can start immediately
