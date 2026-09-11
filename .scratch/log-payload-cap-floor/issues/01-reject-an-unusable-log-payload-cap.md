# Reject an unusable log payload cap

Status: ready-for-agent

## Parent

.scratch/log-payload-cap-floor/PRD.md

## What to build

Implement the identity-aware cap contract in the parent PRD. This resolves the
remaining PR #30 review finding without imposing unrelated identity limits.
The user approved this direction on 2026-09-11.

## Acceptance criteria

- [ ] Compute the minimum from the actual writer envelope, configured identity and release, and the PRD's bounded event allowances.
- [ ] Reject insufficient and invalid caps with `INVALID_LOG_CONFIG` and an actionable numeric hint at configuration loading and runtime startup.
- [ ] Validate both aliases consistently, retaining `logs` precedence and the 4096-byte default when sufficient, without silent clamping.
- [ ] Preserve 256 bytes of structured redacted data at the exact minimum, accounting for UTF-8, JSON escaping, ID fallbacks, and the truncation flag.
- [ ] Test below-minimum, exact-minimum, ordinary caps, long identities, aliases, and startup rejection; retain oversize-event truncation.
- [ ] Rebuild shipped `bin/` and `dist/` artifacts and verify CLI/runtime parity.
- [ ] Update canonical configuration docs and domain requirements.

## Blocked by

None.

## Completion evidence

Pending final validation and independent review.
