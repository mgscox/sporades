# Privileged Server Role

Status: ready-for-agent

## Source Planning

- `docs/ROADMAP.md` (Recommended Next Features: "Privileged server role")
- `docs/PRD.md`
- `CONTEXT.md`
- `docs/adr/0022-acl-rules-are-runtime-policy-functions.md`
- `docs/adr/0026-database-writes-use-intended-transaction-boundaries.md`
- `docs/adr/0027-capsule-roles-and-privileged-server-role-are-separate.md`
- `.scratch/privileged-audit-event-contract/PRD.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/08-add-job-queue.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/09-add-job-scheduling.md`

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to reflect the implementation status, per the roadmap Promotion Rule.

## Problem Statement

Sporades needs a clear actor for trusted system-owned execution that runs
inside a Capsule but does not run as a Sporades user. Today there is no first
class way to express that authority. Capsule authors can use `ctx.auth` for the
current user, and Capsule-specific admin behavior can be modelled as Capsule
roles through normal ACL rules, but future system-owned work still needs a
non-user execution actor.

That gap matters because future Job queue and Job scheduling work needs a clear
actor model. Some Jobs should run as a captured Sporades user identity, while
system-owned or recurring Jobs may need to run when no live user session exists.
Without an explicit Privileged server role, scheduled work risks becoming
ambiguous: either pretending to be the last user who touched it, bypassing
normal actor semantics through hidden runtime internals, or being confused with
a browser-visible Capsule admin concept.

Sporades has already implemented the Privileged audit event contract, so the
remaining problem is to define a narrow server-only authority that Capsule code
can request through explicit APIs, that never appears as a user/session/team
member/browser credential, and that is always visible through privileged audit
events.

## Solution

Add a Privileged server role to `sporades/server`: a server-only authority for
trusted system-owned execution that intentionally runs without a Sporades user
identity. The role is not a Capsule role, app admin, user, session, team member,
service account, or client credential. It is an auditable runtime capability
that can be invoked only from explicit server-code APIs.

The first implementation should focus on the smallest useful boundary:

- a context-scoped server-code API, conceptually `ctx.privileged.run(...)`,
  that runs a callback or operation with a derived privileged handler context
  while preserving the surrounding handler's transaction, correlation, and audit
  context;
- an execution context that makes actor semantics explicit: current user,
  captured user, or Privileged server role;
- privileged access methods for the specific Capsule DB/file/storage operations
  needed by system-owned execution in this slice;
- mandatory Privileged audit events for start, completion, and error;
- error behavior that stays opaque to clients but detailed enough in
  structured server logs and audit metadata for operators and agents.

The design should follow the precedent of server-admin SDKs in other platforms:
privileged authority is available only in trusted server code, never in browser
bundles, and only through APIs that make elevated behavior obvious at the call
site. Sporades should not copy another platform's vocabulary if it conflicts
with the existing domain language.

## User Stories

