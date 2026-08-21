# Atomic Stripe consequences are runtime-owned

A Capsule may declare `stripeEvent({ consequence: "atomic" }, handler)` when one verified Stripe Event must produce one all-or-nothing app consequence. The existing `stripeEvent(handler)` declaration is unchanged: it remains an at-least-once Privileged Job callback that may wait cooperatively on cancellation without holding a database transaction.

The opt-in form is deliberately narrow. The handler receives the userless Privileged identity, the verified Event, app-table access, logging, the Abort signal, Server env, and Job enqueue. It receives no payment-provider, mail, File, message, auth-management, Schedule, Access-key, Team-management, or nested Privileged capability. Context authority is revoked when the callback settles.

The runtime opens one database transaction, acquires the `stripe-consequence-fence` metadata row before exposing the context or permitting an app read, and holds that fence through commit or rollback. Contending SQLite transactions retry the bounded fence acquisition; libSQL serializes transaction batons; Postgres contends on the same durable row across independent connections. Engine-specific transaction mechanics remain below ADR-0037's adapter seam, while the fence workflow and observable serial history remain shared runtime behavior.

Handler return, pending ACL/log cleanup, and a final Abort check precede commit. A throw or cleanup failure rolls back app writes, transaction-bound logs, and enqueued Jobs. A committed enqueue is dispatched only after commit. Job claims, retries, lifecycle state, and the single outer `jobs.execute` audit triplet remain outside the app transaction. The transaction makes each attempt atomic; it does not make Stripe delivery exactly once, so Capsule policy still owns provider Event idempotency and event-order decisions.

This decision adds no general Capsule transaction API and claims no provider-side rollback. Provider I/O stays outside the consequence context because a database rollback cannot reverse it.
