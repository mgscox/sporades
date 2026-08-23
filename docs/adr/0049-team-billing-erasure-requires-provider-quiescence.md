# Team Billing erasure requires provider quiescence

Deleting a Capsule's local Team rows cannot itself prove that Stripe has
stopped creating or renewing paid objects. Sporades therefore owns a durable
provider-safe preparation operation and the Capsule keeps its separate local
deletion transaction and all rendered confirmation UI.

`teamBilling.prepareErasure({ teamId, requestId })` reauthorizes the linked Team
administrator, fences new Checkout, Portal, Plan, and seat work, and enqueues a
runtime-owned erasure Job. One per-Team provider lane serializes this Job with
managed provider writes. The Job resolves every known Checkout as complete,
expired, or exactly 404-safe, including replay of the original immutable
idempotent Checkout request after a lost response. It immediately cancels every
known or Customer-discovered live Subscription and repeats discovery until the
provider is quiescent. Customer deletion is deliberately outside this contract.

Provider responses are strict closed evidence. Missing objects are safe only
after an exact provider 404; absence from local storage, a network error, or a
partial provider list never authorizes deletion. Retries keep provider
idempotency stable. If an open Checkout completes while Stripe processes its
expire request, only Stripe's exact non-expireable response permits one fresh
retrieve; the completed Session and its Subscription are then quiesced
normally. Other provider errors are not reclassified. Restart and exhaustion
repair create fresh Job generations; a live provider-lane claim produces a
durable delayed successor at its exact expiry. Settlement must still own the
exact claim token, so a stale call cannot consume newer state or release a
newer claimant. Only complete provider evidence creates the aggregate
authorization tombstone.

The aggregate and per-object tombstones retain keyed identity digests, terminal
classes, timestamps, and one evidence digest. They contain no Team or User
identity, email, holder, product key, Plan, quantity, invoice, raw provider
object, or recoverable provider identifier. Late verified events are checked
against those identity tombstones before convergence and cannot recreate an
entitlement.

Inside the Capsule's later local deletion mutation,
`ctx.teamBilling.admitLocalErasure(teamId)` is transaction-bound,
provider-free, and returns only `{ allowed: true }`. It does not delete local
rows or expose provider evidence. Its authority is tied to the current handler
context and is rechecked after every asynchronous boundary; abort, rollback,
callback settlement, and detached work revoke it. This preserves the headless boundary:
Sporades owns provider mechanics, durable retry, and proof; the Capsule owns
local domain deletion and rendering.