1. As a Capsule author, I want a Privileged server role available only from server code, so that trusted operations can run outside normal user rights without exposing authority to the browser.
2. As a Capsule author, I want the Privileged server role to be impossible to obtain from `sporades/client`, so that client code cannot impersonate server authority.
3. As a Capsule author, I want the Privileged server role to be distinct from `ctx.auth`, so that system-owned work is not confused with a real Sporades user session.
4. As a Capsule author, I want privileged execution to be explicit at the call site, so that a future maintainer can see where normal user rights are bypassed.
5. As a Capsule author, I want the privileged API to work in queries, mutations, Custom endpoints, App messages, context middleware, and lifecycle hooks where supported, so that trusted operations have consistent semantics across server surfaces.
6. As a Capsule author, I want the privileged API to expose only approved Capsule DB/file/storage capabilities, so that system-owned execution does not become a raw escape hatch into every internal table.
7. As a Capsule author, I want Capsule admin authorization to use Capsule roles and normal ACL rules, so that app admins are not confused with system-owned execution.
8. As a Capsule author, I want privileged runtime inspection to remain out of the first slice, so that reading auth, system metadata, file metadata, log index, or other runtime-owned resources is not smuggled in under the admin label.
9. As a Capsule author, I want privileged file operations to preserve storage adapter boundaries, so that local file storage, MinIO-backed S3-compatible storage, and future storage adapters share the same contract.
10. As a Capsule author, I want privileged database operations to preserve Database adapter boundaries, so that SQLite, libSQL, Postgres, and future adapters stay below the same runtime-owned API.
11. As a Capsule author, I want privileged operations to participate in the intended Transaction boundary for the surrounding workflow, so that multi-write behavior remains predictable.
12. As a Capsule author, I want privileged operations inside a mutation to commit or roll back with the mutation where the operation changes Capsule data, so that elevated writes cannot partially escape a failed user-visible action.
13. As a Capsule author, I want privileged operations outside mutations to avoid implying an automatic Transaction boundary, so that system-owned work does not claim atomicity Sporades cannot provide.
14. As a Capsule author, I want privileged operations to return typed, structured errors, so that server code can handle errored elevated work without parsing log text.
15. As a Capsule author, I want public error messages to stay opaque, so that privileged runtime internals do not leak to clients.
16. As a Capsule author, I want server-side logs to include enough structured detail to debug privileged errors, so that I can fix configuration or code without exposing those details publicly.
17. As a Capsule author, I want TypeScript to prevent importing privileged APIs into browser code, so that misuse is caught before runtime.
18. As a Capsule author, I want docs to show when to use the current user, a captured user identity, or the Privileged server role, so that Jobs and server handlers choose the right actor intentionally.
19. As a Capsule author, I want privileged execution to be unavailable from ACL rule evaluation, so that ACL policy helpers remain constrained and read-only.
20. As a Capsule author, I want the Privileged server role to avoid names like root, admin user, superuser account, service account, or Capsule role, so that the feature stays aligned with the repo glossary.
21. As a Capsule operator, I want every privileged run to emit a started Privileged audit event before the callback executes, so that attempted system-owned execution is visible even if the callback crashes.
22. As a Capsule operator, I want every callback-returned privileged run to emit a completed Privileged audit event, so that completed system-owned execution is visible without implying business success.
23. As a Capsule operator, I want every throwing or rejecting privileged run to emit an errored Privileged audit event, so that errored system-owned execution is visible without implying business failure.
24. As a Capsule operator, I want the privileged run wrapper to use try/catch/finally around the callback, so that errors emit audit evidence and every run emits a finished close marker before propagating structured errors.
25. As a Capsule operator, I want audit events to include actor kind `privileged-server-role`, so that privileged activity is distinguishable from platform activity and captured-user activity.
26. As a Capsule operator, I want audit events to include the server-code surface that started privileged execution, so that I can trace where the privileged operation came from.
27. As a Capsule operator, I want audit events to include operation, target resource kind, outcome, safe error code, and bounded metadata, so that incident review is useful without leaking secrets.
28. As a Capsule operator, I want audit events to include request, Job, scheduled Job, or correlation identity when available, so that privileged activity can be connected to surrounding logs.
29. As a Capsule operator, I want audit metadata to redact tokens, cookies, Server env values, raw request bodies, public/private keys, and raw stack traces, so that logs do not become a secret store.
30. As a Capsule operator, I want privileged audit events to appear through existing log inspection surfaces, so that I do not need a dashboard or new audit database to review them.
31. As a security officer, I want to prove that browser credentials cannot carry privileged authority, so that client compromise does not imply privileged server access.
32. As a security officer, I want to prove that ordinary `ctx.log` calls cannot forge privileged audit events, so that audit evidence remains platform-owned.
33. As a security officer, I want privileged APIs to be enumerable and documented, so that the elevated attack surface can be reviewed.
34. As a security officer, I want privileged operations to have stable operation names, so that alerting and incident timelines are not broken by cosmetic wording changes.
35. As a security officer, I want to distinguish user-originated privileged work from system-originated privileged work, so that accountability is not flattened into one generic server actor.
36. As an AFK agent, I want privileged behavior to be machine-verifiable through JSON logs and structured results, so that I can validate the feature without scraping human output.
37. As an AFK agent, I want tests to cover generated runtime bundles, so that Dev sessions, Container sessions, and Hosted Capsules do not drift on privileged behavior.
38. As a maintainer, I want the privileged implementation to reuse the existing Privileged audit event envelope, so that this feature does not invent a second security log shape.
39. As a maintainer, I want the privileged implementation to reuse existing handler/context seams, so that the feature does not introduce a parallel runtime execution model.
40. As a maintainer, I want unsupported privileged access to fail closed with stable errors, so that future expansion happens deliberately.
41. As a maintainer, I want this feature to unblock Job Queue and Job scheduling actor decisions without implementing those systems, so that dependency order stays clear.
42. As a maintainer, I want recurring Jobs to be able to declare Privileged server role execution later, so that scheduled system-owned work has a known userless actor even without a live user session.
43. As a maintainer, I want Jobs to be able to declare captured-user execution later, so that user-owned background work remains accountable to the user who authorized it.
44. As a maintainer, I want docs to state that Privileged server role is not Teams for ACL or Capsule role admin authorization, so that app membership and system-owned execution do not collapse into one feature.
45. As a maintainer, I want roadmap and product docs to reflect the implemented actor boundary, so that future planning does not re-open settled terminology.

