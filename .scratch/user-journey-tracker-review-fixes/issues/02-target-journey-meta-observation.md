# 02 — Target Journey Meta Observation

**What to build:** Restrict attribute observation to the active
`<meta name="sporades-journey">` element while retaining narrow head child-list
observation for creation, replacement, and removal.

**Blocked by:** None — can start immediately.

**Status:** done

## Parent

.scratch/user-journey-tracker-review-fixes/PRD.md

- [ ] A regression test first proves unrelated metadata attribute changes do
  not trigger Journey navigation publication.
- [ ] Content changes on the active Journey meta element trigger reevaluation.
- [ ] Creation, replacement, removal, and name changes affecting the active
  Journey meta surface trigger reevaluation through narrow head observation.
- [ ] The implementation does not attach an attribute observer to unrelated
  `meta` elements or observe the general DOM.
- [ ] Observer setup and teardown remain idempotent.
- [ ] Source and generated client runtime artifacts remain aligned.
- [ ] Focused browser-runtime tests pass.
