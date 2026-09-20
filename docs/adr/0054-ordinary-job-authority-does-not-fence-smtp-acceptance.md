# Ordinary Job authority does not fence SMTP acceptance

Date: 2026-09-18. Status: **M1 approved by maintainer; ticket 02 SQLite implementation; downstream tickets pending**.
Part of [#52](https://github.com/mgscox/sporades/issues/52),
[ticket 01](https://github.com/mgscox/sporades/blob/codex/issue-52-resource-fence-tickets/.scratch/ordinary-job-resource-fences/issues/01-prove-external-side-effect-contract.md).

## Ticket 01 decision (retained historical evidence)

The following finding and blocked-state contract record ticket 01 before M1
approval. The approved decision below supersedes its dispatch gate and delivery
policy, not its negative SMTP evidence.

Do not expose the proposed general resource transaction with an ordinary SMTP
handoff guarantee. Neither a transaction held around the call nor a durable
conditional-update lease satisfies the parent contract under recoverable
ownership loss and a resumable owner. The experiment demonstrates counterexamples
on real SQLite and PostgreSQL storage with independent child processes and a
controlled loopback SMTP receiver. **At that point tickets 02–07 remained blocked.**
No contract amendment had then been approved, and database-only fencing or rejecting SMTP does not
complete the parent. No production API, generated contract, or runtime behavior
changes in this decision.

This is an impossibility result for the stated failure model and nonparticipating
ordinary SMTP destination, not a claim that all distributed handoff designs are
impossible. See the [pinned experiment and evidence](https://github.com/mgscox/sporades/blob/38b6103b3830ac6293f620eee9677152c3c84b9e/experiments/issue52-external-contract/README.md). The experiment remains in draft PR #54; this planning branch does not copy or rerun it.

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
The two shapes are rejected as complete external contracts; neither was selected
by ticket 01 for downstream implementation. The proposal below selects a
runtime-owned transaction under the subsequently approved explicit amendment;
ticket 01 evidence alone did not authorize starting ticket 02.

## Recorded contract and state transitions

There is **no implementable public API** that meets all unchanged requirements for
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

## Historical gate before M1 approval

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


## Approved decision after ticket 01

**Select A: a runtime-owned resource transaction plus durable notification
intent under maintainer-approved amendment M1 below. Neither A nor B satisfies
the unchanged ordinary-SMTP case.** A keeps multi-row writes, ACL work, Job enqueues,
intent acceptance and retry receipts in one engine commit. B is useful for a
single-row optimistic revision/claim, but would leave each Capsule to implement
multi-row recovery and still cannot fence SMTP. Do not add public CAS in this plan.
This is an implementable specification, not an implementation or new proof.

All source locations in this matrix refer to base `6570a7ba`, not installed 0.9.22.
The evidence refers to commit `38b6103b3830ac6293f620eee9677152c3c84b9e`.

| Question / deciding evidence | A: transaction / locking scope | B: first-class CAS / conditional update |
| --- | --- | --- |
| Ordinary handler directly awaited at `src/server-runtime-source.ts:7324–7339`; `privileged.run` directly awaits callback at `:2432` without a transaction | Adds the missing engine boundary; Privileged execution alone is no substitute | Adds an atomic statement, not a transaction around the callback; Privileged execution adds neither |
| `RUNTIME_CLAIM_LEASE_MS = 30_000` at `:2207`, fixed claim at `:7264–7277`, no renewal loop at `:7324–7339` | Use remaining original lease for admission; engine lock, not timer, governs transfer; paused transaction can delay recovery | Expiring generation permits takeover, but paused sender remains live; permanent claim instead prevents guaranteed recovery |
| Settlement token predicate at `:7354` | Protects Job settlement only; transaction must separately bind scoped DB capabilities | Every protected DB mutation needs the exact generation predicate; settlement check is insufficient |
| Table `update` selects by ID at `:4604` then calls `updateAppRow` at `:4592`; `.where` only builds a query at `:4629–4630` | Bind table operations to the transaction; filtered public update is not a fence | Would require a new atomic predicate + affected-row-count contract, not a wrapper around existing update |
| PG trace sequences 233–247: A checked, backend terminated, B accepted at 240, resumed A accepted at 245, A DB write rejected at 247 | Refutes SMTP fencing even with a held engine transaction | Expiry traces: SQLite B/A accepted at sequences 42/46, stale write rejected at 48; PG 148/152/154 shows the same failure |
| Ticket-01 accepted/lost-reply and no-acceptance twins; same Message-ID retry accepted twice | Rollback cannot undo acceptance or disambiguate it | An idempotency row in our DB cannot deduplicate acceptance at a nonparticipating receiver |
| Narrower supported use | Serialize same-resource multi-row database work and durably accept an intent in that commit; preferred under M1 | Optimistic single-row revision, atomic claim/release with generation, or a destination that actually participates; not selected here |

### M1 — explicit parent amendment approved on 2026-09-18

**Approved by Matt on 2026-09-18**, with automatic retry of uncertain email
submission and acceptance of duplicate/stale email risk. See the
[maintainer approval record](https://github.com/mgscox/sporades/pull/61/files#diff-3b0a007b65246750e4f990cbf547dd0eab0775a3f4d579c878dce485cb023ba5).
The GitHub issue text remains unchanged and open; this explicitly recorded
amendment replaces its first two acceptance criteria for this implementation:

> An ordinary Job can acquire exclusive database authority before its protected
> writes and hold it through atomic commit of those writes and a durable
> notification intent. Recovery must reject stale database writes and stale intent
> acceptance. Later SMTP submission/acceptance is outside this resource authority;
> revocation after intent commit need not prevent the accepted intent being sent.
> Restart must recover engine authority without a permanent application claim.
> Ambiguous commit and delivery outcomes remain durable and are not called rollback.
> Retry uncertain SMTP submissions automatically, accepting duplicate emails rather
> than suppressing a potentially unsent notification.

The remaining parent criteria (deterministic competition, documented adapters,
Job lifecycle interaction, non-opt-in compatibility) remain requirements, applied
to this amended boundary. This explicitly drops **no stale SMTP send after loss**
and **authority until the external side effect completes**. Intent acceptance is
not SMTP acceptance. It cannot be used to claim the original criteria passed.

Trade-off: useful atomic notification preparation and retry deduplication become
possible without a participating SMTP receiver, but an already accepted intent may
send after Grant rotation/revocation. Message contents may therefore disclose old
information. The Grant application must validate current authority on link use;
that does not retract a message or cure disclosure. Uncertain or transient SMTP
outcomes are retried automatically; the receiver may accept the same email more
than once, including from an old paused sender. This is an at-least-once retry
policy, not exactly-once delivery or a guarantee that an unavailable/rejecting
provider will eventually deliver. Known permanent rejection remains visible and
requires correction; uncertainty alone never permanently suppresses retry.

The maintainer accepted the outbox boundary and clarified that Jobs retain their
historical actor/credential provenance, not a frozen database snapshot. Current
Grant/ACL checks still occur at resource acquisition. On 2026-09-18 he explicitly
requested resend on uncertainty; the approval record quotes that instruction.
This replaces the draft's no-automatic-resend policy. Ticket 01's amendment gate
is now cleared; the unchanged SMTP guarantee is still disproved. Approval does
not implement the feature, merge this PR, or close #52.

### API and eligibility under approved M1

Server-only proposed API, not a declaration of an existing exported surface:

```ts
const result = await ctx.resources.run({
  resource: { table: "CustomerAccessGrant", id: grantId },
  operationId: payload.operationId,
  input: payload,
}, async (scope) => {
  const grant = await scope.db.CustomerAccessGrant.where("id", grantId).get();
  // Read and validate current Grant state here; naming a row grants no authority.
  await scope.db.CustomerAccessGrant.update(grantId, preparedChanges);
  await scope.notifications.accept({
    id: "link", to: [recipient], subject: "Your access link", text: body,
  });
  return { prepared: true };
});
```

- `run<T extends JsonValue>(options, callback): Promise<T>`; required options are
  `resource: {table: string, id: string}`, `operationId: string`, `input: JsonValue`.
  Table must be a declared app table, ID an existing anchor row. Canonical identity
  is `(Capsule database identity, table, id)`, never actor-specific. Table/ID and
  operation ID are nonempty UTF-8 strings, at most 128 bytes each; input/result
  at most 64 KiB canonical JSON each. No caller-controlled lease, actor or token.
  Resource creation needs a pre-existing anchor; multi-resource scopes are out of
  v1. Do not log identifiers, inputs, results, recipients or bodies.
- Ordinary Jobs may call `run` once, before any application DB or provider operation
  in that invocation; enforce at runtime. Mutations/Custom endpoints may call once
  as their first application DB operation and join their existing transaction.
  No nested scopes, nested dispatch, nested `privileged.run`, Files, provider calls,
  publish/messages, arbitrary network operations or lifecycle transitions are
  supported in a scope. Existing Privileged Job execution may enter with its
  existing audited actor; the scope cannot create Privileged authority.
- Scope exposes transaction-bound DB operations with normal current ACL/Team
  checks, transactional Job enqueue, buffered transaction logs, `signal`, and
  `notifications.accept`. Notification shape is `{id, to, subject, text, html?}`:
  ID 1–128 UTF-8 bytes, 1–100 validated recipient addresses, total canonical JSON
  at most 64 KiB, at least one nonempty text/html body. Use configured mail sender
  and existing mail permission/address validation; no arbitrary transport/credentials.
- `accept` stages an immutable intent and returns `{id, state: "staged"}`; no socket
  opens here. Stable intent identity is `(resource, operationId, notification id)`.
  Duplicate identical payload in the same operation returns the same staged ID;
  differing payload fails `RESOURCE_OPERATION_CONFLICT`. The intent only becomes
  `accepted` on the owning engine commit. Outer rollback removes it.
- Parent/retained context DB handles, Privileged projections and detached tasks
  must check invocation/scope lifetime and use only the bound transaction connection
  while active; reject reentry through a root adapter. Drain admitted DB/ACL/log
  work, close admission when callback returns, then commit. Late handles reject
  `RESOURCE_SCOPE_INACTIVE`, including after connection loss; never reconnect them.
  Nontransactional provider APIs reject `RESOURCE_EFFECT_UNSUPPORTED` in this scope.
  Arbitrary JS I/O cannot be sandboxed by this API and has no fencing guarantee.
- On entry, check current read/write authorization on the anchor under the captured
  execution actor/credential (not enqueue actor), then retain current per-operation
  ACL checks. Denied/missing anchor uses existing opaque authorization errors.
  A receipt belongs to that actor and Privileged mode; another actor cannot read or
  reuse it. Application authority transitions must use the same named resource.
  Runtime authorization rows used to grant access must be read under locks that
  conflict with their update/deletion through commit (SQLite writer lock; PG row
  locks). Check again after lock acquisition; no cached pre-acquisition authorization.

### Isolation, receipt, and recovery algorithm

1. Fail unsupported adapter/context/shape before callback or application writes.
   Acquire engine transaction authority and the canonical resource lock, then
   lock/check the exact Job row if in a Job. PG lock order is resource, Job row,
   authorization rows, then application writes; no second resource is allowed.
   Lock conflict is immediate `RESOURCE_BUSY` (no callback, no partial commit);
   callers use existing Job retry/backoff, not a hidden callback replay.
2. On entry and precommit require the same running Job ID/claim token, no committed
   cancellation, and time strictly before its stored deadline. No renewal. Use the
   existing runtime clock for the original 30,000ms claim; do not allocate a fresh
   lease on resource acquisition. At entry reserve 1,000ms for drain/precommit:
   refuse entry when remaining time is at most 1,000ms; stop admitting DB operations
   at `leaseExpiresAt - 1,000ms`. Drain and recheck before commit. This reserve is
   operational headroom, not proof of a maximum OS pause or commit duration.
3. In that transaction, read runtime-owned receipt keyed by
   `(Capsule, resource, operationId)`. Bind canonical input digest (SHA-256), actor,
   Privileged mode, JSON result and intent IDs. Same key and same binding returns
   recorded result without callback; mismatch fails `RESOURCE_OPERATION_CONFLICT`.
   Current authorization and claim checks still apply on replay. Write receipt,
   intents and protected application changes atomically on first execution.
   Retain receipt and deduplication tombstones indefinitely in v1; no automatic
   pruning or deleting the resource lock row. Payload retention can be reduced
   without deleting identity/digest/result needed for replay. This is a storage cost.
4. SQLite uses a dedicated `BEGIN IMMEDIATE` transaction and immediate busy failure;
   it serializes writers across the entire database, not just this resource. PG
   uses a dedicated connection at READ COMMITTED, a runtime-owned unique resource
   row locked `FOR UPDATE NOWAIT`, and the Job row `FOR UPDATE NOWAIT`. Initial lock
   row creation must handle unique-key contention without waiting (bounded server
   lock timeout, reported as `RESOURCE_BUSY`). Resource-schema readiness and any
   required publication run on a separate bootstrap connection, never on the
   primary connection that may own an unrelated root transaction. All protected reads follow acquisition.
   Only writers using this protocol receive same-resource serial ordering; existing
   ordinary table updates do not magically participate. No global serializable
   snapshot or parallel throughput promise is added. Constraint/deadlock/connection
   errors roll back; never automatically rerun a callback. Constraint and
   pre-COMMIT connection diagnostics from dedicated Job connections, tracked
   outer scoped Database operations, and runtime-owned receipt statements are
   reported only as the fixed `RESOURCE_STORAGE_ERROR`, including to a callback
   which awaits and catches a tracked scoped operation; deliberate callback
   errors and the separate unknown COMMIT outcome retain their own identities.
5. Engine commit/rollback or engine-confirmed connection/process death releases
   authority. There is no durable resource lease to expire or reset on restart.
   Receipt rows are outcomes, not locks. PG backend loss invalidates all old scoped
   handles; SQLite process death releases its writer. A timer alone never releases
   an engine lock. A live stopped SQLite process may delay recovery until resumed
   or terminated; no bounded recovery from arbitrary OS suspension is promised.
6. Job lease recovery/cancel updates conflict on the locked Job row (SQLite writer
   exclusion supplies the equivalent). If recovery/cancel commits first, scope
   entry/precommit fails; if scope's commit decision wins, recovery/cancel waits
   for engine release and cannot undo the committed intent. Expiry is eligibility
   for recovery, not evidence the engine lock disappeared. An admitted COMMIT may
   finish after the deadline; takeover remains excluded until its engine outcome.
   Runtime must not release a connection to a pool with COMMIT in flight.
7. At the deadline a runtime watchdog closes admission, invalidates handles and
   requests engine rollback even if the callback has not settled; an OS-stopped
   process cannot run this watchdog, so it is not a bounded recovery proof. On
   callback failure or cancellation observed before commit, do the same. On graceful shutdown drain or
   roll back; on hard death use engine recovery. On unknown COMMIT acknowledgement,
   invalidate the connection and report `RESOURCE_COMMIT_UNKNOWN`; do not claim
   rollback. A new attempt acquires the same lock and checks the receipt. A present
   receipt means committed; absence **after acquisition** proves no old transaction
   can still commit. Retry uses the same operation ID/input and a new Job claim.
   The outer handler may fail after a successful scope; receipt replay prevents
   duplicate protected writes/intent on retry. Job success alone is not mail success.
8. For mutations/endpoints the receipt, intent and all protected writes join the
   outer transaction. The callback result is provisional until outer commit; the
   resource lock remains held after callback return. Close scoped handles then,
   and reject further application DB/provider calls outside the scope in that
   invocation. Outer rollback removes staged state. For non-Job contexts apply a
   30,000ms budget from outer transaction start with the same 1,000ms admission
   reserve. `resources.status({resource, operationId})` performs an authorized
   receipt read through the resource lock, returning committed result/intent IDs
   or `absent`; busy/denied remain errors. It does not run an application callback.
   PostgreSQL marks the outer transaction failed when `NOWAIT` acquisition loses;
   even if the handler catches `RESOURCE_BUSY`, settlement must roll back and
   surface that error rather than accept PostgreSQL's `COMMIT`-as-`ROLLBACK`
   response as success.

The v1 resource adapter matrix is explicit: SQLite is supported, PostgreSQL is
supported, and libSQL is **unsupported**. libSQL `run` and `status` return
`RESOURCE_ADAPTER_UNSUPPORTED` before callback execution, receipt lookup,
application or intent writes, or network submission. No local mutex, autocommit
or lease fallback exists. Future libSQL support requires a separate approved
proposal and real representative remote transaction expiry, connection loss, and
restart conformance. This rejection gate does not certify libSQL support, and
support is not an optional implementation choice for ticket 05. Non-opt-in APIs keep existing
semantics on all adapters. No public CAS or lease-renewal API is required. Lock/deadlock failure is
`RESOURCE_BUSY`; insufficient/exhausted budget is `RESOURCE_DEADLINE_EXCEEDED`;
lost/superseded Job ownership is `RESOURCE_CLAIM_LOST`. Committed cancellation
uses the existing Job cancellation outcome; unsupported context/nesting/entry
is `RESOURCE_CONTEXT_UNSUPPORTED`. All errors are bounded and omit resource values.

### Durable intent delivery contract for revised ticket 06

The acceptance authority is the same engine commit as application state. A
post-commit worker sends accepted intents through configured SMTP **outside** the
resource transaction. Durable scanning is authoritative; wakeups are optimizations.
Source Job retry/cancel and Grant revocation do not retract committed intent.
The source operation receipt remains `committed` regardless of delivery outcome.

**Automatically retry uncertainty, accepting duplicates.** Keep the original
immutable intent, payload and stable Message-ID across attempts. Deduplicating
intent creation prevents repeated preparation; it does not deduplicate SMTP.
The runtime owns retry scheduling; disable hidden transport auto-retries so every
attempt has a durable record. No new source Job operation or current Grant
reauthorization is needed to deliver an already accepted intent.

1. Track each recipient separately and use one SMTP envelope per recipient in v1.
   This makes partial-recipient rejection explicit; do not resend to a recipient
   already acknowledged merely because another recipient failed. Each recipient
   has `accepted`, `submitting`, `unknown`, `retry-wait`, `acknowledged` or `rejected`
   state, attempt count, current attempt token/deadline and next-attempt timestamp.
   Preserve one bounded recipient-bearing attempt diagnostic (token, sequence,
   times, outcome/error class). A per-intent random MAC key and the recipient's
   monotonic attempt count retain compact proof of earlier issued tokens after
   completed predecessor diagnostics are removed. Never retain credentials or
   raw SMTP replies in diagnostics.
2. A short engine transaction reserves one due recipient and persists a fresh
   random token, incremented sequence and deadline before I/O. Its reservation
   window is `max(30_000ms, connectionTimeoutMs + 12 * socketTimeoutMs)`, using
   the configured transport timeouts. Thus the default 10,000ms connection and
   30,000ms socket timeouts produce a 370,000ms reservation. The twelve-response
   margin covers the bounded SMTP greeting, negotiation, authentication,
   envelope, DATA and final-response reads; the 30,000ms floor preserves the
   minimum crash-recovery window for shorter configurations.
   Only confirmed reservation commit permits that worker to submit. If its commit
   acknowledgement is lost, that worker sends nothing; recovery reads stored
   state and schedules an attempt after any extant reservation expires. Concurrent
   reservations require an atomic state/token predicate and affected-row count.
3. Positive final DATA reply means `acknowledged` (not delivered). SMTP 4xx,
   connection failure, lost reply, timeout, or failed persistence of an observed
   outcome is retryable. Record ambiguous attempts as `unknown`, never `not-sent`.
   A definitive SMTP 5xx or invalid configuration/address is `rejected`, retained
   for operator attention rather than retried unchanged forever. Retain original
   intent/receipt; correction uses an explicitly authorized new operation.
4. On restart, scan pending recipients, preserve live reservations until their
   deadline, and conditionally recover expired reservations as unknown. The
   first delivery pass that observes an expired reservation starts its retry
   delay; an idle worker caps its durable recovery scan sleep at 30,000ms and a
   restart runs a pass immediately, but scheduling delay can make observation
   later than the stored deadline. Schedule retry with delay
   `min(30_000 * 2^(min(n - 1, 7)), 3_600_000)` milliseconds after that recovery
   observation (or after an immediately observed failure), where n is the
   completed/expired attempt number.
   Persist `nextAttemptAt`; no busy-loop, finite retry-count cutoff, or payload
   cleanup may discard retryable work. Poll due rows by nextAttemptAt then stable
   ID and reserve conditionally so multiple workers cannot allocate the same
   generation. Backoff caps at one hour; retryable work survives arbitrary restarts.
5. A late **positive** acknowledgement from any durably issued attempt token
   for that exact immutable recipient/intent marks the recipient acknowledged and
   suppresses future reservations. The token's keyed authenticator binds the exact
   intent, recipient, sequence and Message-ID; the durable recipient attempt count
   proves that sequence was issued even after its completed diagnostic is compacted.
   Positive acknowledgement is monotonic. Late
   negative/unknown outcomes may append attempt evidence but cannot overwrite a
   newer attempt's state or regress acknowledgement. Current-token predicates
   govern failure/retry transitions. Only runtime-owned sender reports are trusted.
6. Expiry permits a new sender; it cannot revoke an old sender or its in-flight
   SMTP bytes. Try cooperative abort and perform a current-reservation check
   before I/O, but do not call either a fence. A resumed sender or lost reply can
   cause duplicate acceptance. If a late acknowledgement arrives after another
   submission has begun, that second email may still arrive. This is an accepted
   consequence of prioritizing resend over possible omission.
7. `resources.status` exposes per-recipient state, attempt count, nextAttemptAt
   and redacted last-outcome category, plus aggregate intent state: `pending` while
   any recipient is retryable/submitting, `acknowledged` when all are acknowledged,
   otherwise `rejected` when all are terminal and at least one was rejected.
   Permanent recipient failures remain visible even while others are pending.
   A process crash after reserving but before sending recovers into retry, not a
   permanently unsent intent. A crash after SMTP acceptance can produce a duplicate.

SQLite and PostgreSQL must implement this same reservation/recovery contract.
Delivery retries use their own durable schedule and are not exhausted by the
source Job's retry limit. Keep unresolved payloads and compact durable attempt
authentication state for recovery; no retention rule may remove pending work.
Successful delivery policy
means acknowledged SMTP submission, not inbox receipt or message reading. No
claim of exactly-once or unconditional eventual delivery is made.

### Revised dispatch gate

See the [revised plan](https://github.com/mgscox/sporades/pull/61/files#diff-e6f0d5bf3690b911004d52e84be6019c33acb4517a07de3ccad01765fbd39cf5) and
[approval record](https://github.com/mgscox/sporades/pull/61/files#diff-3b0a007b65246750e4f990cbf547dd0eab0775a3f4d579c878dce485cb023ba5).
**M1 is approved; ticket 01's amended-contract gate is cleared and ticket 02 is
ready for implementation.** Tickets 03–06 depend on 02, and 07 on all four.
The implementation is not started by this planning update. 02–05 can implement
the amended DB boundary without solving ordinary SMTP fencing; 06 implements
durable intent delivery with automatic retry and accepted duplicates. Strict SMTP
fencing and public CAS remain outside this approved plan. #52 stays open until
implementation and validation against the amended contract are complete.

### Ticket 02 implementation decisions and corrections

The API above specifies the completed seven-ticket contract. The frontier is
staged: ticket 02 implements ordinary Jobs on file-backed SQLite; ticket 03 owns
mutation/Custom endpoint joining, and 06 owns intent staging. Until those tickets,
other contexts reject `RESOURCE_CONTEXT_UNSUPPORTED` and `notifications.accept`
rejects `RESOURCE_EFFECT_UNSUPPORTED`. This resolves the ticket-02 checklist's
"exact ADR API" wording versus the explicit 03/06 ownership: exposing incomplete
outer-transaction or intent behavior would be unsafe and would start those tickets.
No SMTP or other notification transport is included here. In-memory SQLite is
unsupported because an independent connection would address a different database.

The requirement to reject arbitrary network I/O cannot be a runtime enforcement
claim: Capsule JavaScript can import Node sockets or a provider client without
using `ctx`. This API guards framework context capabilities and documents arbitrary
I/O as forbidden application behavior, with no sandbox/fencing guarantee. The
same limitation applies to detecting a prior independently imported provider call.
This clarifies the already stated JavaScript limitation instead of pretending
that withholding `scope.mail` revokes an unrelated function.

V1 decisions are fixed in the [canonical reference](../reference/jobs-and-schedules.md#sqlite-resource-transactions-ticket-02):
128-byte well-formed UTF-8 identities; 65,536-byte canonical input/result; maximum
JSON nesting 64; complete captured Auth/Credential plus Privileged-mode actor
binding; once-per-invocation status/run; fixed redacted errors; immediate busy
Error `{code: "RESOURCE_BUSY", retryable: true}`. SQLite receipts are stored in
`sporades_resource_receipts`, created lazily, keyed by table/ID/operation within
the retained database, with input/actor SHA-256, canonical result, intent IDs and
commit time. A receipt is its own indefinitely retained replay tombstone. No
SQLite resource-lock row or resource lease exists to delete/reset on restart.
Logs buffer at most 100 payload-free severity events, stage their index rows
in the receipt transaction, and publish the JSONL copy after commit;
identifiers, inputs, results and message payloads are never included by this API.

The phrase "recovery/cancel waits for engine release" describes the ordering
boundary, not a promise that every existing SQLite caller blocks. Independent
ordinary SQLite connections use immediate busy failure; a cancellation attempted
while a resource writer holds authority returns SQLite busy without committing
its marker. Its caller must retry after release. The same-runtime connection
gate queues independent root operations behind an acquired resource (up to the
29-second transaction wait budget), but resource acquisition itself immediately
returns `RESOURCE_BUSY` when that gate is occupied. Automatically replaying an entire
mutation/endpoint callback to hide `SQLITE_BUSY_SNAPSHOT` would violate the
no-hidden-callback-replay contract and change non-opt-in behavior. Ticket 02
therefore preserves this explicit failure and proves cancellation after release
cannot undo a committed receipt. Recovery's existing retry timer likewise cannot
transfer ownership while the engine excludes its conditional update. No expiry,
cancellation signal, or startup path forcibly drops an engine lock.