## Implementation Decisions

- The feature introduces a Privileged server role as a runtime-owned userless
  execution actor, not as a Capsule role, app admin, user, session, team member,
  service account, browser credential, Host profile, or Host server operator
  identity.
- Capsule admin authorization should be modelled separately as Capsule roles
  checked by normal ACL rules. This feature should not add a global `admin`
  role to runtime-owned Sporades auth users.
- The public server API should make elevation explicit at the call site and
  hang off the current server handler context. A callback-style
  `ctx.privileged.run(...)` API is preferred because it naturally scopes the
  elevated context, preserves runtime correlation and Transaction boundary
  state, and keeps surrounding code under normal user rights.
- `ctx.privileged.run(...)` should be available consistently across trusted
  server surfaces: queries, mutations, Custom endpoints, App messages, context
  middleware, and lifecycle-supported paths. The trust boundary is Capsule
  server code.
- Context middleware may perform an explicit privileged run, but it must not
  turn the downstream handler context privileged. Returning or leaking the
  derived privileged context from middleware should be disallowed; privilege is
  scoped to the callback only.
- Lifecycle hooks may perform explicit privileged runs where the runtime
  provides a server context. Dev-session rebuilds or runtime restarts may cause
  lifecycle hooks to run more than once; each actual privileged run should emit
  its own audit events rather than being suppressed as duplicate noise.
- Shutdown hook privileged work follows the existing shutdown hook guarantees.
  This feature should not add stronger shutdown ordering, waiting, or retry
  semantics. If shutdown privileged work depends on DB, file, storage, or
  Capsule service access, Capsule code is responsible for running it while those
  dependencies are still available.
- Server code that returns privileged data to a browser or external caller is
  responsible for shaping that response safely. The runtime audits privileged
  execution and enforces the explicit privileged boundary; it does not infer
  which callback results are safe to expose.
- When audit emission succeeds and the callback returns, `ctx.privileged.run(...)`
  should return the callback result as-is. The runtime should not inspect,
  sanitize, classify, or redact successful callback return values.
- `ctx.privileged.run(...)` must require operation metadata, with at least a
  stable `operation` name. Target resource details such as `targetResourceKind`
  may be optional or inferred where the runtime can do so safely, but the audit
  event must not fall back to an unhelpful unknown operation for valid API use.
- Required audit metadata must be validated and redacted before `started` audit
  emission so the first audit event uses the final safe fields. If metadata
  validation, redaction, or generation fails, the runtime should throw before
  entering the privileged path: no privileged audit event is emitted, no
  privileged context is handed out, and the callback does not run.
- Metadata generation for `ctx.privileged.run(...)` should be synchronous and
  structural: it uses already-known values supplied in the call options. It must
  not perform async DB, file, storage, network, or service work before `started`.
  Capsule authors who need those facts should gather them before calling the
  privileged run.
- `ctx.privileged.run(...)` should accept a caller-supplied `AbortSignal`, such
  as the signal from an `AbortController`, so surrounding server code, lifecycle
  code, and future Job execution can propagate cancellation deliberately.
  Supporting `AbortSignal` does not add new runtime-owned timeout, retry, or
  cancellation policy; privileged runs inherit the surrounding handler,
  lifecycle, or future Job semantics.
