# Built-in Teams Reference

Runtime-owned Teams, membership application roles, email-bound Join links, and explicit Team ACL decisions.

[Back to the feature reference index](../guide/reference.md).

## Team model and compatibility

A **Team** is a Capsule-scoped runtime resource. A **Team membership** connects one linked Sporades user to one Team. Every membership has exactly one runtime-owned management role: `admin` or `member`. A **Team admin** manages that Team's members, Join links, and declared application-role assignments.

Teams are always available but never automatically partition Capsule data. There is no current Team selection. A Capsule that never calls a Team interface preserves its existing auth result shape, tables, queries, mutations, App messages, Files, and ACL behaviour. In particular, `ctx.auth` gains no Team ID and a Team name is presentation metadata, not authorization authority.

When a user first links an account, Sporades atomically creates that user's initial singleton Team and its admin membership. Users linked before Teams are bootstrapped lazily on their first Team operation. Anonymous users neither receive durable Teams nor may perform linked-user Team operations. A user may belong to multiple Teams; every Team-scoped operation names its Team ID explicitly.

`teams.list()` returns the caller's memberships with a capped display count, their management role, and their active application roles. The display count is capped at 99 for compatibility and is not suitable for seat enforcement. Capsules can use that state to keep single-user navigation simple without relying on hidden current-Team state.

## Manage Teams from a Capsule

The browser SDK exposes `teams` from `sporades/client`. Trusted query, mutation, endpoint, and App-message handlers receive the same current-user operations through `ctx.teams`.

```ts
import { teams } from "sporades/client";

const mine = await teams.list();
const created = await teams.create("Editorial");
if (created.data) await teams.rename(created.data.team.id, "Editorial team");
```

```ts
import { capsule, mutation, query } from "sporades/server";

export default capsule({
  name: "team-notes",
  teams: { appRoles: ["author", "reviewer"] },
  queries: { myTeams: query((ctx) => ctx.teams.list()) },
  mutations: {
    renameTeam: mutation((ctx, teamId: string, name: string) => ctx.teams.rename(teamId, name)),
  },
});
```

Capsules may declare up to 32 membership application roles with `teams.appRoles`. Names match `^[a-z][a-z0-9-]{0,31}$`; `admin`, `member`, and the `sporades-` prefix are reserved. Application roles are scoped to one membership, are not automatically given to admins, and become inactive when a Capsule removes their declaration. Retained inactive assignments fail closed and become active again if a rollback restores the declaration.

Only admins can enumerate memberships for their exact Team. `listMembers(teamId, { cursor, limit })` returns a bounded page in deterministic membership-creation and user-ID order, an opaque `nextCursor` when another page exists, and an exact uncapped `totalCount`. Omitting options remains valid and uses the compatible 100-member page size; limits range from 1 through 100. Treat cursors as opaque and pass them back unchanged.

Any current member of an explicitly identified Team, including an ordinary member, may call `countMembers(teamId)` for `{ totalCount }`. This is an exact accepted-membership total, not the capped `teams.list()` display count; pending Join links do not affect it. The result contains no member identities, roles, emails, or presentation fields. Unknown Teams and non-members receive the same opaque denial, and `countMembers()` grants neither directory access nor mutation authority.

```ts
let cursor: string | undefined;
do {
  const page = await teams.listMembers(teamId, { cursor, limit: 50 });
  if (page.error) throw page.error;
  renderMembers(page.data.members);
  showSeatUsage(page.data.totalCount); // authoritative current membership count for admins
  cursor = page.data.nextCursor;
} while (cursor);
```

The safe directory result contains user ID, display name, optional picture, management role, and active application roles; results omit member emails, provider subjects, sessions, credentials, and inactive roles. Pending Join links are not members and do not affect either `totalCount` or `countMembers(teamId)`. Ordinary members can inspect their own membership through `teams.list()` and the count-only `countMembers(teamId)` surface, but cannot enumerate a directory. Invalid limits and malformed cursors fail with `INVALID_TEAM_MEMBER_PAGE` after Team-admin authorization, without revealing Team or member details.

Exact-Team admins use `updateApplicationRoles(teamId, userId, { add, remove })` to atomically reconcile declared roles. Promotion and demotion preserve at least one committed admin. Members leave with `leave(teamId)`; an admin cannot leave while still an admin, and `removeMember` cannot remove its caller. A sole admin member may delete an otherwise empty Team with `delete(teamId)`.

## Email-bound Join links

