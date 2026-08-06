Status: done

# Guard The Log Index Additive Migration

## What to build

Issue 10 added `indexSequence` to `sporades_log_events` with an additive
`ALTER TABLE ... ADD COLUMN` plus a backfill, so a Capsule whose Log index
predates the change picks the column up on boot.

The backfill is covered. The `ALTER` is not. Every committed test starts from the
shared DDL, which already creates the column, so no test ever runs the `ALTER`
against a table that lacks it. Issue 10's reviewer proved the gap by deleting the
`ALTER` line and finding the suite still green apart from the known baseline
failures, while a hand-built upgrade-path probe failed on all three engines.

The statement works — the reviewer verified the real upgrade path by hand on
SQLite, libSQL and Postgres, including ties, ordering against newly written rows,
and a clean second boot. This is a missing guard rather than a defect. But it is
the one line the entire upgrade story rests on, and nothing would notice if it
were removed or broken.

Cover it by starting from the pre-change table shape rather than the current DDL,
then asserting the column arrives, existing rows are backfilled in an order
consistent across engines, and a second boot is a no-op.

## Acceptance criteria

- [x] A test creates `sporades_log_events` without `indexSequence`, boots storage, and asserts the column is added and existing rows backfilled.
- [x] It runs on SQLite, libSQL and Postgres.
- [x] Deleting the `ALTER TABLE ... ADD COLUMN` statement makes it fail.
- [x] Backfilled rows order correctly against rows written after the upgrade.
- [x] A second boot changes nothing.

## Blocked by

- None — can start immediately.