- The derived privileged context should expose the same caller-supplied signal as
  `privilegedCtx.signal` so privileged helper code can pass cancellation deeper
  without capturing outer closure variables.
- If no signal is supplied, the runtime should expose a fresh per-run non-aborted
  default signal as `privilegedCtx.signal`. It should not use a shared long-lived
  default signal that can accumulate listeners across runs, and any runtime-owned
  abort listeners or signal bridges must be cleaned up when the run reaches
  `finished`.
- The derived privileged context should be created and exposed to the callback
  only after `started` audit emission succeeds. If `started` cannot be emitted,
  no privileged context is handed out and the callback does not run.
- If `ctx.privileged.run(...)` is called with an already-aborted signal, the run
  still emits audit events because the privileged path was entered: `started`,
  then `errored` with a stable abort safe error code, then `finished`. The
  callback must not execute.
- If the supplied signal aborts while the callback is already running, business
  logic decides how to respond. The runtime should not interrupt arbitrary
  callback work; it propagates the signal and records audit outcomes from the
  callback's actual settlement: `completed` then `finished` if it returns, or
  `errored` then `finished` if it throws.
- The privileged callback should receive a derived handler context with the
  same familiar resource APIs where possible, including `db` and file APIs. It
  should not introduce parallel DB/storage interfaces unless a resource truly
  needs a distinct privileged-only operation.
- The derived privileged context should bypass normal ACL gates through an
  internal runtime capability, such as a closure-held or symbol-backed marker
  that Capsule code cannot forge by assigning a property on `ctx`.
- A free imported helper should not be the primary API. If one exists as an
  implementation convenience, it should still require a real runtime handler
  context and should not let Capsule code fabricate privileged authority.
- The elevated context should identify its actor kind as `privileged-server-role`
  and should preserve any surrounding correlation identity from the request,
  handler, CLI action, Job, or future scheduled Job.
- The privileged context should keep the familiar `auth` field name, but should
  not introduce a new app-facing actor field. Instead, its auth shape should use
  a reserved sentinel user ID, `userId: "__privileged__"`, to mark userless
  system-owned execution.
- The `__privileged__` user ID sentinel must be reserved by the runtime. It must
  not be insertable as a real auth user, resolvable from a Session token,
  assignable through local identity simulation, or derived from client input.
- Privileged audit events remain the source of actor-kind truth for security
  review. The sentinel keeps handler code ergonomic; it does not replace
  `actorKind: "privileged-server-role"` in audit events.
- Privileged DB writes should not automatically stamp ownership fields such as
  `ownerId`. If privileged code writes `ownerId: privilegedCtx.auth.userId`, that
  is an explicit Capsule author choice, not runtime inference.
- The normal handler context remains user-based by default. Existing `ctx.db`,
  file APIs, auth APIs, message APIs, and logging APIs must not silently become
  privileged.
- Privileged execution should initially operate only within the Capsule's DB,
  file, and storage resources, including configured Capsule services behind
  those runtime abstractions.
- ACL remains the gate around normal DB and storage access. Privileged execution
  should not change the underlying Database adapter, Storage adapter, or Capsule
  service contract; it should expose an explicit audited route that calls those
  same resources without normal user ACL filtering.
- Runtime-owned non-app resource inspection is deferred. If added later, it must
  be exposed through named server-code APIs and must not expose raw internal
  table names or bypass the Database adapter.
- Deliberate ACL bypass for userless system-owned execution must be available
  only through the privileged context, not as a flag that quietly turns off ACLs
  across an entire handler.
- ACL rule evaluation remains constrained and read-only. The Privileged server
  role is not available from `ctx.acl`, and normal ACL helpers do not gain access
  to runtime-owned non-app resources.
- `ctx.privileged.run(...)` must not be available during ACL rule evaluation.
  ACL rules should remain pure authorization checks over the constrained ACL
  context, not a place to start userless system-owned execution or bypass the
  policy currently being evaluated.
- The first implementation should support a narrow set of privileged operations
  that are needed by current roadmap dependencies and can be audited
  end-to-end. Unsupported operations should fail closed with stable structured
  errors.
- The API should distinguish three actor modes for future background work:
  current Sporades user identity, captured Sporades user identity, and
  Privileged server role.
