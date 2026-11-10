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

## Atomic additional-Team creation policy

Capsules may opt into `teams.admitCreate` to decide whether a linked user may
create another Team. The same runtime operation governs browser `teams.create`
and server `ctx.teams.create`; an app wrapper cannot replace this policy.
Omitting `admitCreate` preserves existing behavior. A non-function declaration
rejects startup with `INVALID_TEAM_CREATE_ADMISSION`.

```ts
teams: {
  admitCreate(ctx, input) {
    // Allow one additional Team beyond the initial personal Team.
    return { allow: input.currentCreatedTeamCount < 2 };
  },
},
```

The frozen input contains `actorUserId`, `name`, and `currentCreatedTeamCount`.
The name has already been normalized with NFKC, collapsed whitespace, trimmed,
and bounded to 80 UTF-8 bytes. The count includes every currently live Team
created by this actor, including the initial personal Team and still-live Teams
they later left. Deleted Teams and the proposed candidate are excluded. It is
not the actor's membership count. Initial personal-Team bootstrap bypasses the
hook, including lazy bootstrap for previously linked users.

The runtime checks linked identity, current Session authority, and the existing
25-membership limit before invoking the policy. It holds the actor's durable
serialization lock across counting, callback, insertion, and outer transaction
settlement. Concurrent creations on separate database connections therefore
cannot both consume the last policy-permitted capacity. A policy cannot grant
actor authority or override the membership cap.

The frozen context contains only immutable `app`, current frozen `auth`, an
`AbortSignal` named `signal`, and transaction-bound read-only Capsule `db`.
These trusted cross-owner reads bypass ordinary row ACLs; runtime tables, raw
adapters, writes, nested Privileged operations, provider APIs, logs, and Server
env or credentials are unavailable. Keep this callback provider-free. Read
capabilities and retained table/query/function aliases expire when the callback
settles, the transaction ends, cancellation occurs, or its five-second policy
budget expires. Await every read before returning.

Only an own data-property decision `{ allow: true }`, with no extra keys, admits
creation. Denial, malformed output, exceptions, abort, budget expiry, failed
reads (even if caught), and unfinished reads fail closed with opaque
`TEAM_POLICY_DENIED`. Policy failure poisons the outer transaction: catching a
rejection in Capsule code still rolls back app rows, Team rows, memberships,
and counters. This hook governs additional creation only;
`teams.authorizeDestructive` continues to govern destructive operations.

## Atomic destructive policy

Capsules with app-owned responsibility (for example a compatibility billing holder)
can opt into `teams.authorizeDestructive`. Its frozen context includes the
runtime-owned `ctx.app.publicOrigin`, with the same immutable identity as other
server contexts. This applies identically to direct
client SDK calls and server `ctx.teams.demote`, `removeMember`, `leave`, and
`delete`. `admitJoin`, mutation hooks, and `teamBilling.authorize` do not replace it.

```ts
teams: {
  async authorizeDestructive(ctx, input) {
    const rows = await ctx.db.responsibilities.where("teamId", input.teamId).all();
    // Missing or ambiguous responsibility is a refusal, never an inactive default.
    if (rows.length !== 1) return { allow: false };
    const responsibility = rows[0];
    if (!["active", "inactive"].includes(responsibility.state) ||
        !responsibility.holderUserId) return { allow: false };
    return { allow: responsibility.state === "inactive" || (
      input.scope === "member" && input.member.userId !== responsibility.holderUserId
    ) };
  },
},
```

The runtime acquires the exact Team lifecycle lock, rechecks current membership,
admin/final-admin predicates and the current Session, then invokes the policy
before any membership, role, counter, Join-link cleanup, or deletion write.
Input is an immutable `{ teamId, actorUserId, operation, member: { userId, role },
scope }`. `operation` is `demote`, `removeMember`, `leave`, or `delete`; `member`
is the exact affected current membership. `scope: "team"` on deletion means
**all** responsibility associated with that Team, including rows owned by other
users and rows naming former members. Deletion still requires the actor to be
the sole remaining admin member. Other operations have `scope: "member"`.

The policy context has only immutable `app` metadata, frozen `auth`, read-only
`db`, and `signal`. Its
transaction-bound Capsule reads bypass ordinary row ACLs so it can check
cross-owner responsibility. They confer no runtime-table, write, provider,
logging, environment, or nested Privileged authority. The caller receives only
the ordinary operation result or opaque `TEAM_POLICY_DENIED`; responsibility
rows, provider identifiers and callback errors are never returned or logged by
this boundary. Keep the policy local and await every read. Captured read handles
expire when the callback settles, aborts, or exceeds its five-second evaluation
budget. A non-cooperative callback cannot retain transaction authority.

