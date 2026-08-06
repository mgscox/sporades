Status: ready-for-agent

# Emitted Bundle Must Define Every Identifier It References

## What to build

The generated Capsule server bundle is assembled by emitting `fn.toString()` for
each entry in a hand-maintained function list plus a constant preamble. A runtime
function that references anything not in that list becomes a free binding in the
emitted bundle: `ReferenceError` at Capsule boot or on first execution of that
path, in production, while every adapter test stays green.

This is not hypothetical. Issue 10's worker introduced exactly this and caught it
only because ~20 bundle-booting tests happened to exercise the path. Its reviewer
then ran a scope-resolving parse over the emitted bundle and found **four that are
already there**, unchanged for some time:

- `validateReadOnlyInspectionSql`, reached from the Postgres and libSQL
  `runReadOnlyInspectionQuery`
- `setEmailPassword`, the server-only password change path
- `markAsyncAclHelperRead`, reached from the ACL context helpers
- `resolveAclStorageFileReference`, reached from the ACL storage helpers

Each is defined in the runtime source and absent from the emitted function list.
Confirm each independently before fixing — establish for each whether an emitted
function really reaches it, and on which code path, so the blast radius is known
rather than assumed. `setEmailPassword` and the two ACL helpers are the ones to
characterise first: one is a credential path and the others sit in authorization.

Fixing the four is the smaller half. The point of this issue is that the class has
no guard. The failure is invisible to the test suite by construction — tests catch
a `ReferenceError` only on paths they execute, and the four above are proof that
is not enough. Add a check that parses the emitted bundle, resolves scopes, and
fails when any identifier is unresolved. Issue 10's reviewer demonstrated this is
cheap: one parse of the generated output, assert the unresolved set is empty. It
would have turned both that worker's mid-implementation regression and these four
into ordinary `npm test` failures.

Validate the check the way that reviewer did: inject a deliberate free binding,
confirm the check names it, then remove it. A guard that has never failed is not
known to work.

## Acceptance criteria

- [ ] Each of the four identifiers is confirmed reachable or not, with its path recorded, before any fix.
- [ ] Every identifier the emitted bundle references is defined within it.
- [ ] A check fails when a runtime function references something the bundle does not define, and runs in the ordinary test command.
- [ ] The check is demonstrated to fail against a deliberately introduced free binding.
- [ ] No behavioural change to any runtime path beyond making the referenced definitions available.

## Blocked by

- None — can start immediately.