- The Job Queue and Job scheduling designs should depend on this actor model,
  but this feature should not implement Jobs, retries, recurrence, cron syntax,
  missed-run behavior, or duplicate-run protection.
- Privileged operations that write app data inside a mutation should participate
  in the mutation Transaction boundary where possible.
- `ctx.privileged.run(...)` should preserve the surrounding Transaction boundary
  when one exists, especially inside mutations, but it should not automatically
  create a new Transaction boundary outside one.
- Outside an existing Transaction boundary, privileged DB writes follow the same
  database-atomic behavior as the underlying DB API operation unless user code
  invokes a future explicit transaction surface. Privileged runs may also touch
  files or storage, so an automatic DB transaction around the whole callback
  would imply guarantees Sporades cannot provide.
- Single-statement privileged writes may remain database-atomic only when the
  implementation explicitly classifies them that way, matching the existing
  Transaction boundary policy.
- Host server registry writes remain outside the Database adapter transaction
  model and continue to use Host server locking and atomic replacement where
  applicable.
- Every privileged operation must emit Privileged audit events through the
  existing audit envelope and JSONL log stream.
- The privileged run wrapper should emit `started` before the callback runs,
  then emit `completed` if the callback returns or `errored` if it throws or
  rejects. The wrapper should use try/catch/finally so errored callbacks still
  produce result audit evidence before rethrowing the original error, and every
  privileged run emits `finished` from the `finally` path as a stable end marker.
- Privileged audit emission is not best-effort. If any required audit emission
  fails, `ctx.privileged.run(...)` should throw rather than allowing privileged
  work to proceed or appear complete without durable audit evidence. A failed
  `started` emission prevents the callback from running.
- Audit-emission errors take precedence over callback outcomes. If the callback
  throws and `errored` or `finished` emission also fails, the thrown
  audit-emission error should include the original callback error as structured
  context. If the callback returns and `completed` or `finished` emission fails,
  the thrown audit-emission error should include the callback result as
  structured context so user code can decide what recovery, retry, or response is
  appropriate.
- Callback errors and callback results attached to audit-emission errors are
  server-side structured context only. They must not be exposed in default
  client-visible error responses; browser and external caller responses should
  remain opaque and stable unless Capsule code explicitly catches the error and
  chooses a safe response shape.
- If audit emission succeeds and the callback returns, `ctx.privileged.run(...)`
  returns that callback result to the surrounding server code without runtime
  inspection or sanitization.
- `completed` and `errored` describe callback completion state, not the business
  result or durability of the action's side effects. `finished` describes the
  wrapper reaching its final close marker, not success, failure, or rollback
  state.
- Privileged audit events record the privileged action boundary, not the final
  durability of every side effect performed inside the callback. Rollback,
  compensating cleanup, file/storage behavior, or other later activity does not
  remove or rewrite the `started`, `completed`, `errored`, or `finished` audit
  facts.
- When a privileged run happens inside a mutation Transaction boundary, its
  audit events must remain durable evidence outside app data rollback. The
  mutation may roll back app writes, but the audit stream still records that the
  privileged action started, how the callback completed, and that the run reached
  its final close marker.
- `ctx.privileged.run(...)` should preserve normal handler error semantics. It
  should not wrap callback failures in a new privileged error type unless the
  callback itself chooses to do so; user code can catch, transform, or allow the
  original error to reach the existing query, mutation, endpoint, or message
  error path.
- Privileged run audit outcomes should stay limited to `started`, `completed`,
  `errored`, and `finished`. They describe audit-event lifecycle state rather
  than authorization or business result.
- Existing SSH audit emitters should be migrated to the same `outcome` field
  vocabulary. Domain-specific event names may remain descriptive, but audit
  outcomes must not use legacy success/failure terms.
- Nested privileged runs are not permitted. A call to `ctx.privileged.run(...)`
  from inside an active privileged context should fail before the inner callback
  executes. If user code needs multiple privileged audit boundaries, it should
  call separate top-level privileged runs deliberately.
- Audit metadata must use bounded, redacted resource summaries: resource kind,
  stable ID where safe, counts, fingerprints, operation names, and safe error
  codes rather than secrets, raw payloads, or raw stack traces.
