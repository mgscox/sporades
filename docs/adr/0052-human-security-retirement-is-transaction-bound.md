# Human security retirement is transaction-bound

Capsules may need to remove a human's application authority and runtime
credentials as one administrative transition. Sporades therefore exposes
`ctx.serverAuth.revokeHumanSecurity(userId)` only inside an authenticated
Capsule mutation transaction. The runtime validates that the target is one
existing authenticated, non-guest human, then deletes all of that human's
Sessions and retires their current Access keys using the same database adapter
transaction as the Capsule's app-table writes. A handler failure rolls every
effect back.

The operation returns only the target user ID and bounded revocation counts. It
does not expose auth tables, password or key material; alter identity or
application roles; accept guest, service, operator, or privileged identities;
or touch Capsule-owned Agent credentials. Capsules remain responsible for
authorizing the administrator, declaring any reauthentication purpose, changing
their own authority rows, and recording their domain audit event.

This is intentionally deeper than combining public password-reset and
Access-key APIs. Those operations have different authorization and lifecycle
semantics and cannot guarantee one rollback boundary with app-owned suspension.
Existing Capsules are unchanged unless they call the additive method.

Lifecycle authority is structured rather than ambient. A handler or mutation
hook must initiate the operation during its initial synchronous dispatch; the
runtime then tracks the returned Promise through settlement. Authority closes
when that dispatch returns its Promise, so post-`await` continuations, timers,
microtasks, detached Promises, and retained aliases cannot initiate another
retirement even while the owning mutation transaction is still open.

An application that must first await its own administrator, idempotency, or
target checks uses the additive validated-continuation form: reserve the
write-free revocation synchronously, then return `ctx.lifecycle.continue(...)`
after validation. The reservation is one-shot and transaction-bound; only the
owning Mutation's returned opaque continuation can consume it. This preserves
atomic app/runtime updates without allowing a retained capability to become
ambient authority. The trade-off is an explicit two-stage API for complex
flows; uncomplicated handlers should continue using the direct synchronous-
initiation form.
