Status: ready-for-agent

# Serialize The Bundle Preamble Constants

## What to build

The generated Capsule server bundle carries a constant preamble that **restates
the values** of seventeen module constants declared in the runtime source. Two
sources of truth that can silently disagree.

Issue 13's guard cannot see this, and that is the point: it resolves *names*, and
a wrong value resolves exactly as cleanly as a right one. So the class of defect
issue 13 closed — a reference the bundle cannot satisfy — is loud, while this one
is silent. It is the more dangerous of the two.

Several of the duplicated values are security thresholds: the email sign-in
failure limit and its throttle window, the password reset TTL bounds, and the cap
on outstanding reset codes per email. A preamble copy drifting below or above its
source would change how a deployed Capsule enforces them while every test — which
imports from `dist/`, where the real declarations live — stayed green. The
remainder are the privileged auth user id, throttle field names, the reset path
and mail job names, the reserved job-name prefix, the privileged audit schema,
actor kinds and outcomes, and the ACL helper state key.

They all agree today; issue 13's reviewer diffed every one. This is about removing
the possibility, not repairing a present mismatch.

Issue 13 already proved the fix pattern on three `Set` constants it had to add:
serialize the real exported value into the preamble rather than restating it,
following the `PUBLIC_TREE_LIMITS` precedent that already existed in the same
file. Sixteen of the seventeen take that pattern directly. The seventeenth,
`ACL_HELPER_STATE`, is a `Symbol` and needs its description serialized into a
`Symbol(...)` construction rather than a value.

Prefer deleting the duplication over testing it. A test asserting the two agree
would be a third thing to keep in step.

## Acceptance criteria

- [ ] No constant's value is written twice; the preamble derives every value from the runtime source's own declaration.
- [ ] `ACL_HELPER_STATE` is reconstructed as a Symbol with the same description, and the ACL paths that key off it work in the emitted bundle.
- [ ] Changing a constant's value in the runtime source changes the emitted bundle, demonstrated by mutating one and observing the preamble follow.
- [ ] Issue 13's free-binding guard still passes, and the bundle-booting suites still pass.
- [ ] No behavioural change: the values the bundle carries after this are identical to the values it carries before.

## Blocked by

- None — can start immediately.
