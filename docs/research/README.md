# Research

Dated research notes for Sporades. Newest first.

- 2026-11-08 — [Migrating a Team Billing subscription in place](2026-11-08-team-billing-in-place-plan-migration.md): Stripe allows Price, interval and timing changes on a live subscription (currency excepted); the cancel + new Checkout requirement comes from Sporades' same-quantity-policy refusal and per-product Portal configurations; recommends generalising `requestPlanTransition` with preview, period-end Subscription Schedules and flexible-billing-mode anchors, plus 7 draft issues.
