# ADR-0057: Human identity termination is an atomic, terminal transition

Status: Accepted (implemented in #264)

Capsules need to close a human account without writing runtime auth tables.
[ADR 0052](./0052-human-security-retirement-is-transaction-bound.md) retires
Sessions and Access keys, but deliberately retains identity, password and
recovery authority. The daily-build-template
[completion gate](https://github.com/mgscox/daily-build-template/blob/main/docs/account-closure.md#completion-gate)
and [required upstream contract](https://github.com/mgscox/daily-build-template/blob/main/docs/runtime-contracts.md#external-blocker-human-identity-closure-auth-closure-01)
show why this cannot truthfully be called account closure: the same password
can sign in again and an outstanding Reset code can restore access.

Sporades will add a terminal human-identity operation alongside security
retirement. This ADR proposes a contract; neither the operation nor its types
ship with this documentation change. Publication of an implementation and its
acceptance evidence remains necessary to unblock downstream account closure.

## Public operation and authority

The proposed additions to `sporades/server`, expressed in
`src/types/server.d.ts` terms, are exactly:

```ts
export type TerminateHumanIdentityResult = Readonly<{
  userId: string;
  status: "terminated" | "already-terminated";
}>;

export type ServerAuthApi = {
  // Existing members remain; add:
  terminateHumanIdentity(userId: string): Promise<TerminateHumanIdentityResult>;
  reserveTerminateHumanIdentity(userId: string):
    ValidatedLifecycleOperation<TerminateHumanIdentityResult>;
};
```

The result is a closed object with those two fields, no revocation counts,
profiles, credential information, runtime-table handles or secret material.
`ServerAuthApi`, `ValidatedLifecycleOperation<Result>` and
`LifecycleContinuationApi.continue(...)` retain their existing meanings.
There is no browser auth, Privileged, operator CLI, Job or direct database
equivalent. Existing `revokeHumanSecurity` behavior remains unchanged.

Only a Capsule Mutation with a current authenticated, non-guest human Session
may initiate termination. Sporades rechecks the exact Session and actor in the
transaction when executing the operation; context property edits cannot supply
authority. Human-owned Access keys, Service Users, Anonymous/guest Sessions,
Queries, Custom endpoints, App messages, Jobs, Schedules, lifecycle hooks and
Privileged/operator execution are refused even if a transaction is open.
Mutation hooks may initiate work only within that Mutation's initial dispatch,
under the same authority and pending-work drain as ADR 0052.

Self-closure is supported by passing `ctx.auth.userId`. Closing another human
is supported only through a Capsule-authorized administrative mutation: the
Capsule must check its current administrator policy against the exact target
and record its domain audit. Team administration alone is not global account
administration, and the Privileged server role is not a human administrator.
The runtime does not invent an app-admin flag. Both paths must enforce the
Capsule's declared purpose-bound reauthentication requirement before execution;
this operation neither supplies a proof nor turns an arbitrary boolean into
one. The trade-off follows ADR 0052: the runtime enforces human Session and
target boundaries, while the Capsule owns consent, admin policy and UI.

Targets must be existing linked, non-guest humans, or the terminal human
tombstones described below. Unknown/malformed IDs, guests, Service Users and
Privileged/operator pseudo-identities share the bounded
`HUMAN_IDENTITY_TERMINATION_DENIED` error, without disclosing target kind or
existence. Caller and surface refusals use that same code. A previously
authorized app replay must still pass current caller
authorization before receiving an `already-terminated` result. Tombstone lookup
is not a public account-existence query.

## One transaction, with structured continuation

The direct form must be initiated synchronously during initial Mutation
dispatch, before the first `await`. The runtime drains its Promise before
commit even if the handler forgets to await it; rejection fails the whole
Mutation even if Capsule code catches the rejected Promise. The result becomes
externally visible only after commit.

For asynchronous authorization, responsibility or idempotency checks, reserve
the write-free operation synchronously, await those checks, then return
`ctx.lifecycle.continue(reservation, callback)` from the owning Mutation. The
runtime executes termination before the callback in the same transaction.
The callback can complete app erasure and return the bounded result. A failure
in either phase rolls everything back. Reservations use ADR 0052's opaque,
one-shot, exact-object identity: they cannot be copied, forged, transferred,
used twice or consumed by detached work. Arguments are canonicalized when
reserved, and the frozen facade cannot retarget them. Unused reservations do
no work. Timers, microtasks, retained aliases and post-`await` direct calls
cannot initiate termination. Explicit reservation arrays execute in order and
roll back together; a second termination of the same non-caller target in one
array observes `already-terminated`. Self-termination must be the last
lifecycle operation: later operations still require a live caller Session.

Successful first execution atomically performs these effects with the Capsule's
app-table writes:

- Replace the live human with a terminal, non-authenticating tombstone keyed
  only by the original immutable user ID and terminal human classification.
  Remove email, display name, picture, provider summary and other live profile
  data, and delete runtime-owned user preferences. The ID cannot be reused,
  relinked, repaired into a live user or used to bootstrap new personal Teams.
- Delete every email credential, including password hash and salt, and every
  linked OAuth Provider identity under [ADR 0015](./0015-provider-auth-runtime-owned-oauth.md).
  Invalidate OAuth attempts bound to the human's Sessions; a callback begun
  before termination cannot reattach an identity or mint a Session afterward.
  This is local unlinking, not deletion of the external provider account or a
  promise to revoke provider consent remotely.
- Delete all Sessions, and retire all current human-owned Access keys,
  including expired current keys, with ADR 0044's existing `owner-deleted`
  cause and removal of bearer verification material. Previously revoked keys
  stay revoked; the minimal historical attribution allowed by
  [ADR 0044](./0044-access-keys-are-user-owned-credential-provenance.md) is not
  usable for authentication.
- Delete every outstanding Reset code for the human's credentials, including
  codes already verified but unspent. Verification and confirmation of old
  links thereafter fail with ADR 0033's normal invalid-code response. Pending
  or retrying runtime reset-mail work must not recreate a code or credential
  for the terminated identity, nor bind an old request to a new identity that
  later registers the same email. Already delivered mail cannot be recalled;
  its link is inert. Delayed reset requests must retain an internal identity
  generation fence without weakening ADR 0033's uniform request response.

Handler throw, continuation failure, adapter failure, cancellation or failure
before commit restores all app writes, profile/credential/provider records,
Sessions, keys, Reset codes and preferences; no terminal result or sign-out
notification is published. No independent auth commit or best-effort cascade
is allowed. Committed Session invalidation must reach existing WebSocket
connections and subscription caches; their later operations cannot retain the
old authenticated actor. Runtime auth/link/reset/key writers must serialize
with termination and recheck the terminal marker before committing, including
across runtime connections. Otherwise an in-flight login could resurrect it.

As with ADR 0044, already-admitted work is not retroactively cancelled. The
closing Mutation retains its original actor snapshot through settlement so its
authorized app erasure can finish, including self-closure. A subsequent request
must authenticate afresh; an old Session may resolve to an Anonymous session
under the normal contract, but never to the terminated human. Durable user Jobs
must not regain human authority from captured provenance after termination.
This transaction covers database effects, not external mail, provider calls or
archive/file-byte rewrites. Capsules must coordinate retry-safe external erasure
and must not report it complete merely because identity termination committed.

## Retry and re-registration

The first committed call returns `{ userId, status: "terminated" }`. Repeating
with the same user ID returns `{ userId, status: "already-terminated" }`, with
no writes or new notifications. All later authorized repeats return that same
value, including after restart and after the email is registered again.
Concurrent calls from independently authorized surviving humans serialize:
exactly one commits the first transition; the other observes the tombstone.
A concurrent caller whose own Session was terminated instead fails the live
Session check. A rolled-back call leaves no tombstone and a
later successful attempt returns `terminated`.

Retain the minimal tombstone for the lifetime of the Capsule database. This is
the cost of stable replay and referential history without retaining an email,
provider subject or recoverable credentials. Unknown IDs never count as
already terminated. The Capsule may keep its own minimized closure receipt for
domain erasure and audit, but it must not retain secrets to replay termination.

Self-closure deletes the caller's Session too. If the response is lost, that
Session cannot retry as an authenticated human; the UI must describe the
uncertain response truthfully. An independently authorized human administrator
can resume app erasure using the original target ID and app receipt. This ADR
does not issue a recovery credential or let a new account impersonate the old
one merely to obtain a replay result. Stable replay is an authenticated server
contract, not a promise of continued self-service access after closure.

Release the old normalized email and `(provider, subject)` associations for
fresh registration through ordinary configured admission. Email sign-in with
the old password fails until a new account explicitly sets its own password;
termination is not a permanent email ban. A new OAuth attempt may create a new
human from the same verified provider subject. Either path uses a new user ID
and fresh Sessions, with no inherited preferences, app roles, Team memberships,
keys or reset capabilities. A new Anonymous session's normal linking semantics
may be used, but never the old tombstone ID. Old Reset codes remain invalid even
if the normalized email is reused. The trade-off is that an external provider
account or mailbox holder may join again; apps needing a ban must implement
separate lawful admission policy rather than disguising a ban as erasure.

## Teams, billing and Service Users

Termination refuses while the human has any runtime Team membership, including
the automatically created singleton Team. The bounded server error is
`HUMAN_IDENTITY_TERMINATION_BLOCKED`, with no Team list, count, provider IDs or
billing detail. There is no automatic leave, Team deletion, final-admin bypass,
role transfer or billing cancellation. Capsules must first transfer or remove
memberships through supported Team APIs, or explicitly delete an eligible
personal Team. A shared Team and its data survive a member's closure. An admin
closing another account may need cooperation from an eligible Team admin;
account-admin policy does not grant Team authority.

Team cleanup must preserve final-admin rules, `teams.authorizeDestructive` and
exact-Team lifecycle locking. Membership admission and termination must also
share an internal target-identity fence so a concurrent Join cannot insert a
membership after the final emptiness check. Acquire affected Team locks in a
deterministic order, with the same lock order in Join, removal and termination
writers; detect/retry transaction conflicts without returning partial success.
No caller-supplied membership snapshot is trusted.

The Capsule must resolve app-owned billing holders, pending transfer recipients,
legacy account billing and other shared-work responsibilities before asking
for termination. Absence, malformed state or unreadable responsibility is not
proof of release. Holder transfer requires explicit acceptance by an eligible
surviving human; no silent reassignment to another administrator. Responsibility
writers and the closure guard must share the relevant Team lifecycle locks and
transaction, including late billing consequences. If a billed Team is being
deleted, first complete [ADR 0049](./0049-team-billing-erasure-requires-provider-quiescence.md)
preparation and call `ctx.teamBilling.admitLocalErasure(teamId)` in its local
deletion transaction. Continuing Team billing need not be cancelled when
membership and holder responsibility have been safely transferred.

The runtime can enforce its membership boundary, but cannot infer arbitrary
Capsule billing-holder tables. The app must fail closed on those checks before
consuming the reservation, and prevent new responsibility assignment to a
terminated human. It must also suppress delayed app callbacks/outbox work that
could recreate erased data. This explicit orchestration costs more than a
cascade, but avoids silently abandoning shared work or ongoing charges.

[ADR 0051](./0051-service-users-are-first-class-runtime-principals.md) gives a
Service User no implicit human owner. Termination does not disable one just
because this human created its credentials. Where a Capsule records ownership,
the Capsule must explicitly transfer that responsibility or reserve and adopt
`ctx.serviceUsers.reserveDisable(serviceUserId)` in the same lifecycle array
before human termination, subject to its authorization and Team policy. An
unresolved app-owned service responsibility blocks app closure. Human-owned
Access keys always retire with the human; independent Service Users and
Capsule-owned Agent credentials never cascade implicitly. This preserves
automation continuity without leaving an app's ownership decision ambiguous.

## Adapter and implementation acceptance

SQLite, PostgreSQL and libSQL must implement the same transition through the
shared Database adapter boundary. No SQLite-only auth SQL, engine-specific
success result or silent partial support is allowed. Under
[ADR 0035](./0035-one-conformance-specification-verifies-every-database-adapter.md),
each new adapter operation must enter the same behavioral conformance suite:
SQLite and fake-service libSQL run without external infrastructure; configured
real PostgreSQL runs the identical assertions. Engine-specific locking/session
mechanics get separate tests. This is a normal Mutation transaction, not the
separate resource-transaction API whose libSQL support is restricted.
The cost is implementing and proving engine-specific serialization before
shipping the feature on any adapter, rather than offering weaker closure on
one engine under the same public method name.

The implementation must add `node --test` coverage with observed values, not
only assertions that a call did not throw:

- Public-runtime self and Capsule-admin termination, exact-target authorization
  denial, required reauthentication, all refused caller surfaces and target
  kinds, and opaque unknown/guest/service/operator errors. A tombstone replay
  still requires a current authorized human Session.
- Direct and reserved forms, async app checks, initial-dispatch enforcement,
  forgotten-await draining, caught failure rollback, unused/copy/forged/duplicate/
  cross-handler/late reservations, immutable arguments/facades, ordered arrays,
  callback failure and cancellation. Prove app writes and every runtime effect
  commit or roll back together, with failure injection between storage steps.
- Two independent Sessions, a live WebSocket/subscription, active and expired
  current keys, previously revoked keys, multiple email credentials and linked
  OAuth providers. Assert deleted profile/preferences, inert historical keys,
  no new work under terminated authority and no exposed secrets or auth tables.
- Multiple outstanding reset links, verified-but-unspent links, queued/retried
  reset delivery, OAuth attempts and login/reset/link/key issuance races. Old
  capabilities cannot restore the old identity, including after email reuse;
  delayed reset-mail work cannot attach to the replacement account.
- First call, repeated call, duplicate non-caller reservation array,
  self-termination ordering, concurrent calls,
  restart, rollback-and-retry, lost self-closure response and independent admin
  retry. Assert exact result objects and absence of repeat writes/notifications.
- Same normalized email and same provider subject re-registration: new user ID,
  fresh authority, ordinary admission policy, no old data or memberships, and
  permanent invalidity of old Sessions, keys and Reset codes. Reusing an email
  or subject never changes replay results for the original ID.
- Singleton and shared memberships, final-admin protection, direct Team API
  policy refusals, concurrent Join/removal/closure, held and pending billing
  responsibility, missing/malformed/read-fault policy state, accepted transfer
  races, billed-Team erasure admission and delayed billing callbacks. Include
  app-owned Service User transfer/disable and no implicit service cascade.
- Parameterized adapter conformance for present, absent and terminal identities,
  complete effects, rollback, nonzero credential sets, idempotency and uniqueness
  release across all three engines; multi-connection races and restart evidence
  for real supported stores, including real libSQL transaction settlement.

The implementing PR must update public declarations, canonical auth/Team docs,
generated runtime/CLI artifacts (`npm run build`) and focused generated parity
tests together, then pass typecheck and the full suite. Disposable installed-
package acceptance must satisfy the template completion gate using only public
APIs. Until that package is published and downstream acceptance passes, this
proposed ADR does not certify account closure in any Capsule.