A **Join link** is a short-lived, revocable, single-use capability bound to one normalized target email and one Team. An exact-Team admin creates it with `createJoinLink(teamId, email, { ttlSeconds })`. Target email is required; the default lifetime is one day and the accepted lifetime range is 300 to 604800 seconds.

Sporades returns a Join link but never sends it: it is returned but never sent. The Capsule owns its join route, UI, copy, and delivery channel. The returned URL uses the configured canonical Capsule origin and a validated same-origin path, so request headers cannot redirect an issued invitation.

```ts
const issued = await teams.createJoinLink(teamId, "reader@example.com", { ttlSeconds: 60 * 60 * 24 });

// On the Capsule's own join page, after sign-up, sign-in, or OAuth callback:
const checked = await teams.validateJoinLink(code);
if (checked.data?.valid) await teams.join(code);
```

Inspection before authentication exposes only safe Team presentation and usability. Post-auth validation is non-consuming validation followed by the authoritative join: it returns only `{ valid }`, does not reserve or consume a link, and `join(code)` repeats capability and identity checks transactionally before creating an ordinary `member` membership with no application roles.

### Trusted Join admission

A Capsule may declare `teams.admitJoin` in trusted server code to decide whether a validated Join link may create a new membership. The policy receives the target `teamId`, joining `userId`, and exact `currentMemberCount`, plus a transaction-bound context containing read-only `ctx.db`, exact-Team `ctx.teamBilling`, `ctx.auth`, `ctx.env`, and `ctx.log`. Its app-table reads bypass the joining user's ordinary row ACLs; its billing read contains only the verified provider-free projection. Neither surface exposes provider identifiers, runtime-owned tables, mutation methods, raw adapter, schema, or nested transaction.

```ts
export default capsule({
  name: "team-notes",
  teams: {
    async admitJoin(ctx, { teamId, currentMemberCount }) {
      const billing = await ctx.teamBilling.get(teamId);
      const cap = billing.state === "active" && billing.productKey === "agency" ? 20 : 3;
      return { allow: currentMemberCount < cap };
    },
  },
});
```

The runtime invokes this policy only after authentication, Join-link validation, intended-recipient matching, and the Team lifecycle lock, but before membership insertion. The joining user remains the policy subject; trusted reads grant neither membership, Team administration, nor the Privileged server role. The check, any read-only `ctx.db` access, capability consumption, and membership insert share one transaction. Concurrent joins for a final seat therefore serialize against the same Team row: one may commit and the next observes the new exact count. A denial, missing policy state, invalid decision, cancellation, or policy error rolls the transaction back and returns only the generic `TEAM_JOIN_DENIED` client error; policy data and internal errors are not exposed, and the otherwise-valid Join link remains usable. Browser callers cannot supply, alter, or omit this policy. Capsules without `admitJoin` preserve the 0.8.1 Join behavior, and idempotent retries by an already-joined member do not create or re-admit a membership.

Sporades compares normalized email equality across the current linked user's attached addresses, but does not require verified email. Email-verification policy belongs to the Capsule. Malformed, expired, revoked, consumed, unknown, and email-mismatched capabilities all have generic invalid results. Repeated same-user join attempts are idempotent.

Admins can list and revoke active links for their own Team. Those management results never recover codes or complete URLs. Runtime persistence holds a non-recoverable verifier rather than a usable code, bounds link creation and outstanding links, and prunes expired records through bounded work.

## Authorize explicit Team resources

Team membership alone grants no Capsule data or File access. A Capsule carries the explicit Team ID in its own row or File-policy model, then checks the read-only `ctx.acl.teams` helpers in normal table or File ACL rules. ACL code does not access runtime Team tables, `ctx.teams`, raw membership rows, or mutable Team administration.

```ts
import { String, table } from "sporades/server";

schema: {
  documents: table({ teamId: String(), body: String() }).acl({
    read: ({ row, ctx }) => ctx.acl.teams.isMember(row.teamId),
    write: ({ next, previous, ctx }) => ctx.acl.teams.isAdmin((next ?? previous).teamId),
  }),
}
```

Use `isMember(teamId)`, `isAdmin(teamId)`, `hasRole(teamId, role)`, or `hasAnyRole(teamId, roles)` with an explicit Team ID. Role checks authorize only active declared roles. These decisions work in normal File ACLs too:

```ts
files: {
  acl: {
    read: ({ file, ctx }) => ctx.acl.teams.isMember(file.path.split("/")[2]),
    delete: ({ file, ctx }) => ctx.acl.teams.hasRole(file.path.split("/")[2], "author"),
  },
}
```

