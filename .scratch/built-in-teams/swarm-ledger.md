# Built-in Teams swarm ledger

**Coordinator base:** `34e6a0cb5813ddac91678f0e6bd9f909962ab7a2` (`codex/team-feature-status`)

| Issue | State | Blockers | Base SHA | Worker / reviewer | Worker SHA | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 — Initial singleton Team | done | None | `34e6a0c` | `codex/swarm-teams-01` / final review `ACCEPT` | `7538f67` | ACCEPT | `e6dddd7` | Integration: build/typecheck; Teams 8/8; ACL/type/docs 58/58; bundle 15 pass/1 configured Postgres skip | worker worktree retained |
| 02 — Bootstrap during account linking | done | 01 merged | `06760a9` | `codex/swarm-teams-02` / final review `ACCEPT` | `1319d42` | ACCEPT | `7a11833` | Integration: build/typecheck/generated-bin; OAuth/public/bundle 62 pass/1 configured PG skip | worker worktree retained |
| 03 — Create and rename Teams | done | 01 merged | `ece42f2` | `codex/swarm-teams-03` / final review `ACCEPT` | `9b77809` | ACCEPT | `169c29c` | Integration: build/typecheck/docs; focused 99 pass/1 configured PG skip | worker worktree retained |
| 04 — List Team memberships | ready | 03 merged | — | — | — | — | — | — |
| 05 — Email-bound Join links | ready | 03 merged | — | — | — | — | — | — |
| 06 — Validate Join links | blocked | 02, 05 | — | — | — | — | — | — | — |
| 07 — Join through link | blocked | 04, 06 | — | — | — | — | — | — | — |
| 08 — Team-admin lifecycle | blocked | 07 | — | — | — | — | — | — | — |
| 09 — Membership application roles | blocked | 07 | — | — | — | — | — | — | — |
| 10 — Team ACL | blocked | 09 | — | — | — | — | — | — | — |
| 11 — Complete Teams contract | blocked | 08, 10 | — | — | — | — | — | — | — |

## Preflight

- 2026-08-14: graph validated against `34e6a0c`; all 11 tickets and declared blocker edges are present.
- 2026-08-14: coordinator worktree clean before ledger creation; no upstream is configured for the feature branch.
- 2026-08-14: dependencies installed with `npm ci`; `npm run typecheck` passed.
- 2026-08-14: broad `npm test` reached test execution but has baseline Node 24 native assertions in database-adapter subprocesses, including the app-table, auth-storage, file-metadata, generic conformance, and adapter-engine test entries. Those need live revalidation under supported Node 22 before they can be treated as source regressions.
- 2026-08-14: independent review of `34e6a0c...c843bd2` returned `REQUEST_CHANGES`: Capsule schemas could adopt runtime Team table names; simultaneous SQLite bootstrap calls raced at transaction start; and a privileged context retained a caller-scoped `teams` closure.
- 2026-08-14: fresh re-review of `34e6a0c...3929d60` returned `REQUEST_CHANGES`: bootstrap coalescing was per user rather than per SQLite runtime connection, Team tables were missing from Postgres conformance cleanup, and the required no-Team Capsule compatibility regression was absent.
- 2026-08-14: fresh re-review of `34e6a0c...572cff6` returned `REQUEST_CHANGES`: the Team namespace guard was case-sensitive and incomplete on SQLite, Team storage DDL was concurrent, and generated SDK documentation was stale.
- 2026-08-14: fresh re-review of `34e6a0c...ce0ef33` returned `REQUEST_CHANGES`: `docs/ROADMAP.md` still described Teams as an entirely future candidate rather than separating the delivered listing foundation from deferred administration, Join links, roles, and ACL work.
- 2026-08-14: fresh re-review of `34e6a0c...117f852` returned `REQUEST_CHANGES`: the separate Capsule-roles roadmap candidate was not explicitly reconciled with the approved membership-scoped application-role model.
- 2026-08-14: fresh re-review of `34e6a0c...7023850` found canonical generic-role documentation drift and missing behavioral deployed-bundle parity coverage. Its auth-link bootstrap finding is deliberately deferred: it is the approved scope of blocked Ticket 02, not Ticket 01's lazy bootstrap foundation.
- 2026-08-14: fresh re-review of `34e6a0c...13bc1c4` returned `REQUEST_CHANGES`: ACL context spread exposed mutable `ctx.teams`, allowing lazy Team bootstrap from ACL evaluation before Ticket 10's constrained read-only helpers exist.
- 2026-08-14: final review of `34e6a0c...7538f67` returned `ACCEPT`. The coordinator integrated the reviewed eight-commit series as `17e2c7a`, `456915d`, `1bb83d2`, `9dbf553`, `292845e`, `da01fbd`, `4f9cb29`, and `e6dddd7`; integration checks passed.
- 2026-08-14: final review of `06760a9...1319d42` returned `ACCEPT`. The coordinator integrated the reviewed six-commit series as `f91976c`, `5962163`, `efc02d4`, `39064a4`, `3d8575d`, and `7a11833`; integration checks passed. The later rework-only commits `bf24d04`, `27aafb8`, and `1319d42` were included in that accepted worker range and are represented by their coordinator equivalents in the integration series.
