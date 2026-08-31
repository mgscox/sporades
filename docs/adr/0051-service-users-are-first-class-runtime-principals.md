# Service Users are first-class runtime principals

Capsules need named autonomous agents whose actions remain attributable even
when no human owns a particular credential. Reusing a human account gives the
automation a browser login and makes audit history name the wrong actor.
Keeping an app-only bot table has the opposite problem: Sporades cannot enforce
credential lifecycle, disabled-user denial, or exact actor provenance at the
authentication boundary.

Sporades therefore models a Service User as a first-class User kind. It has a
stable User ID, display name, active-or-disabled lifecycle, and runtime-owned
Access keys. It has no email, password, OAuth Provider identity, or browser
Session. Access-key admission exposes the Service User as `ctx.auth` with
`userKind: "service"` and the exact key as `ctx.credential`; existing human and
Anonymous contexts retain their legacy shape, where an absent `userKind` means
human.

A Mutation handler uses `ctx.serviceUsers` to create a Service User with an
initial key, issue additional named keys, rotate or revoke an exact key, list
safe metadata, or irreversibly disable the User. Every call requires and
transactionally rechecks a current linked human Session. Transaction state is
not authority: the Mutation dispatcher binds a runtime-owned capability that
Capsule input and middleware cannot forge. Access keys, endpoints, Queries,
App messages, Jobs, Schedules, lifecycle hooks, Anonymous sessions, and guest
sessions cannot use the interface even when their work is transactional.
Plaintext leaves the runtime only after a successful issue or rotation commits.
Every lifecycle Promise joins the Mutation's pending-work drain. Every plaintext
token produced by create, issue, or rotation must additionally occur in the
Mutation's returned JSON data; otherwise the whole transaction rolls back instead
of silently creating an unrecoverable credential. This rule remains exact through
returned `Promise.all`, `allSettled`, `race`, and `any` results and cannot be
satisfied merely by attaching a fulfillment, rejection, or cleanup observer.
Rejected drained work rolls back the complete Mutation.
Disabling retires every current key and prevents future admission while
retaining bounded User and key metadata for historical audit.

Use a Service User when the autonomous actor itself must be named and governed:
for example a ticket-triage agent with application Team memberships and roles.
Keep a human-owned Access key when automation is merely another credential for
that human and should inherit their identity. Capsule tables remain responsible
for application roles, Team membership, and resource policy; service identity
and key scopes only narrow that authority and never create it.

The benefit is one authentication model for humans and automation, exact
actor-plus-credential attribution, atomic lifecycle controls, and no fake login
identity. The costs are an explicit application mapping from Service User IDs to
roles/resources, an administrator recovery path for key loss, and irreversible
disablement rather than a convenient but ambiguous pause. Capsules must store
the one-time bearer token in an external secret store and must never persist it
in their own tables or logs.
