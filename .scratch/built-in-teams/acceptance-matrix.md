# Built-in Teams complete-contract acceptance matrix

Ticket 11 verification is intentionally at public runtime seams. The matrix
maps the completed Tickets 01–10 contract to the concrete tests that prevent
the next change from quietly separating source, generated Bundles, adapters,
or documentation.

| Requirement area | Contract proof | Verification entry points | Status |
| --- | --- | --- | --- |
| Single-user invisibility | A Capsule that never uses Teams retains auth shape, query, mutation, App-message, File, ACL, startup, and generated-output behaviour. | `teams-runtime.test.js`: `a Capsule that never uses Teams...`; `server-bundle-module-graph.test.js`: generated Bundle smoke coverage. | covered |
| Account bootstrap | Email, OAuth, local identity, legacy lazy bootstrap, rollback, retry, and concurrent linking commit exactly one initial singleton Team/admin membership. | `teams-runtime.test.js`: `email and every OAuth...`, bootstrap rollback/retry/legacy/concurrency cases. | covered |
| Team lifecycle and Join links | Explicit create/rename/list, scoped member listing, target-email issue/list/revoke/inspect, non-consuming validation, authoritative idempotent redemption, management lifecycle, and eligible deletion work through browser and trusted seams. | `teams.test.js`: public/trusted singleton, member-list, create/rename, Join-link, redemption, and admin-lifecycle scenarios. | covered |
| Validation and privacy | Invalid capabilities are generic; safe member/link projections exclude capability material and unnecessary account data. | `teams.test.js`: Join-link safe projection and generic denial; `teams-runtime.test.js`: tamper/expiry/revocation inspection; `teams-contract.test.js`: published privacy contract. | covered |
| Application roles | Declarations validate; exact-Team admins atomically reconcile membership-scoped roles; undeclared stored assignments fail closed and recover on rollback. | `teams.test.js`: `declared application roles...`; `teams-runtime.test.js`: declaration rollback and mixed-write rollback. | covered |
| Constrained Team ACL | Explicit-Team membership, admin, role, and any-role decisions constrain normal table and normal File APIs without exposing mutable Team APIs. | `table-acl.test.js`: Team ACL table cases; `teams.test.js`: `normal File URLs...`; `server-bundle-module-graph.test.js`: generated Team role flow. | covered |
| Audit and security | Team changes are redacted ordinary runtime security events; Join secrets, URLs, target emails, sessions, provider values, credentials, and raw payloads do not leak. | `teams.test.js`: audit flush, generic denial, endpoint/App-message denial; `teams-runtime.test.js`: capability storage/inspection cases; `teams-contract.test.js`. | covered |
| Transactions, concurrency, rollback, restart | Unique membership, bounded claims, lifecycle locking, last-admin safety, capability consumption, failed writes, and restart persistence retain their invariants. | `teams-runtime.test.js`: capacity/lifecycle-lock/demote-remove/concurrent-bootstrap/redemption-restart cases; `teams.test.js`: cross-runtime membership claim and deletion rollback. | covered |
| Database adapters | Runtime-owned Team, membership, role, bootstrap, signing-secret, Join, counter, and redemption storage uses the shared adapter conformance harness. | `database-adapter-conformance-team-storage.test.js`; ADR-0035 harness coverage test. | covered; Postgres only skips when no `SPORADES_TEST_POSTGRES_URL` is configured |
| Source, Bundle, types, and docs parity | Source and generated Bundle protocol cover browser and trusted operations; client/server Team types and API pages are generated; canonical reference is linked from navigation. | `server-bundle-module-graph.test.js`, `client-runtime.test.js`, `teams-contract.test.js`, `npm run typecheck`, `scripts/build-docs.mjs`. | covered |

The browser-facing runtime suite uses the actual local HTTP/WebSocket runtime
under Node 22. Container and Hosted Capsules execute the same generated server
Bundle; Bundle graph tests prove that shipped Bundle path. The separately gated
real Vite Container suite remains opt-in through `SPORADES_REAL_VITE_CONTAINER=1`.
