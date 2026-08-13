# Runtime-Owned Password Reset Links

Sporades owns the password reset token lifecycle in the server runtime and
leaves every user-visible surface to the Capsule. The runtime generates,
stores, verifies, and consumes Reset codes and revokes Sessions; the Capsule
owns the reset page, its route, its styling, and the email copy. Capsule code
never chooses the entropy source, the stored representation, the expiry, or the
comparison, and the browser never receives anything but an opaque Reset code it
relays back.

There is no Sporades-hosted reset page. Firebase's default tier works because
`firebaseapp.com` is a real origin owned by the platform; Sporades has no
equivalent, and inventing one would put a Sporades-branded page on a Capsule's
auth flow and require a Sporades-operated origin in the trust path of every
private Host server. The reset page is therefore always a Capsule route on the
Capsule's own origin. This removes the tier that Firebase users most often
replace anyway, and makes the branded path the only path rather than the
upgrade path.

## Reset code

A Reset code is a short-lived, single-use runtime record binding one email
credential to one password reset attempt, with creation and expiry times and a
consumption marker. The code is a split selector/verifier pair: 16 CSPRNG bytes
of selector and 32 CSPRNG bytes of verifier, encoded base64url and joined by a
single `.`. The runtime stores the selector as the primary key and stores only
the SHA-256 of the verifier. Lookup is an ordinary indexed read on the
selector, and the verifier is compared with a constant-time equality check, so
neither storage nor lookup timing distinguishes a wrong code from an unknown
one. A leaked database yields no usable Reset code.

Reset codes live in the runtime-owned `sporades_auth_password_reset_codes`
table alongside the other `sporades_auth_*` tables and migrate the same way.
They are not Capsule app schema and do not appear in `ctx.db`. The verifier and
the assembled code are never logged; the stored column names fall under the
existing runtime log redaction patterns.

Reset codes expire one hour after issue by default, bounded by configuration to
between five minutes and twenty-four hours. Issuing a new code does not
invalidate outstanding codes for the same email, so an attacker cannot
repeatedly request resets to invalidate a link the victim is about to use;
instead the number of outstanding unexpired codes per email is capped, and
expired rows are pruned on write. Consuming a code deletes that code and every
other outstanding code for the same Sporades user.

## Verify and confirm are separate

Verification does not consume. `verifyPasswordResetCode(code)` returns the
email the code was issued for so the Capsule's page can render which account is
being reset, and can be repeated. Only `confirmPasswordReset(code,
newPassword)` spends the code.

This split is not a convenience. Enterprise mail security products fetch every
URL in a delivered message before the recipient sees it, so any design that
consumes the code on the link's GET destroys the reset before the user clicks
it. Consumption requires the confirm call carrying a new password, which link
scanners do not make.

## Link construction

The reset link is built from a canonical Capsule origin taken from Capsule and
Host configuration, never from a request's `Host`, `X-Forwarded-Host`, or
`Origin` header. A request header in the link would let an attacker who can
reach the Capsule mail a victim a genuine Sporades reset link pointing at the
attacker's server.

The reset page location is configured as `auth.email.passwordReset.path`, a
same-origin absolute path validated at configuration time, defaulting to
`/reset-password`. It is a path rather than a URL, and no caller-supplied
continue or return URL is accepted from the browser or from the link, so the
reset flow cannot become an open redirect. Firebase needs an authorized-domain
allowlist for exactly this reason; a path makes the failure unrepresentable
instead of configurable.

The Reset code is carried as a single query parameter on that path. The Capsule
page reads it and calls the client auth API.

## Public surface

Server-only, on the existing `ServerAuthApi` beside `setEmailPassword`:

- `sendEmailPasswordResetLink(email, options?)` — create a Reset code and
  deliver it over the runtime SMTP transport.
- `createEmailPasswordResetLink(email, options?)` — create a Reset code and
  return `{ link, expiresAt }` without sending anything, for Capsules that
  deliver through their own mail path.
- `verifyPasswordResetCode(code)` — non-consuming, returns `{ email }`.
- `confirmPasswordReset(code, newPassword)` — consuming.

Browser, through the existing client transport rather than a bundled auth SDK:
`auth.sendPasswordResetLink(email)`, `auth.verifyPasswordResetCode(code)`, and
`auth.confirmPasswordReset(code, newPassword)`. As with `auth.signIn`, the
client sends intent and an opaque code; runtime auth internals stay on the
server.

`options` accepts subject and text/HTML body overrides for Capsules that want
the built-in delivery with their own copy. A Capsule that wants full control of
the message uses `createEmailPasswordResetLink` with `ctx.mail.send`. Both tiers
share one token implementation.