- App `ctx.log` must remain ordinary app logging and must not gain the ability
  to forge Privileged audit events.
- Browser/client credentials must not contain or request privileged authority.
  Any client-triggered operation that results in privileged server work must be
  represented as server code choosing to invoke a privileged API.
- Public client-visible error responses should be opaque and stable. Detailed
  diagnosis belongs in structured server logs and Privileged audit events.
- Privileged runs should support caller-supplied `AbortSignal` propagation, but
  this feature should not introduce its own deadline, timeout, retry, or
  cancellation policy. Future Job deadlines and retries belong in Job design.
- Type definitions and generated API docs should make the server-only boundary
  visible, including guidance on actor choice for request handlers and future
  Jobs.
- Generated CLI/runtime artifacts must stay in parity with source changes so
  Dev, Container, and Host paths expose the same privileged behavior.
- Roadmap and product documentation should be updated when the feature is
  implemented, especially the dependency notes for Job Queue and Job scheduling.

## Testing Decisions

- Good tests should verify external behavior and contracts rather than private
  helper internals. The core question is whether server code can request
  privileged behavior, whether unsupported access fails closed, whether normal
  user rights remain the default, and whether the audit trail is complete.
- The highest-value test seam is the Capsule server handler seam: run real
  queries, mutations, Custom endpoints, App messages, context middleware, and
  lifecycle-supported paths through the established runtime harness and assert
  behavior through structured results, database state, and JSONL logs.
- Surface tests should prove `ctx.privileged.run(...)` works consistently on
  supported server surfaces, including queries, mutations, Custom endpoints, App
  messages, context middleware, and lifecycle-supported paths where those paths
  exist.
- Middleware tests should prove a privileged run inside context middleware does
  not make the downstream query, mutation, endpoint, or message handler
  privileged.
- Lifecycle tests should prove privileged runs inside supported lifecycle hooks
  emit audit events for each actual lifecycle execution, including repeated Dev
  restart or rebuild executions where applicable.
- Shutdown tests should cover privileged audit behavior only within the
  runtime's existing shutdown hook guarantees; they should not require new
  shutdown ordering or retry behavior.
- Privileged audit coverage should be tested through the existing JSONL log
  stream and structured log inspection behavior, not by directly asserting only
  private emitter calls.
- Audit tests should prove actor kind, operation, surface, target resource kind,
  outcome, safe error code, correlation identity where available, redaction, and
  payload bounds.
- Audit tests should prove required metadata is validated and redacted before
  `started`, and metadata validation, redaction, or generation failure throws
  before any privileged audit event, privileged context, or callback execution.
- Audit tests should prove metadata generation is synchronous and structural, and
  does not perform async DB, file, storage, network, or service work before
  `started`.
- Audit tests should prove a callback-returned privileged run emits `started`,
  then `completed`, then `finished`, and a throwing or rejecting privileged run
  emits `started`, then `errored`, then `finished` before the original error is
  rethrown.
- Audit durability tests should prove privileged audit events survive app data
  rollback when a privileged run occurs inside a mutation Transaction boundary.
- API tests should prove `ctx.privileged.run(...)` rejects calls that omit the
  required operation metadata before privileged work runs.
- API tests should prove `ctx.privileged.run(...)` accepts and propagates a
  caller-supplied `AbortSignal` without introducing a new runtime-owned timeout
  policy.
- API tests should prove the derived privileged context exposes the same signal
  as `privilegedCtx.signal`.
- API tests should prove a missing caller signal still gives `privilegedCtx` a
  fresh non-aborted signal, and that runtime-owned abort listeners or bridges are
  cleaned up at `finished` rather than accumulating across runs.
- Abort tests should prove an already-aborted signal still emits `started`,
  `errored`, and `finished`, records a stable abort safe error code, and does not
  execute the callback.
- Abort tests should prove a signal that aborts while the callback is running
  does not cause runtime interruption; the callback's actual return or throw
  determines whether audit emits `completed` or `errored` before `finished`.
- Nested-run tests should prove a privileged run cannot start from inside an
  active privileged context, and that the inner callback does not execute.
- Tests should prove ordinary app `ctx.log` cannot emit events that are accepted
  as Privileged audit events.