Only an object with its own data property `allow: true` and no other properties
permits the operation. Missing/malformed/accessor decisions, exceptions, failed
or unfinished reads (even if caught), cancellation, unavailable storage, and
Session revocation/expiry refuse the operation. Refusal poisons the enclosing
transaction: catching it cannot commit earlier Capsule writes. The lock remains
held through outer commit or rollback, with current Session validity checked
again before commit. PostgreSQL also retains locks on that Session and User;
SQLite/libSQL use their writer transaction exclusion.

### Serialize responsibility changes

Every Capsule writer of protected responsibility must use the same lock **before
reading responsibility or making writes** in its existing write transaction:

```ts
transfer: mutation(async (ctx, teamId, recipientUserId) => {
  const snapshot = await ctx.teams.lockLifecycle(teamId, recipientUserId);
  const responsibility = await ctx.db.responsibilities.where("teamId", teamId).get();
  const acceptance = await ctx.db.acceptances
    .where("teamId", teamId).where("userId", recipientUserId).get();
  if (!responsibility || responsibility.holderUserId !== ctx.auth.userId ||
      snapshot.member?.role !== "admin" || !acceptance) throw new Error("Denied");
  await ctx.db.responsibilities.update(responsibility.id, { holderUserId: recipientUserId });
  await ctx.db.acceptances.delete(acceptance.id);
  await ctx.teams.demote(teamId, ctx.auth.userId);
}),
```

The Capsule must authenticate acceptance as an explicit action by the recipient
and bind it to the exact Team/transfer; restrict its writes with ordinary ACLs.
Promotion alone never transfers responsibility. `lockLifecycle(teamId,
memberUserId?)` returns `{ teamId, member }`, where `member` is the optional
requested current `{ userId, role }` or null. This is a snapshot under the retained
lock, not a reusable authority token. Normal `ctx.db` ACLs remain in force;
the lock grants no cross-owner write access or new Privileged authority.
Current-user calls require an administered Team and a current linked Session.

