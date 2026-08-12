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
