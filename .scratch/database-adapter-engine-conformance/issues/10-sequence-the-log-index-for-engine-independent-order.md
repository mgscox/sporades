Status: ready-for-agent

# Sequence The Log Index So Its Order Is Engine-Independent

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## Decision

The Log index gains an internal, runtime-assigned, strictly monotonic ordering
field, and every engine orders by it. Both existing tie-breaks are dropped.

This was a maintainer decision rather than an implementation choice, and it has
been made. What follows is the reasoning, so nobody relitigates it from the
symptom.

The shared and libSQL definitions ordered by `timestamp DESC, rowid DESC`, which
is insertion order. Postgres ordered by `timestamp DESC, id DESC`, and `id` is a
`randomUUID()`, so on that engine the tie-break is effectively random. Log
envelope timestamps come from `new Date().toISOString()` at millisecond
precision, so ties are routine under any burst of logging rather than exotic.

Three things followed. Inspection output ordered differently per engine. Pruning
kept a different subset at the boundary, so two Capsules on different engines
retained different history. And `privilegedAuditEventAlreadyIndexed` scans the
recent-N window to decide whether a Privileged audit event is already recorded —
it is order-independent but window-dependent, so a security-adjacent dedup
behaved differently depending on the database.

Parity by making everything order on `id` was rejected: it would buy agreement by
making SQLite non-deterministic too. Leaving the tie-break unspecified was
rejected because no conformance case could then assert ordering, leaving the
suite a permanent blind spot in the one place the engines are known to disagree.

## What to build

Add an internal ordering field to `sporades_log_events`, assigned by the runtime
when an event is indexed, and order `readRecentLogEvents` and `pruneLogIndex` by
it on every engine. Remove the `rowid` and `id` tie-breaks. The field is internal
to the Log index: it does not appear in the log envelope, and the user-visible
JSONL `timestamp` is unchanged.

Three constraints decide whether this works, and all three were established
before the ticket was written.

**It must be monotonic by construction, not merely high-resolution.** The point
is to make ties impossible, not rare. A merely-probabilistic field leaves the
order undefined in the rare case and makes any conformance assertion flaky —
which would keep the blind spot while paying for a migration. `process.hrtime.bigint()`
is strictly increasing within a process, because the call itself takes tens of
nanoseconds and the runtime is single-threaded. Its origin is arbitrary per
process, so anchor it to the wall clock once at startup and derive from the
anchor thereafter: capture `Date.now()` and `process.hrtime.bigint()` together,
then compute nanoseconds since epoch as the wall anchor plus the hrtime delta.
That is monotonic within a process and correctly ordered across restarts.

**Store it as zero-padded TEXT, not an integer.** Nanoseconds since epoch is
around 1.76e18, far beyond `Number.MAX_SAFE_INTEGER`. The Postgres adapter
coerces oids 20, 21 and 23 through `Number(value)`, so a `BIGINT` column would
silently lose precision and let distinct instants collapse to the same value —
the exact defect class this whole feature exists to eliminate. Zero-padded text
sorts lexicographically and round-trips exactly on all three engines. Pad wide
enough that the width does not change within any plausible lifetime, since a
changing width breaks lexicographic order.

**The new column is camelCase, so it needs its Postgres mapping.** Postgres folds
unquoted identifiers to lowercase and a hand-maintained table restores them.
Issue 03 found that `verifierHash` was missing from that table, which broke every
password reset on Postgres. Do not repeat it: either add the entry, or land after
issue 08 closes the class. Verify the column round-trips rather than assuming.

Existing rows predate the column and need a backfill that preserves their
relative order — deriving from the stored timestamp is sufficient, since ties
among already-stored rows are historical and unrecoverable.

Removing both tie-breaks should also remove per-engine difference rather than add
it. Check whether the Postgres `pruneLogIndex` and `readRecentLogEvents`
overrides still need to exist once ordering is shared, and delete them if not.

## Acceptance criteria

- [ ] `sporades_log_events` carries an internal runtime-assigned ordering field, added by additive migration, with existing rows backfilled in a way that preserves their relative order.
- [ ] The field is strictly monotonic within a process and correctly ordered across a restart; the construction is documented where it is generated.
- [ ] The field is stored as zero-padded text of fixed width, not as an integer column.
- [ ] `readRecentLogEvents` and `pruneLogIndex` order by the new field on every engine, with the `rowid` and `id` tie-breaks removed.
- [ ] The new column round-trips correctly through the Postgres read path, demonstrated rather than assumed.
- [ ] A conformance case asserts that events sharing a timestamp are returned in the same order on every engine, and that pruning keeps the same subset. It must fail if ordering falls back to `rowid` or `id`.
- [ ] The log envelope and the JSONL stream are unchanged; the field is internal to the Log index.
- [ ] Any Postgres override made redundant by shared ordering is deleted rather than left in duplicate.
- [ ] An ADR records the decision and why unspecified ordering and `id`-everywhere were both rejected.

## Blocked by

- None — can start immediately.