See [Files and Realtime](./files-and-realtime.md#file-uploads) for normal File operations and their opaque denial behaviour.

## Declare headless Team Billing

Team Billing is an optional server declaration and a provider-free client
projection. It does not render Settings, buttons, progress, errors, or product
copy. Omit `teamBilling` and the runtime creates no Team Billing storage or
client authority.

```ts
capsule({
  name: "example",
  schema,
  teamBilling: {
    checkout: {
      successPath: "/settings/billing/success",
      cancelPath: "/settings/billing/cancelled",
    },
    portal: { returnPath: "/settings/billing" },
    catalogue: {
      studio: {
        quantity: { kind: "fixed", value: 1 },
        stripe: {
          sandbox: { productId: "prod_test_studio", priceId: "price_test_studio", portalConfigurationId: "bpc_test_studio" },
          live: { productId: "prod_live_studio", priceId: "price_live_studio", portalConfigurationId: "bpc_live_studio" },
        },
      },
      agency: {
        quantity: { kind: "team-members" },
        stripe: {
          sandbox: { productId: "prod_test_agency", priceId: "price_test_agency", portalConfigurationId: "bpc_test_agency" },
          live: { productId: "prod_live_agency", priceId: "price_live_agency", portalConfigurationId: "bpc_live_agency" },
        },
      },
    },
    async authorize(ctx, input) {
      const holder = await ctx.db.billingHolders.where("teamId", input.teamId).get();
      const members = input.operation === "plan-transition"
        ? await ctx.teams.countMembers(input.teamId) : null;
      return { allow: holder?.userId === ctx.auth.userId && (!members || members.totalCount <= 3) };
    },
  },
});
```

Product keys are lowercase stable application identities. Each product binds
one exact sandbox Price and one different live Price and declares either a
positive fixed quantity or `team-members`. The declaration is server-only; the
browser cannot select a mode or Price.

Every operation re-reads the exact Team membership inside its transaction. A
current linked Team administrator reaches the Capsule policy for every
customer-directed command, which makes the Capsule-specific decision from
transaction-bound read-only app tables. The same callback has only the
transaction-bound `ctx.teams.countMembers(input.teamId)` inspection, allowing a
downgrade policy to recheck exact accepted seats immediately before provider
I/O. It cannot inspect another Team, enumerate members, or retain the count
surface after callback settlement. Safe `read` authorization may
additionally admit a current member, so the Capsule can render one Team-visible
status without exposing provider identifiers.
Captured policy tables expire when the callback settles. Removing membership or
changing the app's billing-holder record therefore denies the next request even
when the browser retains the same Session.

`teams.admitJoin` receives `ctx.teamBilling.get(input.teamId)` alongside its
read-only app database. This projection is provider-free, is bound to the exact
Team whose Join is in progress, and is revoked when the admission callback
settles. Apps can therefore enforce a paid seat policy atomically without
trusting a legacy application subscription row or performing provider I/O.

The provider-free projection validates the persisted Subscription's complete
convergence ratchet: canonical event time plus state, cancellation flag, event
kind, rank, and terminal latch must agree. Missing or contradictory evidence
returns `attention-required`; it never grants paid entitlement.

The client exposes a safe observation seam and one operation-specific Checkout
command. Apps create the button, progress, retry, and navigation UI:

```ts
import { teamBilling } from "sporades/client";

const result = await teamBilling.get(teamId);

const checkout = await teamBilling.startCheckout({
  teamId,
  requestId: crypto.randomUUID(),
  productKey: "agency",
});

const portal = await teamBilling.openPortal({
  teamId,
  requestId: crypto.randomUUID(),
});
```

`teamBilling.startCheckout` supplies only the safe state needed by the app.
Apps create the button and render every pending, ready, completed, expired,
superseded, or failed state themselves. Sporades permits only one active
Checkout per Team; the app should continue polling its original request until
that Checkout finishes or expires before it offers another.

The result is a closed `inactive`, `pending`, `active`, `cancelling`,
`past-due`, `cancelled`, or `attention-required` projection containing Team ID,
declared product key, safe quantity, and bounded lifecycle timestamps where
appropriate. It never contains Stripe Customer, Subscription, Price, Event, or
operation identifiers, raw provider errors, Job state, idempotency keys, or an
unvalidated URL. Cross-Team, former-holder, anonymous, non-admin, and stale
Session requests receive the same generic `TEAM_BILLING_DENIED` result.

Checkout admission and its reserved Job are committed together. Repeating the
same Team/request/product reads the same `pending`, `ready`, `completed`,
`expired`, `superseded`, or safe `failed` operation without another provider
call; reusing the request for another product is a safe conflict. Immediately
before every provider attempt Sporades locks the Team lifecycle, rechecks the
original actor and Capsule policy, recounts accepted Team membership, and
derives mode, exact Price, optional existing Customer, return paths, business
correlation, and idempotency from trusted state. It holds no database
transaction across provider I/O. Retries reuse identical provider parameters.
For managed Plan transitions, the lifecycle lock precedes the administrator
membership read and every Billing Holder, app-usage, and exact-seat policy
read. A demotion or holder transfer already holding that lock commits first;
the waiting transition then observes the new authority and records
`AUTHORITY_CHANGED` without calling the provider.

Only `ready` contains a strictly validated `checkout.stripe.com` URL and a
bounded local expiry. A durable runtime Job erases the retained capability at
expiry even if the app is abandoned and never polls again. Verified
`checkout.session.completed` or `checkout.session.expired` observation is
terminal even when it arrives before the provider response; a later response
cannot revive the URL. Checkout response, browser return, and completion alone
do not create Subscription state or entitlement.

Portal admission resolves the exact current Team Customer and Subscription,
then retrieves the declared `bpc_…` configuration before creating a session.
Sporades requires the configuration to be active in the exact sandbox/live
mode, with payment-method updates and invoice history enabled, cancellation at
period end, quantity editing disabled, and an exact Product-to-Price allow-list.
Products sharing a configuration must share the same quantity policy: fixed
quantities match only the same fixed value, while Team-member quantities match
only Team-member quantities. The session always names the reviewed
configuration explicitly, so changing Stripe's mutable Dashboard default has
no effect. Configuration drift fails closed.

`teamBilling.openPortal` is durable and idempotent by Team and request. It
rechecks the original actor, Capsule policy, Customer, Subscription, mode,
configuration, and return path immediately before session creation. Only a
strictly validated `billing.stripe.com` URL is exposed, and a runtime Job erases
it at local expiry even when the app is abandoned. The app renders every
button, progress state, error, retry, and navigation action; Portal return and
provider acknowledgement never update billing truth.

Portal remains the surface for switches whose source and target share the same
quantity policy. A switch between fixed quantity and accepted-Team-member
quantity uses the managed command instead:

```ts
const transition = await teamBilling.requestPlanTransition({
  teamId,
  requestId: crypto.randomUUID(),
  productKey: "agency",
});
```

The app renders the returned `pending`, `completed`, `superseded`, or safe
`failed` state. The response contains no intent, Job, Price, Customer,
Subscription, item, or idempotency identity. Repeating the same
Team/request/product observes the same operation; reusing its request ID for a
different product is a safe conflict. Capsule `authorize` remains the local
business-policy seam, including whether a downgrade is allowed.

Admission and the desired-state Job commit together. Before each provider
attempt Sporades reauthorizes the original linked Team administrator, re-reads
the current Subscription and catalogue, and derives the exact accepted-member
count when the target uses `team-members`. It updates the one attested
Subscription item Price and quantity together using Stripe
`create_prorations`, the desired intent's stable `proration_date`, and
`pending_if_incomplete`; it does not create an immediate standalone invoice.
Payment action required becomes a safe failed state for app-owned recovery.
Retries preserve the exact provider tuple and idempotency key.

For an active `team-members` Plan, a committed Join, removal, or leave stages
seat convergence after the membership transaction. Staging or provider outage
cannot roll that membership change back. New counts supersede stale queued or
in-flight intent, and a durable per-Team lane permits only one provider write
at a time across runtime instances. Startup repair compares accepted
Subscription quantity with the exact Team count and reconstructs absent,
failed, or drifted work. This is eventual provider convergence, not a database
transaction held across Stripe I/O.

A successful Stripe update is only acknowledgement: public state remains
pending. Exact verified `customer.subscription.*` evidence settles the desired
Price and quantity through the atomic Stripe consequence. Older or mismatched
evidence leaves or requeues the latest desired target, so provider-response
races cannot grant entitlement.

Customer, Subscription, operation, observation, and replay correlation lives
in runtime-owned storage on SQLite, libSQL, and Postgres. Supported verified
`checkout.session.completed`, `checkout.session.expired`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, and `invoice.payment_failed` observations
converge inside the existing cross-runtime atomic Stripe fence. Checkout
completion establishes correlation but never establishes paid entitlement. A Subscription
snapshot must instead prove the exact mode, Customer, Subscription, single
licensed item, declared Price, quantity, period, and supported status.

Newer periods and observations advance the projection. At the same provider
time, cancellation outranks failed payment, failed payment outranks
cancelling, and cancelling outranks active; provider Event identifiers are not
invented as business ordering. Deletion permanently latches that Subscription
ID, so no delayed update can resurrect it. A later verified recovery may clear
past-due state for a non-terminal Subscription. Duplicate and out-of-order
delivery therefore converges to the same result across independent runtimes.

Malformed supported evidence, unknown Prices, multiple licensed items,
conflicting associations, and multiple current Subscriptions are retained only
as bounded digest and private correlation with a safe reason. Raw Stripe JSON
and errors never enter Team Billing tables or the client projection. Team-linked
ambiguity produces provider-free `attention-required` state; evidence that
cannot be associated safely is visible only through bounded provider-free
`privilegedCtx.teamBilling.listQuarantines({ limit })` inspection. An app's opt-in atomic
Stripe consequence shares the same transaction. A legacy `stripeEvent(handler)`
runs after the platform commit and keeps its existing independent retry model.

### Prepare provider-safe Team erasure

Call `teamBilling.prepareErasure({ teamId, requestId })` before the app's
separate local Team deletion mutation. The result is provider-free `pending`
or `authorized` state for app-owned rendering. While preparation is active,
Sporades blocks new Team Checkout, Portal, managed Plan, and seat work.

The reserved Job resolves every issued Checkout without guessing, immediately
cancels every known or newly discovered live Subscription, and retries with
stable provider idempotency. Exact 404 responses may establish safely closed
objects; network absence and incomplete lists may not. An open Checkout that
completes during expiry is accepted only after Stripe's exact non-expireable
response and a fresh verified retrieve. Restart and provider-lane recovery use
fresh fenced Job generations, and stale claim tokens cannot settle erasure.
Sporades does not delete the Stripe Customer.

After authorization, the app's own deletion mutation must call
`await ctx.teamBilling.admitLocalErasure(teamId)`. This transaction-bound,
provider-free check returns only `{ allowed: true }`; the app remains
responsible for its local rows and all UI. Retained, detached, aborted,
rolled-back, or post-settlement use fails closed. Runtime tombstones are identity-only
digests with terminal classes and timestamps. They retain no Team, User,
email, holder, product, Plan, quantity, invoice, raw provider evidence, or
recoverable provider identifier, and they prevent late verified events from
recreating entitlement.

## Security, storage, and audit boundaries

Team state is runtime-owned and persists outside the Capsule schema through the configured Database adapter. Team creation, bootstrap, Join redemption, membership changes, role reconciliation, and last-admin checks use transaction boundaries so concurrency cannot create duplicate memberships or an adminless Team. Team state survives runtime restart and has adapter conformance coverage.

Team administrative outcomes are ordinary redacted security events, not Privileged audit events. Logs, public errors, and inspection output exclude Join codes, complete Join URLs, target emails outside the admin-only link-management result, Session tokens, provider subjects, credentials, provider object and Event IDs, digests, and raw payloads. Private recoverable Team Billing storage retains only the bounded correlation and digests required for convergence; it never stores raw provider payloads. Team Billing quarantine inspection exposes only association status, optional Team ID, mode, supported event type, occurrence time, and safe reason; it is capped at 100 newest observations and is revoked with its audited Privileged callback.

Team admin authority manages membership. Membership application roles express Capsule-declared responsibilities. Capsule ACL authority is the explicit policy the Capsule writes with `ctx.acl.teams`. The Privileged server role is separate userless server authority: it is not a Team admin, member, application role, or browser credential. Inside an active audited `ctx.privileged.run(...)` callback, `privilegedCtx.teams` offers only exact-Team read-only inspection: `countMembers`, `listMembers`, `listJoinLinks`, and `inspectJoinLink`. The first three require an existing explicit Team ID and otherwise fail with `TEAM_NOT_FOUND`; `inspectJoinLink` keeps its safe invalid-capability result. This projection never lists a current user's Teams, validates email-bound links, or changes Team state, and it exposes no raw rows, target emails, or recoverable Join capabilities. Detached or aborted in-flight inspection fails closed before it can return a result.

For precise browser and server signatures, see the generated [client Teams API](/api/types/client.TeamsApi.html), [server current-user Teams API](/api/types/server.CurrentUserTeamsApi.html), and [server Privileged Teams API](/api/types/server.PrivilegedTeamsApi.html).
