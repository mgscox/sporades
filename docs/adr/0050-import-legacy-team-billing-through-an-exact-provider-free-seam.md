# Import legacy Team Billing through an exact provider-free seam

Status: accepted

An existing Capsule may have verified Subscription evidence before it adopts
Sporades Team Billing. Runtime-owned tables cannot safely be populated through
Capsule table APIs, and direct SQL would duplicate platform invariants.

Sporades therefore exports `sporades/server/team-billing-import` for offline,
operator-controlled migration tooling. `importLegacyTeamBillingEvidence`
accepts one complete verified Customer, Subscription, Price, item, quantity,
state, and Event tuple. It creates Team Billing storage if needed, writes the
Customer, Subscription, Observation, and replay guard in one transaction, and
is idempotent only for an exactly unchanged tuple. Missing, malformed, or
conflicting evidence fails closed. Exact comparison includes every durable
ordering and terminal-safety value written by the import: last Event occurrence,
kind, rank, and terminal latch. `importLegacyTeamBillingReplayGuard` imports
processed Event evidence without inventing a Team association.

Import uses the same bounded Subscription semantics as normal convergence:
created or updated active evidence becomes active or cancelling, past-due
evidence becomes past-due, and only a deleted plus cancelled tuple can set the
terminal latch. Contradictory Event/state tuples are invalid rather than being
given an invented ordering.

The exported adapter contract is the runtime contract: it requires a named SQL
dialect, `exec`, prepared statements, and transactions. This lets offline tools
type-check their complete adapter before any migration evidence is admitted.

The Capsule owns source classification, Plan-to-product policy, progress, and
rollback records. These functions perform no provider I/O, infer no provider
identity, expose no client surface, and do not make legacy entitlement
authoritative. Normal verified convergence remains the only post-cutover path.
