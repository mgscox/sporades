Status: ready-for-agent

# Extend Conformance Coverage To File Metadata Storage

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

Bring File metadata storage under the conformance specification, so an Upload
call that reports success has genuinely stored its File metadata on every engine.

The known defect here was among the quietest: completing an upload for a file
with no existing row took the update path instead of the insert path, so the
upload succeeded and the File metadata row was never written. Nothing threw and
nothing logged. The surrounding methods on this surface have the same exposure
and have only ever been verified on SQLite.

Cover File bucket lookup and creation. Cover File metadata row insertion, lookup
by File ID, lookup by absolute File path for both live and active rows, and
owner-scoped lookup. Cover the pending upload lifecycle: creating a pending
upload, finding it by path, finding it by identifier, completing it, and deleting
pending uploads by path and by file. Cover Public file URL creation, lookup,
revocation for a single URL and for every URL on a file, and File metadata
deletion.

Upload completion is the case that matters most and needs all three of its
outcomes exercised: completing for a file with no existing row must insert that
row, completing for an existing live row must update it, and completing for a row
that has been deleted must not resurrect it.

Any divergence found is fixed at the single shared definition rather than by
overriding the method on one engine's adapter, and the case that exposed it stays
in the specification.

## Acceptance criteria

- [ ] File bucket lookup and creation are covered.
- [ ] File metadata insertion, lookup by File ID, lookup by absolute File path for live and active rows, and owner-scoped lookup are covered.
- [ ] The pending upload lifecycle is covered, including lookup by path and by identifier and deletion by path and by file.
- [ ] Upload completion is proven to insert the row when no row exists, update the row when a live one exists, and leave a deleted row deleted.
- [ ] Public file URL creation, lookup, single revocation, and revocation of every URL for one file are covered.
- [ ] File metadata deletion is covered and proven not to remove rows belonging to another owner.
- [ ] Any divergence found is fixed at the shared method definition, not by adding a per-engine override.
- [ ] Each case that exposed a divergence remains in the specification as a regression case.

## Blocked by

- .scratch/database-adapter-engine-conformance/issues/02-run-conformance-specification-against-every-adapter.md
- .scratch/database-adapter-engine-conformance/issues/07-open-a-conflict-free-conformance-extension-seam.md
