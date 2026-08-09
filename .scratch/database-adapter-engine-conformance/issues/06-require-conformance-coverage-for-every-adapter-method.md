Status: done

# Require Conformance Coverage For Every Adapter Method

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

Close the loop so this defect class cannot return through a method nobody thought
to cover.

A maintainer adds a method to the Database adapter, runs the ordinary test
command, and is told that the method has no conformance case. The specification
stops being something a contributor has to remember to extend and becomes
something the build insists on.

The check enumerates the methods the Database adapter exposes and fails when one
has no case in the conformance specification. Methods whose behaviour is
genuinely engine-specific — connection lifecycle, dialect emission, transaction
session mechanics — are exempt through an explicit list that records a short
reason per entry, so an exemption is a visible decision in a diff rather than a
silent omission.

One exemption must not be available, and this is the point of the ticket rather
than a detail. **A method being overridden by an engine is not grounds for
exempting it.** ADR-0034 names the await-shim: an override that emits the same
SQL as the shared definition purely to resolve before deriving. Where one
exists, the shared definition is still wrong and is merely dormant behind the
shim, so it needs a conformance case more than an unshadowed method does, not
less. Several such pairs exist today. An exemption rule that keyed off "the
engines override this anyway" would excuse exactly the methods the suite was
built to catch.

This ticket comes last because the check is only useful once coverage is broad
enough for it to pass. Landing it earlier would mean either a failing build or an
exemption list long enough to be meaningless.

## Acceptance criteria

- [x] A check enumerates the Database adapter method set and fails when a method has no conformance case.
- [x] The check runs as part of the ordinary test command.
- [x] Methods exempt from conformance coverage are listed explicitly, each with a short recorded reason.
- [x] Being overridden by one or more engines is never accepted as an exemption reason; a shared definition shadowed by an await-shim still requires a conformance case.
- [x] Adding a method to the adapter without a conformance case fails the check.
- [x] The check passes when this ticket lands, with an exemption list limited to genuinely engine-specific mechanics.

## Blocked by

- .scratch/database-adapter-engine-conformance/issues/03-extend-conformance-coverage-to-auth-storage.md
- .scratch/database-adapter-engine-conformance/issues/04-extend-conformance-coverage-to-file-metadata-storage.md
- .scratch/database-adapter-engine-conformance/issues/05-extend-conformance-coverage-to-app-tables-and-runtime-metadata.md
