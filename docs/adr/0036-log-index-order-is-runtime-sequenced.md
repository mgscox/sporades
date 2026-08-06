# The Log index orders by a runtime-assigned sequence

The Log index carries an internal, runtime-assigned, strictly monotonic ordering
field, and every engine orders `readRecentLogEvents` and `pruneLogIndex` by it
alone. The `rowid` and `id` tie-breaks are both gone, and the envelope
`timestamp` no longer participates in the order. The field is internal to the
Log index: it does not appear in the log envelope, and the user-visible JSONL
log stream is unchanged.

## What the order used to be

The shared and libSQL definitions ordered by `timestamp DESC, rowid DESC`, which
on those engines is the order the events were indexed in. The Postgres
definition ordered by `timestamp DESC, id DESC`, and `id` is a `randomUUID()`,
so on that engine the tie-break was effectively random. Log envelope timestamps
come from `new Date().toISOString()` at millisecond resolution, so ties are
routine under any burst of logging rather than exotic.

Three things followed. Inspection output ordered differently per engine. Pruning
kept a different subset at the boundary, so two Capsules on different engines
retained different history. And `privilegedAuditEventAlreadyIndexed` scans the
recent-N window to decide whether a Privileged audit event is already recorded —
it is order-independent but window-dependent, so a security-adjacent dedup
behaved differently depending on the database.

## Why not the two cheaper answers

**Ordering on `id` everywhere** was rejected. It would buy agreement between the
engines by making SQLite non-deterministic too, which is parity at the cost of
the one engine that had a defined answer.

**Leaving the tie-break unspecified** was rejected because no conformance case
could then assert ordering. ADR-0035 makes the shared specification the place a
behaviour code above the Database adapter depends on is decided; an order that is
deliberately undefined is a permanent hole in that specification, in exactly the
place the engines are already known to disagree.

## What the field has to be

Three properties decide whether this works, and each of them rules out an
otherwise reasonable implementation.

**Monotonic by construction, not merely high-resolution.** The point is to make
ties impossible, not rare. A probabilistic field leaves the order undefined in
the rare case and makes the conformance assertion flaky, which would keep the
blind spot while still paying for a migration. `process.hrtime.bigint()` is
strictly increasing within a process, but its origin is arbitrary per process, so
it is anchored: the wall clock and the monotonic clock are read together once at
startup, and every sequence is the wall anchor plus the monotonic delta. That is
ordered within a process and correctly placed across a restart. The last value
handed out is also carried forward and stepped past, so monotonicity is a
property of this code rather than of the host's clock resolution.

**Stored as zero-padded text of fixed width, not as an integer.** Nanoseconds
since the epoch is around 1.76e18, far beyond `Number.MAX_SAFE_INTEGER`. The
Postgres adapter coerces oids 20, 21 and 23 through `Number(value)`, so a
`BIGINT` column would silently lose precision and let distinct instants collapse
to the same value — the exact defect class this decision exists to eliminate.
Zero-padded text sorts lexicographically and round-trips exactly on all three
engines. The width is fixed at twenty digits, which reaches the year 5138: a
width that changed would invert the whole index, because a narrower value sorts
before every wider one.

**The column is camelCase, so it has a Postgres mapping entry.** Postgres folds
unquoted identifiers to lower case and a derived table restores the declared
spelling. Issue 03 found that `verifierHash` was missing from that table, which
broke every password reset on Postgres; the completeness check added since fails
when a runtime table declares a camelCase column the mapping cannot restore, and
it fails for this column too if the entry is removed.

## Consequences

The order is now the order the runtime indexed the events in, which is not quite
the order the envelope timestamps describe. An event whose envelope carries an
older timestamp than one already indexed is still returned after it. That is
deliberate: the envelope timestamp is what the event says about itself, at a
resolution that ties, and the Log index is a record of what the runtime observed
and in what order.

Rows stored before the field existed are given a sequence derived from the
timestamp they did store, by an additive migration in the shared storage
bootstrap. That preserves their relative order and puts them on the same scale as
newly indexed rows, so a bound applied after the migration keeps the newest
events rather than whichever ones happened to be there. Ties among already-stored
rows are historical and unrecoverable; the backfill separates them by a
nanosecond each so that the result is at least defined and identical on every
engine.

The Postgres `pruneLogIndex`, `readRecentLogEvents` and `ensureLogStorage`
overrides are deleted. The first two existed because of this order: the prune
needed its own copy only because the shared definition expressed the bound as
`LIMIT -1 OFFSET ?`, which is SQLite's alone, and the read differed only in
naming `id` where the shared definition named `rowid`. Expressing the bound as
the retained set rather than as an offset is portable, so both are now the shared
definition. The libSQL `ensureLogStorage` override goes with them. ADR-0034 is
explicit that an override which no longer earns its place should disappear rather
than be maintained in duplicate, and here leaving one would have been worse than
duplication: a copy of the bare `CREATE TABLE` would be a Log index that never
ran the migration.

Nothing here changes `ctx.db`, the Sporades DB API, the log envelope, or the
JSONL log stream.
