# Database adapter is an internal runtime boundary

Sporades will introduce Database adapter as an internal runtime boundary below the stable `ctx.db` authoring API. The adapter covers all SQL-backed runtime persistence, including app tables, schema migrations, auth storage, file metadata storage, log index, system metadata, and inspection commands, so code above the adapter remains agnostic to the selected database engine.

The first slice extracts the current `node:sqlite` behavior into a no-behavior-change SQLite adapter. Service-backed SQLite-compatible adapters can follow once local Capsule service provisioning exists. Public Database adapter or plugin APIs are deferred until at least two internal adapters prove the shape.

