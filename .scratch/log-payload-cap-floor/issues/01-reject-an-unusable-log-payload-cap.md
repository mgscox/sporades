# Reject an unusable log payload cap

Status: complete

## Parent

.scratch/log-payload-cap-floor/PRD.md

## What to build

Implement the identity-aware cap contract in the parent PRD. This resolves the
remaining PR #30 review finding without imposing unrelated identity limits.
The user approved this direction on 2026-09-11.

## Acceptance criteria

- [x] Compute the minimum from the actual writer envelope, configured identity and release, and the PRD's bounded event allowances.
- [x] Reject insufficient and invalid caps with `INVALID_LOG_CONFIG` and an actionable numeric hint at configuration loading and runtime startup.
- [x] Validate both aliases consistently, retaining `logs` precedence and the 4096-byte default when sufficient, without silent clamping.
- [x] Preserve 256 bytes of structured redacted data at the exact minimum, accounting for UTF-8, JSON escaping, ID fallbacks, and the truncation flag.
- [x] Test below-minimum, exact-minimum, ordinary caps, long identities, aliases, and startup rejection; retain oversize-event truncation.
- [x] Rebuild shipped `bin/` and `dist/` artifacts and verify CLI/runtime parity.
- [x] Update canonical configuration docs and domain requirements.

## Blocked by

None.

## Completion evidence

Implemented in `bfb6bce1` on `codex/log-payload-cap-floor`.

- `src/log-envelope.ts` owns the shared envelope constructor, computed floor,
  alias/default resolution, and structured validator. The writer uses the same
  constructor; configuration loading and runtime startup call the validator.
- `test/log-payload-config.test.js`: 6 passing tests covering rejected 256-byte
  caps, exact and below-minimum boundaries, actual identity/ID overrides,
  release overhead, escaped Unicode, aliases, invalid values, default overflow,
  generated Capsule startup, shipped CLI parity, and retained truncation.
  The original 256-byte config regression was observed red before implementation
  (`Missing expected rejection`) and green after rebuilding.
- `npm test` under Node 22.23.2: **2305 tests, 2178 passed, 0 failed,
  127 skipped**, completed on 2026-09-11. Includes the build/typechecks and
  generated-artifact consistency gate. The initial Node 24.19.0 attempt hit a
  native SQLite `InternalCallbackScope::Close` assertion and was stopped; the
  completed Node 22 run is the full-suite evidence.
- `npm run docs:check`: **45 passed, 0 failed**, and documentation site built.
- Independent Standards and Spec reviews of `125355ab...bfb6bce1`: **0 findings
  on each axis**. Later edits only record these completion results.
- `git diff --check` passed. Canonical guide, reference, CONTEXT, and PRD updated;
  shipped `bin/`, `dist/`, and generated-source manifest rebuilt.

The branch is local. Automatic approval review blocked pushing to GitHub pending
explicit authorization. PR #30 remains unchanged; this implementation supersedes
its unratified global-floor proposal without modifying the Dev reload tracker.