The same server-only seam is available to already-Privileged code in an existing
write transaction, including `stripeEvent({ consequence: "atomic" }, handler)`.
It grants that userless context only exact member inspection and serialization,
never membership mutation/admin authority. Nontransactional Jobs, read-only
queries, and expired contexts refuse the lock. Scheduled and other Privileged
Jobs can use the [resource-transaction alternative](jobs-and-schedules.md#team-lifecycle-locks-in-scheduled-jobs)
on SQLite or PostgreSQL. Use atomic Stripe consequences
for provider observations. Pending lock acquisition and member reads must finish
while the Privileged callback is active; otherwise they reject without returning
a snapshot and roll back the outer transaction even if caught. A successfully
admitted lock remains held through outer commit after its callback ends. Acquire
this lock before reading/updating the
Capsule's responsibility, billing state, or accepted-transfer records. Use one
Team per transaction (or a consistent Team-ID order when several are necessary).
A separately committed transfer, a wrapper-only check, or a writer omitting
this seam cannot provide the shared invariant.

Never hold the membership transaction open for provider network calls. Persist
local intent atomically, then let durable Jobs perform provider work after commit
and converge observations through the atomic seam. Runtime membership counters,
last-admin protection, admission/capacity rules, and Team Billing seat staging
retain their existing behavior and rollback boundaries.

### Compatibility and rollout

This is an additive 0.9.x contract. Omitting `authorizeDestructive` preserves
existing behavior and requires no storage migration. A present non-function
rejects Capsule startup. Before opting in, migrate/repair responsibility and
acceptance rows and route **every** protected writer through `lockLifecycle`;
missing/ambiguous rows should deny until repaired. Removing the declaration
removes this Capsule-owned guard, so treat that as a deliberate policy change.
Downstream must consume a published 0.9.x package and update its registry lockfile;
an unpublished checkout does not satisfy its release gate.

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
    read: async ({ row, ctx }) => await ctx.acl.teams.isMember(row.teamId),
    write: async ({ next, previous, ctx }) => await ctx.acl.teams.isAdmin((next ?? previous).teamId),
  }),
}
```

Use `isMember(teamId)`, `isAdmin(teamId)`, `hasRole(teamId, role)`, or `hasAnyRole(teamId, roles)` with an explicit Team ID. Role checks authorize only active declared roles. These decisions work in normal File ACLs too:

```ts
files: {
  acl: {
    read: async ({ file, ctx }) => await ctx.acl.teams.isMember(file.path.split("/")[2]),
    delete: async ({ file, ctx }) => await ctx.acl.teams.hasRole(file.path.split("/")[2], "author"),
  },
}
```

Team ACL helpers may be synchronous on SQLite and asynchronous on remote
database engines. Await their results in portable rules; starting a helper read
from a synchronous rule and ignoring it is denied fail-closed.

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
        trialDays: 14,
        quantity: { kind: "fixed", value: 1 },
        stripe: {
          sandbox: { productId: "prod_test_studio", priceId: "price_test_studio", portalConfigurationId: "bpc_test_studio" },
          live: { productId: "prod_live_studio", priceId: "price_live_studio", portalConfigurationId: "bpc_live_studio" },
        },
      },
      agency: {
        quantity: { kind: "team-members", minimum: 5 },
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

A product may declare `trialDays`, an integer from 1 through 90. Checkout passes
it as Stripe's `subscription_data.trial_period_days`; omitting it preserves
ordinary paid Checkout. The allowance belongs to the Team across products,
Sessions, and recurring intervals.
A second trial Checkout is refused with opaque `TEAM_BILLING_DENIED`.
The runtime durably reserves the allowance before the first provider request:
a lost reply, local expiry, abandoned Checkout, or provider failure does not reset it.
A verified `checkout.session.expired` observation releases an unused reservation;
local timeouts alone cannot prove that no trial started. Retry the same request
ID to recover the original operation. The trial length
is frozen when Checkout is admitted, including retries and erasure recovery.
Verified historical trial evidence also prevents another trial after cancellation.

Only verified Subscription evidence grants the paid product's entitlement.
`trialing` includes `productKey`, `quantity`, and an ISO UTC `trialEndsAt`;
apps should treat it as entitled to that product, including a trial scheduled
for cancellation. Subscription updates converge to `active` or `past-due`,
and deletion converges to `cancelled`, through the normal webhook fence.
Checkout completion or the browser return alone grants nothing.

Product keys are lowercase stable application identities. Each product binds
exact sandbox and live Prices and declares a positive fixed quantity,
`team-members`, or `usage`. A `team-members` policy may declare
an optional positive integer `minimum`; Sporades then bills the greater of the
accepted-member count and that floor. Omitting `minimum` preserves the existing
one-seat minimum. The declaration is server-only; the browser cannot select a
mode or Price.

A product can offer several recurring intervals with a `prices` map in each
mode binding. Product identity and reviewed Portal configuration stay per
product:

```ts
stripe: {
  sandbox: {
    productId: "prod_test_kitchen",
    portalConfigurationId: "bpc_test_kitchen",
    prices: {
      "month:1": { priceId: "price_test_kitchen_month" },
      "year:1": { priceId: "price_test_kitchen_year" },
    },
  },
  live: {
    productId: "prod_live_kitchen",
    portalConfigurationId: "bpc_live_kitchen",
    prices: {
      "month:1": { priceId: "price_live_kitchen_month" },
      "year:1": { priceId: "price_live_kitchen_year" },
    },
  },
}
```

Each mode declares either `priceId` or `prices`, never both. A `prices` map
contains 1–32 entries keyed by canonical `day:N`, `week:N`, `month:N`, or
`year:N` intervals with positive integer counts (maximum 1095 days, 156 weeks,
36 months, or 3 years). Every Price ID is unique across the entire catalogue,
including both environments. Verified recurring interval/count must match its
declaration. Existing single-`priceId` bindings and callers remain unchanged;
Sporades does not infer an interval for those legacy declarations.

For a `prices` binding, Checkout and managed Plan requests require the exact
`interval` key, even when the map contains only one Price. For example:

```ts
await teamBilling.startCheckout({
  teamId, requestId: crypto.randomUUID(), productKey: "kitchen", interval: "year:1",
});
await teamBilling.requestPlanTransition({
  teamId, requestId: crypto.randomUUID(), productKey: "kitchen", interval: "month:1",
});
```

`authorize` receives `productKey` and `interval` at admission and again before
provider I/O. Unsupported or omitted intervals fail closed. Reusing a request ID
for a different interval conflicts. Verified `trialing`, `active`, `cancelling`, `past-due`,
and `cancelled` billing truth includes the declared `interval`; legacy bindings
omit it. The stored verified interval is checked against the active Price declaration across
restarts. Reassigning a Price to a different interval returns `attention-required`
until fresh valid provider evidence arrives. When migrating a legacy binding to
`prices`, obtain a fresh verified Subscription observation before relying on its interval.

A Price can also declare a default currency and exact regional amounts. This
works on a legacy `priceId` binding or on each entry in an interval `prices` map:

```ts
"month:1": {
  priceId: "price_test_kitchen_month",
  currency: "gbp",
  unitAmount: 1900,
  currencyOptions: {
    eur: { unitAmount: 2500 }, usd: { unitAmount: 2900 },
    aud: { unitAmount: 3900 }, nzd: { unitAmount: 4500 },
  },
}
```

Currency codes are lowercase three-letter ISO codes; amounts are integer minor
units from 0 through 99,999,999. Declaring currency facts requires both `currency`
and `unitAmount`. `currencyOptions` contains at most 32 additional currencies,
with one `unitAmount` per currency, excluding the default currency. Configure
these same amounts on the bound Stripe Price's `currency_options`. Decimal,
tiered, custom-amount and transformed-quantity pricing are outside this contract.

```ts
await teamBilling.startCheckout({
  teamId, requestId: crypto.randomUUID(), productKey: "kitchen",
  interval: "month:1", currency: "usd",
});
```

Checkout passes the chosen currency to Stripe; this example charges USD 29 per
unit. Omitting `currency` on a currency-declared Price selects its declared
default explicitly. Unsupported currencies fail before any provider call.
`authorize` receives the resolved `currency` at admission and before provider
I/O. The selection is durable across retries and erasure recovery; reusing a
Checkout request ID with a different currency conflicts.

Verified subscription observations must match the configured currency amount
and the initial Checkout selection. Billing truth includes the observed
`currency` on trialing, active, cancelling, past-due and cancelled subscriptions. Stored
amounts are checked against the current declaration when reading truth, so
removing a currency or changing an amount requires fresh verified evidence.
Existing identity-only Price bindings continue to work; currency is absent on
older stored evidence until a new currency-bearing observation arrives.

Plan and interval transitions preserve the observed subscription currency.
`requestPlanTransition` accepts an optional `currency` assertion, which must
equal the existing currency. Capsule policy receives that existing currency.
A declared target Price must support it; a currency-declared source cannot
transition to an identity-only target. Incompatible requests return
`TEAM_BILLING_CURRENCY_MISMATCH` with a safe explanation. If target support is
removed while queued, the operation fails with `currency-mismatch`. Seat
convergence and Portal Price switches also retain the subscription currency;
configure Portal choices to support the currencies you offer.

Sporades conservatively retains one currency for a Team's bound Customer even
after cancellation. A later Checkout in another currency is refused. Use the explicit currency handover below to replace that agreement.

### Change a Team's billing currency

```ts
const handover = await teamBilling.startCurrencyHandover({
  teamId, requestId: crypto.randomUUID(), productKey: "agency",
  interval: "month:1", currency: "eur",
});
```

This separate durable operation requires a configured Checkout and one verified,
active, non-cancelling Subscription without a schedule or pending provider update.
The target Price must declare the requested currency. A current linked Team admin
must pass `authorize` for `operation: "currency-handover"` both at admission and
before each provider attempt. Policy receives target `productKey`, `interval`,
`currency` and verified source `fromProductKey`, `fromInterval`, `fromCurrency`.
The Capsule owns consent copy, including the new amount and currency.

Poll with the same exact request until `ready`, then navigate to its validated,
expiring Stripe-hosted setup Checkout URL. Setup collects a payment method for the
existing Customer and charges nothing. Browser return alone does nothing. After
verified setup completion, Sporades persists a paid-through entitlement latch,
cancels the old Subscription with `prorate: false` and `invoice_now: false`, and
creates the replacement with that payment method, the old period end as
`billing_cycle_anchor`, and `proration_behavior: "none"`. The initial period is
free; the first new-currency charge is due at the anchor. Stripe requires the
anchor to fall within the target's first billing period; an incompatible interval
is refused before cancellation. Trials require an ordinary plan transition first.
See [Stripe's currency rules](https://docs.stripe.com/invoicing/multi-currency-customers)
and [billing anchors](https://docs.stripe.com/billing/subscriptions/billing-cycle).

A non-zero old-currency Customer balance refuses the operation before setup and
is checked again before cancellation. The provider-free result is
`{ state: "failed", reason: "customer-balance-nonzero", ... }`
(internal safe code `TEAM_BILLING_CUSTOMER_BALANCE_NONZERO`). Resolve that balance
explicitly before starting a new request. Sporades never converts or forfeits it.

`get(teamId)` keeps exposing the old active product throughout setup and the
cancel/create gap. Only verified replacement Subscription evidence moves the
entitlement to the new currency; provider acknowledgement does not. Durable
provider idempotency and startup convergence recover uncertain cancellation or
creation, including lost replies. Retries are bounded. If replacement fails,
the latch expires at the old paid period end even if its cancellation webhook
is missing; the app may then offer ordinary Checkout after terminal evidence.
The latch never extends paid access. Ordinary Checkout, Portal and managed plan
writes are fenced while a handover is active. An uncertain dispatched replacement
remains fenced after retry exhaustion. At the paid period end, a serialized
provider discovery closes the fence only when no active replacement exists;
otherwise verified Subscription evidence must resolve it. Restart retries this
safe-close discovery. A fresh request cannot create a second subscription. Provider-safe erasure fences the
handover and discovers/cancels a replacement even after a lost create reply.

The operation returns `pending`, `ready`, `completed`, `expired`, or `failed`;
failed reasons are `authority-changed`, `customer-balance-nonzero`, and
`unavailable`. Reusing a request for a different tuple returns
`TEAM_BILLING_REQUEST_CONFLICT`. A second concurrent handover returns
`TEAM_BILLING_CURRENCY_HANDOVER_ACTIVE`. The fake covers setup, balances,
no overlapping active currencies, non-prorated cancellation, anchored charging,
webhook order and restart recovery. Real Stripe acceptance remains a separate
sandbox/test-clock check. Existing tax configuration remains operator-owned;
this operation does not enable Stripe Tax or add tax registrations.

For offline activation validation, use the server-only Stripe export:

```ts
import { validateTeamBillingPriceEvidence } from "sporades/server/stripe";

