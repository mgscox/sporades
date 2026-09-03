# Reject an unusable log payload cap

Status: ready-for-human

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

- [ ] The maintainer ratifies the bounded envelope shape below, or replaces it. This is the decision the rest of the ticket depends on, because it determines which existing Capsule configurations stop validating.
- [ ] The minimum is computed from the ratified shape against the real envelope, so it stays correct if envelope fields change, rather than being a constant in the source.
- [ ] A cap that cannot honour the guarantee is rejected at config validation with a structured error and an actionable hint, in the same shape as other invalid configuration keys.
- [ ] A cap that can honour it is accepted unchanged; caps usable today for minimal envelopes are not rejected on the strength of the runtime's own larger events.
- [ ] The `logging.payloadMaxBytes` alias is validated identically.
- [ ] A cap at exactly the minimum still yields structured `data` for an envelope of the stated shape.
- [ ] Tests cover a rejected cap, a cap at exactly the minimum, an ordinary cap, and a minimal envelope that a small cap can still legitimately carry.
- [ ] The configuration guide documents the minimum and what it protects.

## Proposed guarantee, for ratification

Offered so the decision is concrete rather than open. Every field is an upper
bound used only to compute the minimum; none of them constrains what a Capsule
may actually log.

| Field | Bound | Rationale |
| --- | --- | --- |
| Capsule name and id | 64 bytes each | Comfortably above the names the templates generate |
| `event` | 64 bytes | Longest runtime event name today is well under this |
| `message` | 128 bytes | Runtime messages are one short sentence |
| `category`, `level` | 16 bytes each | Fixed vocabularies |
| timestamps, ids | measured, not bounded | Fixed width |
| `request`, `release`, `correlation` | null | Absent on the platform events this protects |
| surviving `data` | 256 bytes | Enough for a small structured object rather than a sentinel |

A cap that cannot carry an envelope of that shape is rejected. A cap that can is
accepted unchanged, including caps that only ever carry smaller envelopes than
the runtime's own events — an operator logging exclusively tiny payloads is not
doing anything wrong.

The open question for the maintainer is the last row. A larger surviving-`data`
bound protects more real events and rejects more existing configurations; a
smaller one is more permissive and lets more events silently truncate.

## Blocked by

None - the decision above is the only prerequisite, and it is a maintainer call
rather than a blocked dependency.

## Comments

Found while reviewing mgscox/sporades#29 (Dev session reload visibility). Kept out of that
PR deliberately: it affects every event and every Capsule rather than the Dev
reload event, so it belongs with configuration validation rather than inside a
Dev reload log call site. The reload surface in that PR bounds itself at
ordinary caps and does not depend on this work.
