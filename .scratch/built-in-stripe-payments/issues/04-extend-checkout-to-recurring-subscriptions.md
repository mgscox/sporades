# 04 — Extend Checkout to recurring subscriptions

**What to build:** Extend the proven Checkout Job so an authorized Capsule customer can begin a Stripe-hosted recurring subscription through the same narrow payment path without introducing a second transport or allowing the browser to control provider authority.

**Blocked by:** 03 — Start one-time Checkout through a durable Job.

**Status:** done

- [x] The existing Checkout operation accepts an explicit server-owned one-time or subscription mode without adding a parallel Checkout implementation.
- [x] A subscription product key maps only to an allowlisted recurring Stripe Price and a server-approved quantity.
- [x] A one-time product cannot be submitted in subscription mode, and a recurring product cannot silently enter one-time mode.
- [x] Subscription Checkout retains the linked-user default and the Capsule's explicit Customer, Team, billing-holder, and product authorization policy.
- [x] Anonymous behavior does not widen automatically from one-time Checkout to subscription Checkout.
- [x] Subscription creation retains the same post-commit Job execution, stable business idempotency, trusted-origin redirects, narrow result, bounded observation, retry, cancellation, and redaction behavior as one-time Checkout.
- [x] Client input cannot provide an arbitrary Price, Customer, mode, quantity, metadata authority, idempotency namespace, success origin, or cancellation origin.
- [x] Sporades creates no subscription, entitlement, invoice, seat, order, billing-holder, or access table on behalf of the Capsule.
- [x] A protocol-faithful local provider fake proves a successful subscription Checkout and rejects mismatched Price modes, unauthorized actors, and duplicated attempts.
- [x] Generated blank guidance explains that Checkout begins provider billing but verified events and Capsule policy determine local access consequences.
- [x] Public declarations, documentation, Bundle behavior, and focused generated-Capsule tests describe one Checkout interface supporting both modes.