validateTeamBillingPriceEvidence({
  catalogue: teamBillingDeclaration.catalogue,
  mode: "sandbox",
  evidence: savedStripePrices,
});
```

Save Stripe Price objects with `currency_options` expanded. Evidence may be an
array or a Stripe list object with `data`. Validation requires exactly one saved
Price per active-mode binding and checks its identity, Product (when declared),
mode, activation, recurring interval (when declared), per-unit licensed pricing,
and every declared currency amount. Missing, extra or incorrect currency options
fail with `TEAM_BILLING_PRICE_EVIDENCE_MISMATCH`; diagnostics contain no provider
facts. Legacy bindings receive identity and recurring-shape checks. The function
performs no provider I/O. Capsule-owned activation commands such as the
daily-build-template's `payments:validate-activation --price-evidence` can call
this validator; those commands are maintained in their own repositories.

### Resource-counted quantities

Use `usage` for licensed per-venue, per-location, or per-project pricing. It is
an exact resource count, not Stripe metered event billing:

```ts
teamBilling: {
  catalogue: {
    multi: {
      quantity: { kind: "usage", meter: "maxVenues", minimum: 6, maximum: 50 },
      stripe: {
        sandbox: { priceId: "price_test_venues" },
        live: { priceId: "price_live_venues" },
      },
    },
  },
  usage: async (ctx, { teamId }) => ({
    maxVenues: (await ctx.db.venues.where("teamId", teamId).all()).length,
  }),
  authorize: async (ctx, input) => ({ allow: await isBillingHolder(ctx, input.teamId) }),
  checkout: { successPath: "/billing/success", cancelPath: "/billing/cancelled" },
}
```

The required `usage(ctx, { teamId })` hook returns counts keyed by meter, so an
existing `billingUsage(ctx.db, teamId)` function can supply the result. Counts
must be exact safe integers from zero through 999999, including resources from
every creator in the Team and any legacy rows that belong to it. Never return
a partial or estimated count. Missing meters, failed or unfinished reads,
invalid results, exceptions, and five-second budget expiry fail closed. Hook
access bypasses row ACLs for read-only Capsule tables, expires on settlement,
and carries no current-user, write, runtime-table, or provider capability.
All calls run inside the exact Team lifecycle lock and transaction.

Meter names match `[a-zA-Z][a-zA-Z0-9_]{0,63}`. Optional `minimum` and `maximum`
are positive integers through 999999, with maximum at least minimum. The
billable quantity is `max(count, minimum ?? 1)`. Zero resources therefore bill
one unit unless a larger floor is declared. `maximum` is an admission ceiling;
it never truncates the resource count billed for existing data.

Every resource mutation must first `await ctx.teams.lockLifecycle(teamId)`
before reading or writing resources. For an active or past-due usage Plan,
Sporades compares the initial and final exact counts before commit, refuses
increases above `maximum`, and stages quantity convergence in the resource
transaction. A failed mutation rolls back both resources and billing intent.
Decreases remain possible when existing data already exceeds a newly lowered
maximum. The same behavior applies to transaction-bound
`privilegedCtx.teams.lockLifecycle(teamId)`. This lock does not grant row ACL
permissions or replace the Capsule's resource authorization.

Checkout and managed Plan transitions refuse a usage target above maximum.
Before subscribing, or when an app imposes tighter product limits, its own
admission/`authorize` policy must check the exact count in the locked
transaction. Writes that omit the lifecycle lock do not trigger immediate
quantity staging; startup repair reconstructs missing intent from the exact
hook count. Provider updates use the existing latest-wins durable controller,
stable proration date and `create_prorations`, with no Stripe I/O inside the
resource transaction. If usage changes while Checkout is open, the first
Subscription observation must still match the issued Checkout. Sporades retains
that validated association and stages the latest exact quantity; billing stays
pending until corrected Subscription evidence arrives. Only verified
Subscription evidence settles the target. Usage quantity changes, drift repair,
and startup repair preserve the selected recurring interval and exact Price.
The stateful Stripe fake accepts these licensed quantities and can inject drift
with `subscriptions.setQuantity(...)`.

### Billing authority

Every operation re-reads the exact Team membership inside its transaction. A
current linked Team administrator reaches the Capsule policy for every
customer-directed command, which makes the Capsule-specific decision from
transaction-bound read-only app tables. The same callback has only the
transaction-bound `ctx.teams.countMembers(input.teamId)` inspection, allowing a
downgrade policy to recheck exact accepted seats immediately before provider
I/O. It cannot inspect another Team, enumerate members, or retain the count
surface after callback settlement. This authority-only count returns
`{ totalCount, adminCount }`: both are exact accepted-membership counts from the
same snapshot under the Team lifecycle lock. `adminCount` counts only accepted
members whose management role is `admin`; ordinary members and pending Join
links do not use an administrator seat. Existing consumers of `totalCount`
continue to work. The browser, current-user, and Privileged count APIs still
return only `{ totalCount }`.

A Capsule that sells administrator seats separately can check its target
product's staff limit for both Checkout and managed plan transitions, including
direct SDK calls:

```ts
async authorize(ctx, input) {
  const holder = await ctx.db.billingHolders.where("teamId", input.teamId).get();
  if (holder?.userId !== ctx.auth.userId) return { allow: false };
  if (input.operation === "checkout" || input.operation === "plan-transition") {
    const { adminCount } = await ctx.teams.countMembers(input.teamId);
    const product = input.productKey ? products[input.productKey] : undefined;
    return { allow: product !== undefined && adminCount <= product.maxStaff };
  }
  return { allow: true };
}
```

Here `products` is the Capsule's server-owned product policy. Administrator
counting does not change the built-in `team-members` billing quantity, which
continues to count all accepted members. The runtime does not expose a
`teams.admitPromote` policy hook.

Safe `read` authorization may
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
Tied observations retain an attached schedule until newer verified evidence
clears it. Below-floor usage evidence for an existing Subscription retains
terminal latches without staging quantity repair.

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

The result is a closed `inactive`, `pending`, `trialing`, `active`, `cancelling`,
`past-due`, `cancelled`, or `attention-required` projection containing Team ID,
declared product key, safe quantity, and bounded lifecycle timestamps where
appropriate. It never contains Stripe Customer, Subscription, Price, Event, or
operation identifiers, raw provider errors, Job state, idempotency keys, or an
unvalidated URL. Cross-Team, former-holder, anonymous, non-admin, and stale
Session requests receive the same generic `TEAM_BILLING_DENIED` result.

Checkout admission and its reserved Job are committed together. Repeating the
same Team/request/product/interval reads the same `pending`, `ready`, `completed`,
`expired`, `superseded`, or safe `failed` operation without another provider
call; reusing the request for another product or interval is a safe conflict. Immediately
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

New Checkout requests refuse with `TEAM_BILLING_SUBSCRIPTION_EXISTS` while the
Team has any non-terminal Subscription, including cancelling, past-due or
trialing subscriptions. A completed Checkout with a known Subscription also
blocks a new purchase while Subscription evidence is missing or quarantined;
only exact verified terminal evidence releases that guard. The worker
rechecks this before creating a Session.
Verified terminal cancellation or `incomplete_expired` permits a new Checkout;
expiry is exposed as provider-free `cancelled` state. Repeating an already
completed request still returns its historical `completed` result.

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
The configuration's `subscription_update.trial_update_behavior` must be
`continue_trial` by default, or `end_trial` when `transitions.endTrial: true`
is declared. Missing or mismatched trial behavior refuses Portal creation.
Products sharing a configuration must share the same quantity policy: fixed
quantities match only the same fixed value, while Team-member quantities match
only the same declared `minimum` (including whether it was omitted). The
session always names the reviewed configuration explicitly, so changing
Stripe's mutable Dashboard default has no effect. Configuration drift fails
closed.

`teamBilling.openPortal` is durable and idempotent by Team and request. It
rechecks the original actor, Capsule policy, Customer, Subscription, mode,
configuration, and return path immediately before session creation. Only a
strictly validated `billing.stripe.com` URL is exposed, and a runtime Job erases
it at local expiry even when the app is abandoned. The app renders every
button, progress state, error, retry, and navigation action; Portal return and
provider acknowledgement never update billing truth.

Portal supports switches whose source and target share the same quantity
policy, including monthly/annual switches within one product. Its exact
Product-to-Price allow-list must include every declared Price for the products
sharing that configuration. Interval changes also use the managed command,
within one product or across products. A switch between fixed,
accepted-Team-member, or usage quantities uses the managed command instead.
Changing a usage meter, floor, or maximum also changes its quantity policy:

```ts
const transition = await teamBilling.requestPlanTransition({
  teamId,
  requestId: crypto.randomUUID(),
  productKey: "agency",
});
```

To use the same command for fixed→fixed or other same-quantity-policy product
switches, opt in on the trusted declaration:

```ts
teamBilling: {
  catalogue,
  transitions: { allowSamePolicy: true },
  authorize,
}
```

Omitting `transitions` or setting `allowSamePolicy: false` preserves
`TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED` for same-policy switches without
an interval change. With the option enabled, every declared target can use the
existing Subscription in place. Keep legacy Prices as catalogue entries even
when they are no longer offered: `authorize` decides which targets are offered
and receives `fromProductKey` and, for a `prices` binding, `fromInterval` from
the verified source under the Team lifecycle lock. `productKey` and `interval`
remain the requested target. Source entries need not be purchasable. Repeating
a completed transition authorizes against the current source.

Admission and the final Stripe read refuse these states with distinct safe
codes. Worker refusals settle the operation as failed without a provider update:

| Subscription state | Safe code |
| --- | --- |
| Cancellation scheduled | `TEAM_BILLING_SUBSCRIPTION_CANCELLING` |
| `past_due` or `unpaid` | `TEAM_BILLING_SUBSCRIPTION_PAST_DUE` |
| An attached schedule | `TEAM_BILLING_UNKNOWN_SCHEDULE` |

Sporades does not own Subscription Schedules yet, so every attached schedule
is unknown. These guards apply to cross-policy and interval switches
as well as the opt-in same-policy path.

A switch during `trialing` preserves the existing `trial_end` by default,
including interval changes; the target product's `trialDays` does not start a
new trial. Verified Subscription evidence grants the target product with the
same `trialEndsAt`. Automatic seat convergence also preserves the trial.
To end trials when switching, declare the server policy:

```ts
transitions: { allowSamePolicy: true, endTrial: true }
```

`endTrial` is a boolean server declaration, never a browser request option.
For a verified trial, Sporades records that choice with durable plan intent and
sends `trial_end: "now"` alongside the Price and quantity update. Stripe ends
the trial and starts billing immediately; payment-action requirements still
use the existing pending-update flow. Retries and restart repair retain the
original choice. Provider acknowledgement grants no entitlement; settlement
requires verified Subscription evidence of the target and the ended trial.
If the trial has already ended before dispatch, the final provider read refuses
a changed target rather than resetting a paid period. An already-active exact
target is acknowledged without another write and still awaits verified evidence.
Portal configuration must match this policy as described above.

Fake-provider tests cover trial preservation, immediate ending and invoicing.
Real Stripe API trial preservation still requires a manager-run test-clock
check; see the [trial-transition research note](../research/2026-11-09-team-billing-trial-transitions.md).

The app renders the returned `pending`, `completed`, `superseded`, or safe
`failed` state. The response contains no intent, Job, Price, Customer,
Subscription, item, or idempotency identity. Repeating the same
Team/request/product/interval observes the same operation; reusing its request ID for a
different product or interval is a safe conflict. Capsule `authorize` remains the local
business-policy seam, including whether a downgrade is allowed.

Admission and the desired-state Job commit together. Before each provider
attempt Sporades reauthorizes the original linked Team administrator, re-reads
the current Subscription and catalogue, and derives the accepted-member count,
floored by the target's declared `minimum` when it uses `team-members`. It
updates the one attested Subscription item Price and quantity together using Stripe
`create_prorations`, the desired intent's stable `proration_date`, and
`pending_if_incomplete`; it does not create an immediate standalone invoice.
Payment action required becomes a safe failed state for app-owned recovery.
Retries preserve the exact provider tuple and idempotency key.

For an active `team-members` Plan, a committed Join, removal, or leave stages
seat convergence after the membership transaction. Staging or provider outage
cannot roll that membership change back. New counts supersede stale queued or
in-flight intent, and a durable per-Team lane permits only one provider write
at a time across runtime instances. Startup repair compares accepted
Subscription quantity with the billable Team count after applying any floor
and reconstructs absent, failed, or drifted work. This is eventual provider
convergence, not a database transaction held across Stripe I/O.

A successful Stripe update is only acknowledgement: public state remains
pending. The acknowledgement must still own its provider lane, desired intent,
Job generation, and operation; a superseded response cannot replace a newer
operation's failure or authorization denial. Exact verified `customer.subscription.*` evidence settles the desired
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
cancelling, and cancelling outranks active, and active outranks trialing; provider Event identifiers are not
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

## Test Team Billing with a loopback provider

A Dev session can send all runtime-owned Team Billing Stripe requests to a local
protocol stub instead of Stripe:

```sh
SPORADES_DEV_STRIPE_API_ORIGIN=http://127.0.0.1:52345 sporades dev --json
```

This process-only setting follows [ADR 0058](../adr/0058-team-billing-test-provider-boundary.md).
Use an exact `http://127.0.0.1:<port>` or `http://[::1]:<port>` origin (`https`
is also accepted), with a port from 1 to 65535. Explicit scheme-default ports
are preserved, including `http://127.0.0.1:80` and `https://[::1]:443`.
Hostnames including `localhost`,
other loopback addresses, credentials, paths (even `/`), queries and fragments
are refused with `STRIPE_API_ORIGIN_INVALID`; empty and whitespace values also
refuse. Enabled Stripe payments must use `livemode: false` and a resolved Sealed
Server secret beginning with `sk_test_`, or startup refuses with
`STRIPE_TEST_ORIGIN_LIVE_MODE`. A dormant configuration is accepted with a warning
and performs no provider work.

