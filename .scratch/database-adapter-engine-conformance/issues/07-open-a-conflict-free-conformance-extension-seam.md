Status: done

# Open A Conflict-Free Conformance Extension Seam

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

A prefactor, added after issue 02 landed and before issues 03, 04 and 05 run in
parallel. It changes no behaviour and adds no coverage.

Issue 02 put every conformance case in one array in one file. Issues 03, 04 and
05 each extend that coverage and are independent of one another, so they are
meant to run at the same time — but as things stand all three would append to
the same array in the same file and collide. They also share one adapter and one
prepared storage state per engine, so cases must currently avoid trampling each
other's rows.

Make the extension point explicit and per-surface. Each coverage issue should be
able to contribute its own cases in its own file without touching a file another
issue owns, while every case still runs against every engine through one shared
execution path. That last part is the constraint that matters: ADR-0035 requires
one behavioural specification executed per adapter, so per-surface files must
share the runner and the engine list. Sibling files that each re-implement how
engines are iterated would be the per-engine drift ADR-0035 exists to prevent.

Also give each surface its own adapter and prepared state, so a case added by
one issue cannot perturb a case added by another through leftover rows.

The existing six cases move to the first surface module unchanged. Test names
and counts must not change — that is how this prefactor is verified.

## Acceptance criteria

- [x] A shared helper runs a supplied set of conformance cases against every engine, and is the only place engine iteration and gating live.
- [x] Per-surface case modules contribute cases through that helper; adding a surface requires no edit to another surface's file.
- [x] The six existing cases move unchanged into a surface module, with identical test names.
- [x] Each surface gets its own adapter instance and prepared storage, so surfaces cannot interfere through shared rows.
- [x] A surface module declares any app tables it needs so the Postgres reset drops them.
- [x] The Postgres gate still controls only whether a run executes, never which assertions it makes.
- [x] Conformance test names and pass/skip counts are unchanged from issue 02, demonstrated by output before and after.
- [x] No source file changes; no coverage added or removed.

## Blocked by

- .scratch/database-adapter-engine-conformance/issues/02-run-conformance-specification-against-every-adapter.md
