Status: ready-for-agent

# Add Privileged Actor Identity And Sentinel Guardrails

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Represent Privileged server role execution with explicit server-side actor semantics. The derived privileged context keeps the familiar `auth` shape with `userId: "__privileged__"`, while Privileged audit events remain the security source of truth through `actorKind: "privileged-server-role"`. The sentinel must not be creatable, resolvable, or requestable as a real Sporades user.

## Acceptance criteria

- [ ] `privilegedCtx.auth.userId` is `__privileged__` and ordinary session contexts continue to use normal runtime-generated user IDs.
- [ ] Privileged audit events emitted by privileged runs include `actorKind: "privileged-server-role"` regardless of the auth sentinel used inside the callback.
- [ ] Browser requests, Session tokens, local identity simulation, provider linking, and auth flows cannot create or resolve a real user with the sentinel ID.
- [ ] Browser/client transports cannot import, request, or carry Privileged server role authority.
- [ ] Privileged writes do not automatically stamp ownership fields such as `ownerId`; any sentinel ownership value must come from explicit Capsule code.

## Blocked by

- .scratch/privileged-server-role/issues/02-add-minimal-ctx-privileged-run.md
