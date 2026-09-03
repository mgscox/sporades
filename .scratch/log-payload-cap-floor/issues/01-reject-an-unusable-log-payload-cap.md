# Reject an unusable log payload cap

Status: ready

## Parent

None - standalone config-contract fix.

## What to build

`logs.payloadMaxBytes` (and its `logging.payloadMaxBytes` alias) accepts any
positive integer, including values too small for any log event to carry its
payload. Below roughly 400 bytes every event silently loses its structured
`data`, because the envelope wrapped around `data` costs about 300 bytes before
`data` contributes anything.

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

- [ ] A `logs.payloadMaxBytes` below the minimum a complete envelope needs is rejected at config validation with a structured error and an actionable hint, in the same shape as other invalid configuration keys.
- [ ] The minimum is derived from the actual envelope overhead rather than a guessed constant, and stays correct if envelope fields change.
- [ ] The `logging.payloadMaxBytes` alias is validated identically.
- [ ] A cap at exactly the minimum still yields structured `data` for a representative event.
- [ ] Tests cover a rejected cap, a cap at the minimum, and an ordinary cap.
- [ ] The configuration guide documents the minimum and what it protects.

## Blocked by

None - can start immediately

## Comments

Found while reviewing mgscox/sporades#29 (Dev session reload visibility). Kept out of that
PR deliberately: it affects every event and every Capsule rather than the Dev
reload event, so it belongs with configuration validation rather than inside a
Dev reload log call site. The reload surface in that PR bounds itself at
ordinary caps and does not depend on this work.
