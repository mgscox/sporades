# Configuration

`sporades.json` owns declared Capsule configuration. Sealed Server env owns
server-only values. `.sporades/` is generated runtime state and must not be hand-edited.

Use the detailed reference for:

- [HTTP security policy](../reference/projects-and-configuration.md#security-policy)
- [Sealed Server env](../reference/server-runtime.md#use-sealed-server-env)
- [current-user preferences](../reference/client-auth-and-preferences.md#user-preferences)

For exact generated paths, see the [runtime layout](../runtime-layout.md).

## Database backend

See [database configuration and local services](../reference/projects-and-configuration.md#configuration)
to choose between embedded SQLite, libSQL, and PostgreSQL.

## Mail

See the dedicated [Mail guide](./mail.md) for SMTP delivery, provider
configuration, durable delivery Jobs, and provider delivery-event webhooks.

## Structured log payload cap

`logs.payloadMaxBytes` caps the serialized JSON log envelope, including metadata
and the truncation flag; it is not a data-only budget. `logging.payloadMaxBytes`
is an alias. When both are present, `logs` takes precedence, and both explicitly
supplied values must validate as safe integers.

The minimum is computed from the same envelope constructor as the runtime writer.
It includes the actual configured Capsule name and ID (`capsule.id`, then `id`,
then name; absent name is `unknown`) and configured `release` value, including
JSON escaping and UTF-8 encoding. It reserves these additional allowances:

| Field | Protected allowance |
| --- | --- |
| `event` | 64 bytes of JSON-escaped UTF-8 content, excluding surrounding quotes |
| `message` | 128 bytes of JSON-escaped UTF-8 content, excluding surrounding quotes |
| `category`, `level` | 16 bytes each, measured the same way |
| `timestamp` | 24-byte UTC ISO timestamp, such as `2026-09-11T00:00:00.000Z` |
| `request`, `correlation` | `null` |
| `data` | 256 bytes of serialized JSON after redaction |
| `truncated` | `false`, including the field and value in the byte budget |

An event within all these allowances retains its structured data at the minimum.
These are protected allowances, not restrictions on the events a Capsule may log.
Longer messages, additional request/correlation metadata, per-event release
metadata exceeding the configured release, or larger data can still truncate.
Redaction continues to apply before budgeting.

Configuration loading and runtime startup reject values below the calculated
minimum with `INVALID_LOG_CONFIG` and a hint containing the required byte count.
There is no universal numeric floor and no new identity-length limit. The default
is still 4096 bytes; if even the default is too small for the configured identity
and release, set an explicit sufficient cap. Values are never silently raised.
Existing very small caps, numeric strings, and other non-integer values must be
replaced with valid numeric caps. Changing Capsule identity or release can change
the required minimum.
