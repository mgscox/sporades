# Research

Dated research notes for Sporades. Newest first.

- 2026-11-13 — [GlitchTip: why the browser runtime's `new WebSocket(url)` throws](glitchtip-websocket-connection-failures.md): neither error text ("Please use the 'new' operator", "…provided URL is invalid") can come from Sporades calling the native constructor, so the trigger is a third-party WebSocket replacement (extension, in-app browser or harness); the unguarded throw is first-party impact that blanks React apps on first connect and permanently stops PR #343's retry loop on reconnect; options include a constructor guard, a string URL and coarse browser/OS contexts without a raw UA or IP.
- 2026-11-08 — [Migrating a Team Billing subscription in place](2026-11-08-team-billing-in-place-plan-migration.md): Stripe allows Price, interval and timing changes on a live subscription (currency excepted); the cancel + new Checkout requirement comes from Sporades' same-quantity-policy refusal and per-product Portal configurations; recommends generalising `requestPlanTransition` with preview, period-end Subscription Schedules and flexible-billing-mode anchors, plus 7 draft issues.
