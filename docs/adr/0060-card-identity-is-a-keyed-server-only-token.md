# ADR-0060: Card identity is a keyed server-only equality token

Status: Accepted

## Decision

Capsules may compare a card identity token after completed Checkout. Sporades
computes base64url HMAC-SHA256 of
`"sporades-card-identity\0v1\0" + mode + "\0" + card.fingerprint`, with `mode`
`sandbox` or `live`. Only the 43-character token leaves the provider-read
boundary. Raw Stripe fingerprints correlate with Dashboard, Radar and exports;
a leaked token ledger cannot be confirmed against those fingerprints without
the key. PaymentMethod IDs identify individual objects rather than cards.

The optional `payments.stripe.cardIdentityKeyEnv` names a dedicated Sealed Server
env secret, distinct from the Stripe and webhook secret names. Operators must
generate at least 32 random bytes of entropy. Runtime validation enforces a
nonblank 32–4096 UTF-8 byte value; it cannot measure entropy. Never derive the key
from either rotating Stripe credential or public `capsuleIdentity`. Diagnostics
name the env reference and never show its value. Omission preserves activation
and returns `STRIPE_CARD_IDENTITY_NOT_CONFIGURED` on card reads. A configured
missing or undersized key fails configuration validation before storage opens.

**Rotating this key invalidates all previously stored tokens. There is no
 dual-key window in v1.** Existing stored Team tokens are historical values;
new captures use the new key, so the Capsule must plan any ledger migration.

## Both server surfaces

`sporades/server/stripe` adds `readCheckoutCardIdentity({ sessionId })`. A single
GET retrieves Checkout with four exact expansions: `payment_intent.payment_method`,
`setup_intent.payment_method`, `subscription.default_payment_method` and
`subscription.pending_setup_intent.payment_method`. Only complete Sessions in
the configured mode and expanded PaymentMethod objects are admitted. Missing
methods, non-card methods and cards without fingerprints return `card: null`.
Unexpanded associations and malformed evidence refuse opaquely. Provider faults
follow ordinary bounded retry and cancellation conventions; GET has no
idempotency key. Disabled payments retain `STRIPE_PAYMENTS_DISABLED`.

The user-level Checkout creator still has no setup mode or trial options. A
card-collecting trial cannot currently be initiated through that foundation;
[follow-up #407](https://github.com/mgscox/sporades/issues/407) tracks it rather than widening this change.

Team Billing exposes `ctx.teamBilling.getCardIdentity(teamId)` in trusted
current-user, Privileged and atomic Stripe consequence contexts. Current-user
reads require linked Team membership, Team administrator authority and the
existing `read` authorization policy. Privileged reads are userless and revoked
with the callback. Atomic handlers receive only this provider-free read, often
still `pending`. No client API, WebSocket handler, projection, handshake or
payment activation snapshot gains the token.

After verified Checkout binds the Customer and Subscription, provider-free
convergence stages a private pending row and durable capture Job in the same
atomic Stripe transaction (ADR 0047). The Job retrieves the Subscription with
`default_payment_method` and `pending_setup_intent.payment_method` expanded,
attests exact Subscription, Customer and live-mode association, computes the
token transiently and writes only `card | none`, token and `capturedAt` alongside
local Team/operation/generation correlation. Payloads contain only local
operation and generation UUIDs; results are null. Failures are fixed and opaque.
Restart repair reconstructs missing work and replaces pending generations;
stale attempts cannot settle replacement-owned or erased rows. Bounded retry
exhaustion leaves the read pending until restart repair. No provider I/O enters
convergence or atomic Capsule handlers.

Currency handover captures again after verified replacement Subscription truth
settles the operation. A pending handover refresh does not expose the old token
as the replacement's card. Portal payment-method changes do **not** refresh in
v1: this answers which card started the Team's billing, rather than its current
payment method. Reads select completed operations in the current payment mode.
Provider-safe erasure (ADR 0049) deletes capture rows with billing rows; stale
workers never recreate them. The Capsule decides retention of any copied ledger.

A necessary durable-callback adjustment redacts PaymentMethod IDs and fingerprint
fields before enqueue, including expanded webhook objects. The internal envelope
retains only an original-payload SHA-256 digest for replay/quarantine comparison;
that internal field is omitted from Capsule event delivery. Direct signature
verification still returns its existing server-only Verified Stripe event. No
provider-read fingerprint or PaymentMethod ID enters a capture row, payload,
result, observation, log, telemetry or diagnostic.

## Capsule rule and limits

Sporades does not enforce one trial per card. The Capsule stores tokens under a
unique constraint and chooses the consequence. Identity is available only after
Checkout completes, when the trial Subscription already exists. Withhold the
Capsule entitlement for a duplicate, then cancel through Portal or provider-safe
erasure; Checkout cannot refuse it in advance. Never return the token in
browser-visible payment Job state, app messages, query results or logs.

Apple Pay and Google Pay can present device-specific card numbers, producing
different fingerprints for one physical card across devices or plain-card use.
This is a deterrent, not a guarantee. Fingerprints are per Stripe account;
tokens are deliberately not comparable across Capsules or accounts.

## Evidence and certification limits

The loopback fake deterministically hashes `"sporades-fake-card\0" + cardLabel`
to a 16-character hexadecimal fingerprint, stable across customers, processes,
reset and runs. Omitted methods default to card `4242424242424242`; non-card and
none controls model null identities. `state()` alone exposes fake PaymentMethods
and their fingerprints for assertions. Exact supported expansion paths remain
closed; arbitrary expansions are unsupported. ADR 0058's endpoint parity gate
continues to bind every provider SDK endpoint to a fake route.

Tests certify Sporades' model, including trial pending SetupIntents. They do
**not** certify that live Stripe `2026-08-26.dahlia` populates
`subscription.default_payment_method` or `pending_setup_intent.payment_method`
as modelled. A human Stripe sandbox check is required before a derived Capsule
relies on this behavior. No live Stripe calls are part of this implementation.
