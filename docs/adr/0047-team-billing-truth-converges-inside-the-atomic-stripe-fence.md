# Team Billing truth converges inside the atomic Stripe fence

Verified delivery is evidence, not billing truth. When a Capsule declares
headless Team Billing, Sporades applies supported Checkout, Subscription, and
failed-invoice observations through the existing per-Capsule atomic Stripe
fence. The platform consequence validates the exact runtime mode, operation,
Customer, Subscription, single licensed item, declared Price, quantity,
period, status, and cancellation semantics before changing the private Team
billing projection. Checkout completion may correlate these objects but cannot
activate entitlement without an authoritative Subscription snapshot.

Each accepted Subscription snapshot carries its period, provider occurrence
time, semantic rank, and terminal state. A newer period wins; within one period
a newer observation wins; at equal time the safer semantic state wins. A
deleted Subscription ID is permanently terminal and cannot be resurrected by a
later update. Provider Event identifiers are replay identities, not a business
ordering rule. Duplicate, stale, out-of-order, and concurrent delivery thus
converges independently of fence acquisition order.

Supported evidence that is malformed, unknown to the declared catalogue, or
ambiguous is quarantined without provider JSON or raw errors. Team-linked
quarantine dominates the safe client projection when it is at least as current
as accepted truth; unassociated quarantine is available only through bounded,
provider-free `privilegedCtx.teamBilling.listQuarantines()` inspection. Multiple current licensed
Subscriptions fail closed.

An opt-in atomic Capsule Stripe handler runs in the same transaction as the
platform consequence, so either both commit or both roll back. The compatible
legacy handler runs only after the platform transaction commits and retains its
long-lived at-least-once retry behavior. Provider calls remain outside this
transaction: the fence orders verified database consequences, not Stripe.
