# Ordinary Job authority does not fence SMTP acceptance

Date: 2026-09-18. Status: **negative feasibility decision; implementation gate blocked**.
Part of [#52](https://github.com/mgscox/sporades/issues/52),
[ticket 01](https://github.com/mgscox/sporades/blob/codex/issue-52-resource-fence-tickets/.scratch/ordinary-job-resource-fences/issues/01-prove-external-side-effect-contract.md).

## Decision

Do not expose the proposed general resource transaction with an ordinary SMTP
handoff guarantee. Neither a transaction held around the call nor a durable
conditional-update lease satisfies the parent contract under recoverable
ownership loss and a resumable owner. The experiment demonstrates counterexamples
on real SQLite and PostgreSQL storage with independent child processes and a
controlled loopback SMTP receiver. **Tickets 02–07 remain blocked.** No contract
amendment has been approved, and database-only fencing or rejecting SMTP does not
complete the parent. No production API, generated contract, or runtime behavior
changes in this decision.

This is an impossibility result for the stated failure model and nonparticipating
ordinary SMTP destination, not a claim that all distributed handoff designs are
impossible. See the [experiment and evidence](../../experiments/issue52-external-contract/README.md).

## Vocabulary and distinct boundaries

- **Resource authority**: permission for one actor and attempt generation to
  perform protected operations on one named Capsule resource. A name alone is
  neither authorization nor a global lock across unrelated Capsules.
- **Database fence**: an engine-enforced transaction lock or conditional write
  predicate that excludes a competing or stale database writer.
- **Callback execution**: live JavaScript continuing in an owner process; it can
  outlive a database connection, an expired claim, or cooperative cancellation.
- **External acceptance**: the SMTP receiver accepting responsibility for the
  message after DATA, independently of whether the sender receives the reply.
  This is not delivery, reading the message, or completing its business effect.
- **Uncertain handoff**: the sender cannot distinguish accepted-with-lost-reply
  from not accepted. Database rollback is not a receiver-side undo operation.
- **Fencing participation**: the acceptance authority rejects a stale generation
  at the very operation that records acceptance, ordered with authority transfer.
  An earlier token check is insufficient.
- **Quiescence**: proof that an old owner and all of its issued effects can no
  longer reach acceptance. An expired timer, disconnected database, or aborted
  Promise is not that proof.

These terms preserve ADR-0026's database Transaction boundary and ADR-0045's
separation of atomic database consequences from provider calls. They do not
redefine provider acceptance as an atomic database consequence.

## Failure model and proof

Assume A can pause at any instruction or lose its database connection while its
process and independent SMTP connectivity survive. B must eventually recover
resource authority after A dies. Ordinary SMTP does not consult the database's
owner generation and offers no atomic generation-conditional acceptance primitive.

A passes its last check. Pause A before submission. Revoke/expire A's database
authority and let B acquire. Resuming A still executes the already-admitted call;
SMTP accepts it. Moving the last check closer only moves the pause point. An
AbortSignal does not interrupt an OS-stopped process or retract bytes already
issued. An engine lock survives a pause but disappears on connection loss or
process death; only the latter rules out this process resuming.

A permanent durable claim avoids expiry takeover but provides no safe automatic
recovery from an indistinguishable live-paused owner. Deleting it on restart or
expiry admits the same stale submission. A single claimed outbox or a gateway
that checks its database before forwarding ordinary SMTP moves this window; it
does not close it at downstream acceptance.

There is a second independent ambiguity: A sends, the receiver accepts, and the
reply is lost. Rolling back the database leaves the message accepted. Retrying
can accept it twice (even with the same Message-ID); not retrying can lose a
message in the observationally identical not-accepted case. The experiment
records both outcomes. Exactly-once delivery is not a parent requirement, but
this ambiguity prevents treating failure/rollback as proof of no external effect.

## Transaction scope versus durable conditional updates

| Shape | Precise acquisition and loss | Proven benefit | Failure remaining |
| --- | --- | --- | --- |
| Engine transaction | Successful `BEGIN IMMEDIATE` on SQLite or row `FOR UPDATE NOWAIT` on PostgreSQL, followed by owner update before callback; release on commit/rollback, process death, or lost PG connection | Deterministic winner/loser, rollback of partial DB changes | Live callback survives connection loss; indefinite pause holds lock beyond Job lease; SMTP survives rollback |
| Durable conditional lease | One conditional `UPDATE` changes exactly one row and commits owner/generation/deadline before callback; expires at deadline or superseding generation | Restart-persistent ownership, exact-generation DB writes reject stale A | Expiry/recovery cannot revoke the sender's external capability |

The prototype uses **actual SQL predicates and affected-row counts**, not the
public `table.where(...).update(...)` read-then-write behavior. Production would
need a supported runtime primitive. A generation must remain bound to every
protected mutation; reconnecting and writing by ID would bypass that fence.
The two shapes are rejected as complete external contracts; neither is selected
for downstream implementation. A future DB-only scope may favor runtime-owned
transactions, but that is not permission to start ticket 02 now.

## Recorded contract and state transitions

There is **no implementable public API selected** that meets all requirements for
ordinary SMTP. Accordingly this is a blocked contract, not a signature that 02 or
06 may fill in with guessed semantics. The experimental RPC operations (`begin`,
`lease`, `check`, `submit`, `mutate`, `commit`, `rollback`) are defined in
`experiments/issue52-external-contract/worker.mjs` and never exported to Capsules.

The required future contract, if a participating acceptance authority is selected,
must settle these rules before the gate can open:

| State/event | Required transition and observation |
| --- | --- |
| Awaiting authority | No callback or protected read/write. Bind Capsule/resource, existing execution actor, Job ID and exact attempt claim. B cannot enter A's protected DB interval. |
| Acquired | Linearize authority before first write and re-evaluate current resource/Team authorization. Enqueue provenance never substitutes for execution actor. |
| Authorized callback | Expose only capabilities bound to this generation, actor and lifetime. Every DB write must be scoped or conditional; callbacks cannot elevate themselves by naming a resource. |
| Handoff pending | One immutable operation identity and payload binding. Last client-side check alone cannot authorize acceptance. Receiver must order transfer/revocation and generation-conditional acceptance together. |
| Accepted | Acceptance receipt belongs to the same operation/generation; later DB failure cannot undo it. Do not label accepted mail rolled back. |
| Reply missing | Enter `uncertain`, not `not-sent`. Automatic blind resend is unsafe. Reconcile through receiver-owned durable status/idempotency or retain unresolved state. |
| Ownership lost, cancelled, callback settled, or deadline reached | Revoke captured DB/context capabilities before allowing takeover; escaped handles and late continuations reject. For external effects, receiver fencing or proven effect quiescence is additionally necessary. |
| Recover/restart | New process gets no inherited authority. Transfer only after the old generation cannot be accepted; crashed-versus-paused inference from a timeout is insufficient. Persist operation outcomes and uncertainty across restart. |
| Retry | New attempt reauthorizes under the existing execution actor and current resource state. Stable external operation identity survives retries; receiver-specific resolution cannot be invented from Job success/failure. |

**Operation eligibility:** database reads, writes, pending ACL work, transaction
logs, and Job enqueues can only belong to a future proven DB scope as in ADR-0045.
Mail/provider requests, File writes, messages, arbitrary sockets/fetch, and nested
privilege/lifecycle transitions cannot be advertised as rollback-safe members of
that scope. Merely withholding these methods cannot stop previously captured
provider functions or arbitrary Capsule I/O. Escaped-capability rejection for DB
handles is feasible; the corresponding ordinary SMTP guarantee is unresolved.
These are design obligations, not new runtime behavior or conformance claims.

**Actor authorization:** preserve the historical Job Auth/credential provenance
and existing Privileged path. Check current resource authorization inside the
protected boundary; ACL, membership, and revocation transitions must share that
resource ordering. The experiment has fixture labels A/B, not authenticated users;
it does not prove production actor authorization or propose an actor override.

## Time bounds and Job lease interaction

At base `6570a7ba`, `src/server-runtime-source.ts:2207` sets
`RUNTIME_CLAIM_LEASE_MS = 30_000`. Ordinary claim acquisition at lines 7265–7277
stores a fixed deadline and claim token. The ordinary invocation at lines
7324–7339 has no lease-renewal loop. Recovery at lines 2010–2085 conditionally
releases expired claims; final Job settlement at lines 7347–7356 checks the token.
That guards queue settlement, not arbitrary handler side effects.

Any future scope must use the **remaining** budget measured from the original Job
claim: `acquisition wait + execution + draining/commit <= leaseExpiresAt - now`,
with conservative clock/communication allowances specified by the design. Giving
a callback a fresh 30 seconds after waiting is invalid. If the remaining safe
budget is insufficient, do not enter the callback. Renewal would require its own
proven protocol and is absent here. A wall-clock deadline and cancellation can
bound cooperative work, but cannot establish a maximum pause or SMTP uncertainty
interval; therefore no finite budget makes the rejected design safe. The existing
30-second atomic Stripe watchdog must not be generalized to provider calls.

The experiment advances an explicit logical clock from 0 to 30001ms for durable
lease tests; it does not sleep 30 seconds or claim to run the ordinary Job scheduler
in those tests. Held-transaction expiry records that an independently declared
expired Job budget cannot itself release a live engine lock. Existing Job lease,
queue, and PostgreSQL restart tests are reported separately.

## Destination participation and deployment support

To open the gate under this failure model, the **authority that actually accepts
the protected external effect must participate**, or an alternative must prove
old-owner and in-flight-effect quiescence before transfer. An ordinary external
SMTP server does not provide this protocol. SQLite, PostgreSQL, a single worker,
a durable outbox, or a local SMTP proxy alone does not add it.

A possible future deployment is a controlled acceptance service that durably
orders generation transfer, actor/resource revocation, idempotent operation
acceptance and status lookup. It must reject stale A even when B has not yet
submitted any message; a highest-token-seen-on-send check is not enough. If the
service then forwards to another ordinary SMTP server, its queue acceptance is a
different boundary from downstream SMTP acceptance. Selecting that boundary would
need explicit approval if it changes the parent promise. This task has not built,
proven, or approved such a service. libSQL support is also not established here.

## Gate and follow-up

Unresolved requirement: recover resource authority without permanent deadlock
while ensuring a live stale owner cannot submit after loss, across ordinary SMTP
acceptance and uncertain replies. A proven participating design or an explicitly
approved contract amendment is required. Until then, keep ticket 01's API/proof
checkboxes and PR #53's completion checkbox open, preserve all dependent blockers,
and leave #52 unchanged. The negative experiment and ADR are complete deliverables;
the parent implementation contract is not complete.

Protocol reference: [RFC 5321 §§4.2.5 and 6.1](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.2.5)
describes receiver responsibility after DATA and duplicate-message risks when
responses are lost. The runtime observations above are local experimental evidence,
not inferred from the RFC.
