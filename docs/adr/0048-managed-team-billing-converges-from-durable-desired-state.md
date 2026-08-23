# Managed Team Billing converges from durable desired state

Customer Portal configuration may safely expose Plan switches only when source
and target share one quantity policy. Sporades therefore keeps compatible
fixed-to-fixed and Team-counted-to-Team-counted switches in the explicitly
attested Portal, while `teamBilling.requestPlanTransition(...)` owns switches
between fixed and accepted-Team-member quantity. The Capsule keeps the
authorization and downgrade decision; Sporades owns the provider mechanics and
returns only provider-free operation state for app-owned rendering.

A managed request atomically records its public operation, one latest-wins
desired tuple, and a reserved Job. The tuple fixes target product, exact target
quantity, effective time, and provider idempotency. Each attempt reauthorizes
the original actor and re-reads the current Subscription, catalogue, and exact
accepted-member count before provider I/O. Stripe receives the attested
Subscription item, source and target Price, and quantity together with
`create_prorations`, the tuple's stable `proration_date`, and
`pending_if_incomplete`. Sporades does not force an immediate standalone
invoice. Payment action required fails safely for app-owned recovery.

Accepted-Team membership transactions never wait for Stripe. After a Join,
removal, or leave commits, the runtime best-effort stages a seat desired tuple.
New membership counts replace stale intent. Startup repair independently
compares every accepted Team-counted Subscription with its exact Team count and
reconstructs missing or failed work, so staging failure and provider outage do
not roll back collaboration state.

Provider calls remain outside database transactions. A durable per-Team claim
lane serializes them across independent SQLite, libSQL, and Postgres runtimes;
a stale worker may finish its already-started call, but it cannot erase newer
intent, and the newer target runs after the lane is released. Retries preserve
the desired tuple and idempotency. Provider acknowledgement moves intent only
to awaiting observation. Exact verified Subscription evidence inside the
atomic Stripe fence alone completes the operation or seat target; mismatched
evidence requeues repair. This is convergent at-least-once coordination, not an
exactly-once Stripe transaction.
