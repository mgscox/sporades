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

A Capsule may declare `teams.admitJoin` in trusted server code to decide whether a validated Join link may create a new membership. The policy receives the target `teamId`, joining `userId`, and exact `currentMemberCount`, plus a transaction-bound context containing read-only `ctx.db`, `ctx.auth`, `ctx.env`, and `ctx.log`.

```ts
export default capsule({
  name: "team-notes",
  schema: { subscriptions: table({ teamId: String(), seats: Number() }) },
  teams: {
    async admitJoin(ctx, { teamId, currentMemberCount }) {
      const subscription = (await ctx.db.subscriptions.where("teamId", teamId).all())[0];
      return { allow: Boolean(subscription && currentMemberCount < subscription.seats) };
    },
  },
});
```

The runtime invokes this policy only after authentication, Join-link validation, intended-recipient matching, and the Team lifecycle lock, but before membership insertion. The check, any read-only `ctx.db` access, capability consumption, and membership insert share one transaction. Concurrent joins for a final seat therefore serialize against the same Team row: one may commit and the next observes the new exact count. A denial or policy error rolls the transaction back and returns only the generic `TEAM_JOIN_DENIED` client error; policy data and internal errors are not exposed. Browser callers cannot supply, alter, or omit this policy. Capsules without `admitJoin` preserve the 0.8.1 Join behavior, and idempotent retries by an already-joined member do not create or re-admit a membership.

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

## Security, storage, and audit boundaries

Team state is runtime-owned and persists outside the Capsule schema through the configured Database adapter. Team creation, bootstrap, Join redemption, membership changes, role reconciliation, and last-admin checks use transaction boundaries so concurrency cannot create duplicate memberships or an adminless Team. Team state survives runtime restart and has adapter conformance coverage.

Team administrative outcomes are ordinary redacted security events, not Privileged audit events. Logs, public errors, inspection output, and recoverable runtime state exclude Join codes, complete Join URLs, target emails outside the admin-only link-management result, Session tokens, provider subjects, credentials, and raw payloads.

Team admin authority manages membership. Membership application roles express Capsule-declared responsibilities. Capsule ACL authority is the explicit policy the Capsule writes with `ctx.acl.teams`. The Privileged server role is separate userless server authority: it is not a Team admin, member, application role, or browser credential. Inside an active audited `ctx.privileged.run(...)` callback, `privilegedCtx.teams` offers only exact-Team read-only inspection: `countMembers`, `listMembers`, `listJoinLinks`, and `inspectJoinLink`. The first three require an existing explicit Team ID and otherwise fail with `TEAM_NOT_FOUND`; `inspectJoinLink` keeps its safe invalid-capability result. This projection never lists a current user's Teams, validates email-bound links, or changes Team state, and it exposes no raw rows or recoverable Join capabilities.

For precise browser and server signatures, see the generated [client Teams API](/api/types/client.TeamsApi.html), [server current-user Teams API](/api/types/server.CurrentUserTeamsApi.html), and [server Privileged Teams API](/api/types/server.PrivilegedTeamsApi.html).
