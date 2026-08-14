# 06 — Validate Join links after authentication

**What to build:** Give a Capsule a non-consuming valid-or-invalid check it can call after email registration, email sign-in, or OAuth completion to learn whether the current linked user's attached email matches a Join link, without Sporades enforcing verified-email policy or mutating the account.

**Blocked by:** 02 — Bootstrap Teams during account linking; 05 — Create and manage email-bound Join links.

**Status:** ready-for-agent

- [ ] The browser Team interface accepts an opaque Join code and returns only a normal structured result containing `{ valid: boolean }` for ordinary capability outcomes.
- [ ] The trusted server Team interface exposes the same non-consuming validation semantics for the current linked user.
- [ ] Validation requires a linked, non-guest current user; Anonymous users receive `valid: false` without consuming or reserving the link.
- [ ] Validation compares the grant's normalized target email against normalized email credentials and Provider identity emails belonging to the current Sporades user.
- [ ] Validation never trusts an email address supplied by the browser at validation time.
- [ ] Email matching is case-insensitive after the existing normalization rules and works for accounts with multiple linked identities.
- [ ] Email registration, email sign-in, and every supported OAuth callback can be followed by validation without special provider-specific Team calls.
- [ ] Sporades checks email equality only and does not require, infer, persist, or enforce provider-level or mailbox-level verified-email policy for Teams.
- [ ] Malformed, unknown, expired, revoked, consumed, email-mismatched, non-linked, and otherwise unauthorized capabilities return `valid: false` without revealing the reason.
- [ ] Infrastructure and transport failures remain structured errors rather than being misreported as ordinary invalid capability state.
- [ ] Validation does not consume, reserve, rotate, extend, or otherwise change the Join grant.
- [ ] A false result does not create membership, delete or disable an account, alter identities, remove the initial Team, or send a message.
- [ ] Validation results and logs do not expose the target email, verifier material, Team membership lists, or provider subjects.
- [ ] Tests cover email credentials, OAuth identities with present and absent email, multiple linked identities, normalized casing and whitespace, mismatch, every invalid capability state, repeated validation, no verified-email enforcement, client/server parity, and generated runtime.