The CLI passes the admitted value to every initial and replacement Dev runtime.
Checkout, Portal configuration attestation and sessions, managed Subscription
updates, seat convergence and erasure quiescence share that origin. A test suite
can start a tiny `node:http` stub on an ephemeral loopback port and pass its
origin in the child Dev process environment. For a stateful provider with signed
callbacks, see [Test Team Billing without Stripe](./team-billing-testing.md).

The setting is never a `sporades.json` key or a Server env value, and it is never
exposed through `ctx.env`. All commands outside `sporades dev`, including deploy,
Host operations and explicit builds, refuse while it is set with
`STRIPE_TEST_ORIGIN_DEV_ONLY`. Unset it before running those commands. Bundles,
including private Dev action Bundles, and Container/Hosted launch state never
carry the value. Container and Hosted runtimes do not read it.

`sporades dev --json` reports `payments.stripe.providerOrigin: "loopback-test"`
in the `started` event. Each runtime start emits the platform warning
`payments.stripe.test_origin_active`. With the variable unset in the diagnostic
shell, `sporades doctor --session dev --json` reports the same marker from the
running runtime, without revealing the stub origin or port. Public Dev sessions
may also use the override.

Capsule-owned `createStripePaymentIntegration` calls, including the generated
payment foundation, keep their explicit `apiBaseUrl` option; this variable is
not injected into them. Webhook verification remains local HMAC verification.

Passing a local stub test certifies **nothing about live Stripe**: it does not
attest Stripe's sandbox/live API behavior, Dashboard Portal configuration,
payment methods, tax, SCA, delivery timing, or production readiness. Real Stripe
acceptance remains a separately authorized human check.
