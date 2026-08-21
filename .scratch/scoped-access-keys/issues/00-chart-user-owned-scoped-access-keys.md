# Chart user-owned scoped Access keys

Status: closed
Label: wayfinder:map
Assignee: unassigned

## Destination

Produce an implementation-ready specification for runtime-owned, user-owned, centrally scoped Access keys, including safe Credential provenance that lets Capsules distinguish an interactive user Session from named API access without inventing a second user or authority model.

## Notes

Use `CONTEXT.md`, the auth ADRs, and the repository's public/generated-contract, authority-boundary, and persistent-runtime review rules. Consult the `codebase-design`, `domain-modeling`, and `grilling` skills for every decision ticket; use `prototype` or `research` where its ticket requires it.

Standing destination constraints captured during charting: every Access key belongs to one linked Sporades user; the key never has more authority than its owner and granted scopes; direct owner issuance is approval; Capsules centrally declare scopes with permissive `*` wildcard matching; `requireAuth` is the Access-key opt-in and retains compatible inline and wrapper forms; omitted credential and scope requirements mean any; initial authentication is limited to opted-in Custom endpoints and authorized private File reads; Credential provenance exposes whether a request used an interactive Session or a named Access key; Capsules render management UI over Sporades-owned SDK and operator surfaces.

## Decisions so far

<!-- Closed ticket decisions are indexed here by name and link. -->

- [Define Credential provenance and authority invariants](./01-define-credential-provenance-and-authority-invariants.md) — The linked user remains the sole actor; one immutable-owner Access key contributes fail-closed, snapshotted Credential provenance and only narrows authority through terminal lifecycle rules.
- [Define scope declaration, grant, and matching semantics](./02-define-scope-declaration-grant-and-matching-semantics.md) — Capsule-declared concrete scopes meet immutable live-wildcard grants only at explicit checks; defaults remain permissive and platform authority stays owner-derived.
- [Prototype the requireAuth Access-key interface](./03-prototype-the-requireauth-access-key-interface.md) — A declarative `requireAuth` decorator opts handlers into pre-handler credential admission, while deprecated inline `requireAuth` remains compatible behind the clearer `requireUserAuth` user-context check.
- [Research bearer Access-key security contracts](./04-research-bearer-access-key-security-contracts.md) — A versioned opaque Bearer selector/verifier contract combines one-time disclosure, hashed constant-time verification, fail-closed HTTP semantics, redaction, and bounded failed-admission throttling.
- [Design runtime storage and transaction invariants](./05-design-runtime-storage-and-transaction-invariants.md) — Stable scrub-on-revoke key records and a per-owner mutation ledger preserve lifecycle, quota, recovery, telemetry, and cross-engine invariants through shared Auth transactions.
- [Design owner management and operator surfaces](./06-design-owner-management-and-operator-surfaces.md) — Session-only current-user SDKs provide one-time owner lifecycle management, while audited Privileged and cross-session CLI operations may inspect or retire keys but never issue them.
- [Integrate Credential provenance with runtime authority](./07-integrate-credential-provenance-with-runtime-authority.md) — Frozen Session-or-Access-key provenance follows the sole user actor through guarded endpoints, explicit private Files, ACLs, middleware, durable Jobs, and redacted attribution without becoming authority.
- [Fix the public contract and completion proof](./08-fix-the-public-contract-and-completion-proof.md) — One top-level scope declaration, compatible server/client interfaces, generated and documented parity, cross-engine conformance, and real Dev/Container HTTP evidence define completion.

## Not yet specified

- None. The implementation-ready route is fully specified.

## Out of scope

- Implementing the resulting specification.
- Bot identities, service accounts, synthetic users, independent Team membership, or key-owned records and roles.
- A framework-owned universal Access-key management webpage.
- Key-request, polling approval, OAuth device-code, or other pending-approval flows.
- Access-key authentication for the browser WebSocket transport, queries, mutations, App messages, or OAuth routes.
