# Define scope declaration, grant, and matching semantics

Status: closed
Label: wayfinder:grilling
Parent: [Chart user-owned scoped Access keys](./00-chart-user-owned-scoped-access-keys.md)
Assignee: codex

**Blocked by:** None — can start immediately.

## Question

How do Capsules centrally declare Access key scopes, how are exact and wildcard grants issued and matched against optional `requireAuth` requirements, how are undeclared or changed scopes handled, and how do scopes only narrow the owning user's existing ACL, Team, and File authority without becoming a duplicate role system?

## Comments

### Resolution — 2026-08-20

The bundled `capsule()` definition is the sole declaration site for the Capsule's Access-key scope vocabulary. It declares concrete scope strings; the vocabulary is not duplicated in `sporades.json` and cannot be edited through runtime management. A changed Capsule definition may add or remove declarations.

Scope declarations are non-empty, unique, case-sensitive strings and cannot contain `*`. Grant expressions are likewise non-empty and unique, but may contain `*` anywhere. Matching is case-sensitive across the whole string, with `*` as the only special character. Sporades imposes no semantic grammar such as `resource:action`; naming scopes that correctly describe the protected work remains the Capsule developer's responsibility.

At issuance, omitted grants normalize to the immutable grant set `["*"]`; an explicit empty set is invalid. Any other grant expression must match at least one scope in the current definition. Grant expressions remain live against later definitions: a newly declared matching scope deliberately enters an existing wildcard grant, removing a declaration makes that authority inactive without rewriting the grant, and restoring the exact declaration reactivates it. A renamed scope is therefore a removal and an addition, with no inferred migration.

An Access key's grant expressions cannot be edited. Changing its name, authority, or expiry requires revoking it and issuing a new key; atomic secret rotation alone preserves the key and its grants.

`requireAuth` scope requirements must be concrete scopes in the current definition. Multiple required scopes use AND semantics, and each must match at least one grant when the admitted credential is an Access key. Omitted scope requirements mean no scope requirement. Credential-kind guards admit any credential by default; a permitted Session satisfies scope requirements without Access-key grants, after which ordinary user authorization continues. A Capsule that needs to exclude Sessions explicitly narrows the credential guard to Access keys.

Scopes only narrow the linked user's authority where Capsule code explicitly opts into a scope check. They never grant, replace, or automatically map onto ACL, Team, File, or other platform authority. In particular, Sporades imposes no mandatory File scope: private File reads authenticated by an Access key use the owner's existing File authority, while existing Session behavior remains unchanged. The Capsule decides where additional scope checks belong.

Credential and scope admission use the current key and Capsule definition, then snapshot the successful result for the admitted work. Later revocation or definition changes affect subsequent checks rather than interrupting work that already passed admission.
