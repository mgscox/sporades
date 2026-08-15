# Changes

## 0.8.2 - 2026-08-15

### ✨ Built-in Teams

- Add backward-compatible cursor pagination to client and server
  `teams.listMembers`, including deterministic ordering and an exact uncapped
  `totalCount`; the capped Team-summary count remains display-only.
- Add trusted Capsule `teams.admitJoin` policy with transaction-bound, read-only `ctx.db`
  reads and Team-row serialization, so concurrent final-seat joins cannot
  oversubscribe. Capsules without a policy retain 0.8.1 Join behavior.

## 0.8.1 - 2026-08-14

Corrects the incomplete `0.8.0` package release with the merged `main` runtime,
generated artifacts, and documentation.

### 📝 Documentation

- Require current password to change email credentials (bfba651).

### ✨ Built-in Teams

- Add runtime-owned Teams for Capsule collaboration: multi-Team memberships,
  admin lifecycle, email-bound Join links, membership application roles, and
  explicit Team decisions in table and File ACLs. Teams are built in but do
  not select a current Team or automatically partition Capsule data; Sporades
  never sends Join-link email. See the [Built-in Teams reference](https://mgscox.github.io/sporades/reference/teams).