## Enumeration

`sendEmailPasswordResetLink` and the client `auth.sendPasswordResetLink` resolve
identically for registered and unregistered emails. After the common throttle,
both paths create an opaque code and enqueue the same runtime-owned Reset-request
Job; neither performs account lookup, Reset-code storage, or mail work in the
request path. No error, count, database sequence, or timing distinguishes the two.

The Job performs account lookup later. An unregistered address completes as a
successful no-op without a Reset row or SMTP send. A registered address stores
the code and sends the message; the opaque code travels in the Job payload so a
retry reuses the same link and outstanding-code slot. Delivery outcomes belong
to the Job rather than to the caller, so neither account existence nor transport
health is observable from the reply.

`createEmailPasswordResetLink` is deliberately not uniform: its entire purpose is
to return a link, so it fails with a bounded error for an unregistered email.
It is server-only and never reachable from the browser, and a Capsule that
exposes its result to an unauthenticated caller reintroduces enumeration in
Capsule code. This asymmetry is intentional and documented on the API.

Reset requests are throttled per normalized email and per caller using the same
throttle shape as email sign-in failures, so the endpoint is not a free mail
cannon against the Capsule's SMTP reputation.

## Confirmation is an Auth transaction

Spending the Reset code, writing the new password hash and salt, deleting the
user's other outstanding Reset codes, and deleting every `sporades_auth_sessions`
row for that Sporades user happen in one Auth transaction. A failure leaves the
code unspent and the old password and Sessions intact; success evicts every
existing Session, including an attacker's, which is the point of the reset.

The browser that completed the reset is not signed in as a side effect. It
keeps its Anonymous session and the Capsule sends the user through the normal
`auth.signIn("email", ...)` path with the new password. Minting a Session from
a code delivered by email would make mailbox access alone sufficient for a
live Session without the user demonstrating the new credential.

## Delivery is a runtime-owned Job

Reset mail is delivered by the durable Job queue, following the Capsule-facing
durable-mail pattern, so it survives restarts and is retried rather than
dropped. Job execution is at least once, so each Reset code carries the
idempotency key `password-reset:<selector>` and yields exactly one message.

The handler is owned by the runtime, not the Capsule: requiring a Capsule to
declare a reset-mail Job would hand it the token this ADR keeps runtime-owned.
Runtime handlers therefore live in a reserved `_sporades` name prefix, and a
Capsule declaring any Job in that namespace fails at load with
`RESERVED_JOB_NAME`. Job names resolve by string, so the namespace has to be
reserved for runtime ownership to mean anything. The whole prefix is reserved
rather than the individual names in use, so adding a runtime Job later is not a
breaking change.

The queue row is written directly rather than through the current-user Job API.
That API batches enqueues onto the calling Capsule context whenever a
transaction is open, and runtime code has no such context, so a batched row
would be discarded. A direct insert joins whatever transaction is already
active, so a caller that rolls back discards the Job with it.

## Mail configuration

`createEmailPasswordResetLink`, `verifyPasswordResetCode`, and
`confirmPasswordReset` work whether or not `mail.smtp` is configured; only
delivery needs a transport. `sendEmailPasswordResetLink` fails with a bounded
error and a hint pointing at `mail.smtp` in `sporades.json` when mail is
disabled, matching the runtime's error-code-and-hint convention. A Capsule
without SMTP can still implement reset through its own delivery path.

## Browser password changes are gated separately

`auth.setPassword` is the browser's direct password-change path and is not part
of the Reset code flow, but it targets the same credential, so it is gated
here. Three conditions are required, and all are necessary: a linked,
non-guest Session; that the named email is that Session's own credential; and
verification of that credential's current password.
Authentication establishes who is calling; the ownership check establishes
which credential they may change; and current-password verification confirms
the caller recently holds that credential's secret.

The gate lives on the browser path rather than inside `setEmailPassword`,
because that function is also the trusted server-only
`ctx.serverAuth.setEmailPassword` API, which is deliberately able to set the
password for any registered email. Unknown addresses and addresses belonging to
another user share one opaque `AUTH_EMAIL_NOT_OWNED` denial, so the gate cannot
be used to discover which addresses have accounts.

## Scope

This ADR covers email credential reset only. Provider identities have no
Sporades-held password, so a reset request for an email that exists only as a
Provider identity email follows the unregistered branch. It does not add
account recovery, email verification, or a second factor; a reset flow that
bypasses a future second factor would be an account takeover path, so
introducing one requires revisiting this decision.
