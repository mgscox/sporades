# Log payload cap floor

Status: ready-for-human

## Source Planning

- `docs/guide/configuration.md`
- `src/server-runtime-source.ts` (`logPayloadMaxBytes`, `capLogEnvelope`)
- `CONTEXT.md`

## Problem Statement

`logs.payloadMaxBytes` and its `logging.payloadMaxBytes` alias accept any
positive integer. `capLogEnvelope` applies that cap to the *serialized
envelope*, not to `data` alone, and when shedding every `data` key is still not
enough it replaces `data` wholesale with `{ truncated: true }` and truncates
`message`.

Envelope overhead is not a constant: it varies with the Capsule name and id and
with the `event`, `message`, `request`, `release`, and `correlation` values of
the event being written. So there is no single byte count below which every cap
is unusable and above which every cap is safe. What exists instead is a range in
which a cap is large enough for some events and silently destroys others, with
no signal to the operator that it is happening.

Observed on a Dev session configured with `logs.payloadMaxBytes: 256` — both
events the session produced lost their payload:

```
dev.session.started   | truncated: true | data: {"truncated":true}
dev.capsule.reloaded  | truncated: true | data: {"truncated":true}
```

Logging appears configured and running while carrying nothing. That is the
failure mode most likely to be discovered during an incident, when the logs are
being read for the first time and the events that mattered are already gone.

## Goals

- Decide and document the guarantee a configured cap must preserve, stated as a
  bounded envelope shape rather than a single representative event.
- Refuse a cap that cannot honour that guarantee, at configuration validation,
  with a structured error and an actionable hint.
- Leave every cap that can honour it working exactly as it does today.

## Non-Goals

- Do not change `capLogEnvelope`'s shedding order or its truncation fallback;
  the fallback is correct behaviour for an event that genuinely overruns a
  usable cap.
- Do not silently clamp a configured value. Substituting a number the operator
  did not write trades one invisible surprise for another.
- Do not attempt a per-event guarantee for unbounded fields. A sufficiently long
  `message` or `correlation` can overrun any cap, and that remains the
  envelope's business rather than the validator's.
