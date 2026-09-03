# Reject an unusable log payload cap

Status: ready-for-agent

## Parent

.scratch/log-payload-cap-floor/PRD.md

## What to build

`logs.payloadMaxBytes` (and its `logging.payloadMaxBytes` alias) accepts any
positive integer, including values too small for the events a Capsule actually
writes to carry their payloads.

There is no single threshold here, and the first draft of this ticket wrongly
asserted one. Envelope overhead varies with the Capsule name and id and with the
event's `event`, `message`, `request`, `release`, and `correlation` values: a
minimal envelope with a one-character Capsule name and `{"x": 1}` data
serializes to about 245 bytes and survives a 256-byte cap, while the runtime's
own Dev events do not. The defect is not "caps below N are unusable" but that a
cap is accepted without any stated guarantee about what it must still be able to
carry.

Reproduced with `logs.payloadMaxBytes: 256` on a Dev session, one server change.
Both entries the session produced:

```
dev.session.started   | truncated: true | data: {"truncated":true}
dev.capsule.reloaded  | truncated: true | data: {"truncated":true}
```

The mechanism is in `src/server-runtime-source.ts`: `logPayloadMaxBytes`
(~line 2215) accepts the configured value unchecked, and `capLogEnvelope`
(~line 2608) sheds `data` keys in reverse order by assigning the string
`"[TRUNCATED]"`, then — if the serialized envelope still exceeds the cap —
replaces `data` wholesale with `{ truncated: true }` and truncates `message`.

The operator gets no signal. Logging appears configured and running while every
structured payload is discarded, which is the failure mode most likely to be
discovered during an incident, when the logs are being read for the first time.

Reject the unusable cap at configuration validation instead. Clamping is the
weaker option: silently substituting a different value for an explicitly
configured one trades this surprise for another.

## Acceptance criteria

- [ ] The guarantee a cap must preserve is written down first, as an explicit bounded envelope shape — which fields are counted, at what maximum sizes, and how much `data` must survive — not as a single representative event.
- [ ] The minimum is computed from that stated shape against the real envelope, so it stays correct if envelope fields change, rather than being a constant in the source.
- [ ] A cap that cannot honour the guarantee is rejected at config validation with a structured error and an actionable hint, in the same shape as other invalid configuration keys.
- [ ] A cap that can honour it is accepted unchanged; caps usable today for minimal envelopes are not rejected on the strength of the runtime's own larger events.
- [ ] The `logging.payloadMaxBytes` alias is validated identically.
- [ ] A cap at exactly the minimum still yields structured `data` for an envelope of the stated shape.
- [ ] Tests cover a rejected cap, a cap at exactly the minimum, an ordinary cap, and a minimal envelope that a small cap can still legitimately carry.
- [ ] The configuration guide documents the minimum and what it protects.

## Blocked by

None - can start immediately

## Comments

Found while reviewing mgscox/sporades#29 (Dev session reload visibility). Kept out of that
PR deliberately: it affects every event and every Capsule rather than the Dev
reload event, so it belongs with configuration validation rather than inside a
Dev reload log call site. The reload surface in that PR bounds itself at
ordinary caps and does not depend on this work.