- Tests should prove browser/client transports cannot import, request, or carry
  Privileged server role authority, and cannot set a Capsule role merely by
  adding role-shaped request input.
- ACL tests should prove normal ACL behavior remains default, Capsule roles can
  be checked through normal ACL rules where the Capsule defines them, and any
  deliberate privileged bypass is only available through the named privileged
  API.
- ACL tests should prove Capsule code cannot forge privileged access by setting
  role-shaped or skip-ACL-looking properties on the normal handler context.
- Adapter tests should prove privileged execution does not introduce a separate
  Database adapter or Storage adapter path; the difference is the runtime route
  that decides whether ACL gates are applied before calling the same underlying
  resources.
- Context tests should prove `privilegedCtx.auth.userId` is the reserved
  `__privileged__` sentinel, while ordinary sessions still use
  runtime-generated user IDs.
- Auth tests should prove no browser request, Session token, local identity
  simulation command, or auth-linking flow can create or resolve a real
  Sporades user with `userId: "__privileged__"`.
- Audit tests should prove privileged operations still emit
  `actorKind: "privileged-server-role"` even though the callback auth uses the
  `__privileged__` user ID sentinel.
- Write-path tests should prove privileged writes do not automatically stamp
  `ownerId` or other ownership-looking fields with the sentinel.
- ACL tests should prove `ctx.acl` remains read-only and cannot access the
  Privileged server role or runtime-owned non-app resources.
- ACL tests should prove ACL rule evaluation cannot invoke
  `ctx.privileged.run(...)` or otherwise start privileged execution.
- Transaction tests should prove mutation-scoped privileged writes roll back
  with the mutation when the operation is specified to share that Transaction
  boundary.
- Transaction tests should prove privileged runs preserve an existing mutation
  Transaction boundary but do not create a new automatic Transaction boundary
  when called outside one.
- Type tests should prove the public server API types accept valid privileged
  usage and reject client-side or ACL-context misuse.
- Generated bundle tests should prove the runtime helper source and generated
  artifacts expose the same Privileged server role behavior.
- Container-session tests should prove privileged behavior and audit events
  survive the bundled runtime path and Docker stdout/log behavior where
  applicable.
- Hosted Capsule or Host helper tests should be added only for privileged
  operations that touch Host-owned behavior in the first slice; the feature
  should not add broad Hosted smoke coverage for operations it does not include.
- Prior art includes the existing table ACL tests for policy behavior, auth
  helper tests for server-only handler helpers, database adapter tests for
  privileged audit envelope behavior and Transaction boundaries, host tests for
  audit event propagation, docs tests for drift coverage, and type tests for
  public API shape.

## Out of Scope

- Do not implement Job Queue.
- Do not implement Job scheduling, recurrence, cron syntax, missed-run recovery,
  or duplicate-run protection.
- Do not implement Teams for ACL or team-admin role membership.
- Do not implement Capsule roles or Capsule admin authorization in this feature;
  they belong in a separate PRD.
- Do not add a global `admin` role to runtime-owned Sporades auth users.
- Do not add a browser-visible admin credential, service account token, user
  account, or session type.
- Do not expose raw internal runtime tables or adapter-specific database
  clients to Capsule code.
- Do not make ACL rules privileged or writable.
- Do not make all server handlers privileged by default.
- Do not add a new audit database, dashboard, retention system, SIEM export, or
  centralized JSON logging replacement.
- Do not change the Container SSH access contract except where a selected
  privileged operation explicitly uses existing audit semantics.
- Do not broaden Host server operator authorization or Host profile semantics.
- Do not implement automated backups or Host backup/restore as part of this
  feature.
- Do not add managed external storage or external database support as part of
  this feature.

## Further Notes

The useful dividing line is actor semantics, not power. "This ran as the
current user," "this ran as a captured user," and "this ran as the Privileged
server role" should be obvious in code, logs, audit events, and future Job
state. Anything blurrier than that is just an admin button with nicer shoes.

The first implementation should be intentionally boring: a narrow server-only
API, a small set of named privileged operations, hard audit requirements, and
tests at the highest runtime seams. Once that boundary exists, Job Queue and Job
scheduling can use it without inventing their own authority model.
