# Operations and Hosting Reference

Logs, database inspection, Container sessions, Hosted Capsules, Doctor, workflows, and troubleshooting.

[Back to the feature reference index](../guide/reference.md).

## Inspect Logs and Data

In **another** terminal, from the Capsule directory:

```sh
sporades logs
sporades db list
sporades db dump --json
sporades db query "select * from todos" --json
```

`sporades db query` is read-only. Use it to inspect state, not to patch around
application logic.

## Inspecting and Debugging

### Logs

Use `ctx.log` in server handlers:

```ts
ctx.log.info("Project created", { id: project.id });
ctx.log.warn("Near quota", { userId: ctx.auth.userId });
ctx.log.error("Webhook failed", { reason });
```

Read logs from a running Dev session:

```sh
sporades logs
sporades logs --json
sporades logs tail --json
```

Pass `--port` to inspect a local Container session instead:

```sh
sporades logs --port 4000 --json
sporades logs tail --port 4000 --json
```

`ctx.log` entries and Sporades platform runtime events share the
`sporades.log.v1` envelope: `timestamp`, `category`, `event`, `level`,
`message`, `capsule`, optional `release`, optional `request`, optional
`correlation`, and structured `data`. App logs use `category: "app"` and
`event: "ctx.log"`; runtime events use `category: "platform"`. This JSONL log
stream is separate from `sporades dev --json`, which only streams Dev-session
lifecycle events such as start and rebuild status.

Structured log data is redacted before it is written. Keys such as passwords,
tokens, secrets, authorization headers, cookies, API tokens, and client secrets
are replaced with `[REDACTED]`; exact Server env values are also redacted if
they appear in structured log data. Request method and path may be recorded, but
raw request bodies are not logged by default. Each log event is capped to a
bounded payload size, with oversized structured data marked as truncated.

The JSONL log stream lives under the Runtime directory by default and is the
primary durable stream for CLI tailing, Host collection, Docker stdout, and
crash-adjacent debugging. SQLite stores only a bounded recent log index for
inspection queries; `sporades logs --json` reads that index, while
`sporades logs tail --json` prints JSONL events from the durable stream. Local
Container sessions and Hosted Capsules also emit JSON log events to Docker
stdout.

### Fatal Runtime Restart Policy

Fatal runtime paths are handled by mode, and the policy is reported in JSON
status output:

- **Dev** sessions restart automatically after unhandled rejections, uncaught
  exceptions, and failed `init()` or `shutdown()` lifecycle boundaries. The
  terminal, `sporades dev --json`, and the structured log stream report the
  fatal event, restart attempt, and exhaustion state. `SIGTERM` and `SIGINT`
  still exit the Dev session.
- **Local Container** sessions run with Docker `--restart on-failure:3`. Fatal
  runtime exits such as unhandled rejections, uncaught exceptions, and failed
  startup hooks get bounded restarts instead of infinite loops. `sporades
  deploy --json` includes the restart policy.
- **Hosted Capsules** also run with Docker `--restart on-failure:3`. Start,
  restart, stats, health, release verification, and release history surfaces
  expose lifecycle and restart-policy details. When a Hosted Capsule cannot be
  kept running, its route returns the Hosted Capsule unavailable response.

During `sporades host push --verify`, fallback to the previous release is only
available when explicitly requested with
`--fallback-to-previous-release`. This opt-in fallback applies to release
verification only. Later runtime crashes after a release has already been
verified or accepted do not automatically fall back; they use restart/backoff,
structured failure output, Docker logs, and the unavailable response when
retries are exhausted.

### Database

List tables:

```sh
sporades db list
sporades db list --port 4000
```

Dump everything:

```sh
sporades db dump --json
sporades db dump --port 4000 --json
```

Run a read-only SQL query:

```sh
sporades db query "select id, createdAt from todos order by createdAt desc" --json
sporades db query "select id, createdAt from todos order by createdAt desc" --port 4000 --json
```

If a query cannot connect, confirm `sporades dev` is running or pass the right
`--port`.

### JSON Output

Commands that support `--json` return:

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

Errors use the same envelope and exit with code `1`:

```json
{
  "ok": false,
  "data": null,
  "error": {
    "message": "Missing SQL query.",
    "hint": "Use `sporades db query <sql>`."
  }
}
```

Use `--json` for scripts and agents. Use plain output when you are working by
hand.

### Inspect and retire Access keys

Authorized operators use the running Capsule's Privileged projection; the CLI
and Host helper never open Auth tables directly:

```sh
sporades access-keys list --user-id <user-id> --session dev
sporades access-keys inspect <key-id> --session container
sporades access-keys revoke <key-id> --session hosted --host <alias> --subname <name> --yes
sporades access-keys revoke-all --user-id <user-id> --session hosted --host <alias> --subname <name> --yes
sporades access-keys delete <key-id> --session dev --yes
```

Only these five commands exist; operators cannot issue or rotate keys and never
receive plaintext. List and inspect are read-only. Revoke and delete require a
typed confirmation or `--yes`; bulk revocation requires the exact owner ID.
`--json` never implies consent. Every route rejects a stopped Capsule rather
than opening a partial runtime, uses immutable IDs rather than email/display
name selectors, validates a strict bounded action envelope, and emits
runtime-owned exact-target Privileged audits. Dev, Container, and Hosted source
attribution comes from the running runtime session, not caller input.

## Try a Container Session

When the Capsule works locally, test it in Docker:

```sh
sporades deploy
```

This starts a local Container session by bundling the Capsule, mounting the
Bundle files and Server env into a Node container, and persisting SQLite data in
the Runtime directory. Re-running `sporades deploy` replaces the previous local
container for this project.

Use a different port when needed, e.g. if 'dev' is running at same time:

```sh
sporades deploy --port 5000
```

Inspect a running local Container session by passing its port to the same log
and database commands:

```sh
sporades logs --port 4000
sporades logs tail --port 4000 --json
sporades db list --port 4000
sporades db dump --port 4000 --json
sporades db query "select * from todos" --port 4000 --json
```

Use the port from `sporades deploy --json` if you do not know which port the
Container session is using.

## Local Container Sessions

`sporades deploy` is for production-like local testing:

```sh
sporades deploy
sporades deploy --port 5000
sporades deploy --force
sporades deploy --json
sporades deploy stop --json
sporades deploy restart --json
sporades deploy remove --json
```

The command:

1. Bundles the server and client.
2. Stops and removes the previously bound local container, if one exists.
3. Prepares the Sporades Base image automatically.
4. Runs the Capsule in Docker using the Sporades Base image as the invoking
   host UID/GID when available.
5. Mounts Sealed Server env or legacy Server env read-only.
6. Persists SQLite data through the Runtime directory.
7. Writes the container binding to `.sporades/binding.json`.

Use `--force` if the previous Docker container was deleted manually and the
local binding is stale.

Lifecycle commands operate on the local Container session recorded in
`.sporades/binding.json`:

| Command | Effect |
| --- | --- |
| `sporades deploy stop` | Stops the bound Docker container and any generated local Capsule services. The binding and persistent data remain in place. |
| `sporades deploy restart` | Starts the stopped bound Docker container again, starting declared Capsule services first when needed. It does not rebuild bundles. |
| `sporades deploy remove` | Force-removes the bound Docker container, removes `.sporades/binding.json`, and stops generated local Capsule services. Persistent data remains in the Runtime directory. |
| `sporades deploy reset` | Removes the bound Docker container when present, stops generated services, and deletes generated Capsule service state such as Compose volumes, networks, and Sporades-owned service data. |

When running through the scaffolded npm script, pass flags after `--`:

```sh
npm run deploy -- --force
```

## Container SSH Access

Container SSH access is an explicit, opt-in compatibility and emergency access
path for local Container sessions and Hosted Capsules. It is not the primary
Sporades management interface. Keep using the structured CLI surfaces for
deployment, logs, stats, restarts, Host registration, and recovery; use
Portainer or similar container tooling when you want a broader container
management UI.

Configure Container SSH access in `sporades.json` with a top-level `ssh` object
and `authorizedKeys` entries. Each entry is an object with exactly one source:
`key` for one inline public authorized-key line, or `file` for public
authorized-key material read by the CLI.

```json
{
  "name": "notes",
  "ssh": {
    "authorizedKeys": [
      { "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample developer@workstation" },
      { "file": "~/.ssh/id_ed25519.pub" },
      { "file": "ops/authorized_keys.pub" }
    ]
  }
}
```

`file` entries resolve on the CLI machine before a local Container session
starts or a Hosted Capsule release is packaged. Supported file references
include absolute paths, `~`, and project-relative paths. Absolute paths are
used as-is, `~` expands to the CLI user's home directory, and project-relative
paths resolve from the directory containing `sporades.json`. Hosted Capsule
releases include only generated public authorized-key material. Original file
paths are not retained: original source paths are not copied into Hosted Capsule releases.
Those source paths are also omitted from Host registries and container metadata.

Sporades preserves OpenSSH `authorized_keys` semantics. A `key` entry provides
one authorized-key line. A `file` entry may contain normal authorized-key file
content, including multiple public-key lines, comments, blank lines, key
options, and OpenSSH-supported public-key algorithms. Private-key-looking or
malformed material is rejected before container startup or release packaging
where possible. Empty effective key sets leave SSH disabled.

When SSH is enabled, sessions log in as the `sporades` user with key-based
authentication only. Sporades does not provide root login, sudoers access,
passwords, custom SSH ports, or public SSH port exposure. Release files remain
read-only; Capsule data remains the writable runtime area. Hosted Capsule SSH
ports are Docker-assigned and loopback-only on the Host server, separate from
Caddy HTTP routing.

Use explicit inspection commands for effective SSH state. `sporades deploy ssh`
inspects the local Container session, and `sporades host ssh` inspects a Hosted
Capsule through the configured Host server:

```sh
sporades deploy ssh
sporades deploy ssh --json
sporades host ssh team-notes --host personal
sporades host ssh team-notes --host personal --json
```

These commands report connection facts such as enabled state, user, host, port,
target port, key count, fingerprints, running state, and reason codes. Normal
`sporades deploy`, `sporades host push`, list, stats, and lifecycle output do
not include SSH state unless validation fails.

Indicative examples: Client SSH commands vary by OS, key agent, local SSH config, and tunneling
setup. Treat the examples as shape, not a contract.

```sh
# Local Container session: first inspect the Docker-assigned loopback port.
sporades deploy ssh --json
ssh -p <local-port> sporades@127.0.0.1

# Hosted Capsule: create an SSH tunnel to the loopback-only port on the Host server.
sporades host ssh team-notes --host personal --json
ssh -N -L <local-port>:127.0.0.1:<host-loopback-port> <host-profile-ssh-target>
ssh -p <local-port> sporades@127.0.0.1
```

## Hosted Capsules

Hosted Capsules run on a configured Host server. The server installation guide
covers machine setup. Once a Host server exists, the user workflow is:

```sh
sporades host add personal \
  --server root@example.com \
  --domain example.com \
  --remote-root /srv/sporades \
  --json

sporades host use personal
sporades host bootstrap --host personal --json
```

From a Capsule project directory:

```sh
sporades host register team-notes --host personal --json
sporades host push --host personal --subname team-notes --json
sporades host start team-notes --host personal --json
```

If the Capsule uses Sealed Server env, `host push` re-encrypts local sealed
values to the Hosted Capsule's current Host public key. The push packages only
the Host-encrypted sealed envelope with the release. Host private keys stay in
Host-owned persistent state and plaintext values do not cross the local-to-Host
boundary.

For normal release updates:

```sh
sporades host push --host personal --subname team-notes --restart --json
sporades host push --host personal --subname team-notes --verify --fallback-to-previous-release --json
```

Useful Hosted Capsule operations:

```sh
sporades host list --host personal --json
sporades host stats --host personal --json
sporades host stats team-notes --host personal --json
sporades host logs http --host personal --subname team-notes -n 200 --json
sporades host logs stdout --host personal --subname team-notes -n 200 --json
sporades host restart team-notes --host personal --json
sporades host stop team-notes --host personal --json
```

If a Capsule declares `services` today, those services are only managed for
local Dev sessions and local Container sessions. A later Hosted Capsule service
implementation should extend the existing `sporades host` surface so operators
can register, push, start, stop, restart, inspect, reset, back up, and recover a
Hosted Capsule and its required services from the same Host profile. It should
not introduce a separate `sporades services` namespace for Hosted operation.

**Push validation**

Sporades will review the uploaded bundle for unexpected files. On macOS, if tar includes AppleDouble metadata during push, it can cause rejection. Use:

```sh
COPYFILE_DISABLE=1 sporades host push --host personal --subname team-notes --restart --json
```

> Sporades will attempt to auto-ignore additional MacOS metadata, but it still may cause a false-postivie and reject the bundle - setting `COPYFILE_DISABLE` is guaranteed.

## Common Workflows

### Add a New Feature

1. Add fields or tables in `server/index.ts`.
2. Add a query for the screen's read model.
3. Add mutations for user actions.
4. Render the query with `useQuery()`.
5. Call mutations with `useMutation()`.
6. Watch the Dev session rebuild.
7. Inspect logs and data if anything looks wrong.

Schema changes may alter local data. Treat `.sporades/data.db` as runtime state,
not source code.

### Add Per-User Data

Store `ctx.auth.userId` in rows that belong to a user:

```ts
ctx.db.notes.insert({
  body,
  ownerId: ctx.auth.userId,
});
```

Filter reads with the same user ID:

```ts
ctx.db.notes.where("ownerId", ctx.auth.userId).all();
```

Do not accept `ownerId` from the client.

### Add a Server Secret

1. Pipe the value to `sporades env set <name> --stdin`; do not pass it as a
   command argument.
2. Check configuration with `sporades env has <name>` when automation needs a
   value-safe presence test.
3. Read it with `ctx.env`.
4. Restart `sporades dev`.
5. For Hosted Capsules, push and restart the Capsule; `sporades host push`
   re-encrypts local sealed values to the Hosted Capsule public key.

```sh
printf '%s' "$STRIPE_WEBHOOK_SECRET" \
  | sporades env set STRIPE_WEBHOOK_SECRET --stdin
sporades env has STRIPE_WEBHOOK_SECRET
```

Do not put secrets in `client/`, `shared/`, `index.html`, or `sporades.json`.

### Reset Local Runtime State

Stop local runtime processes without deleting persisted data:

```sh
sporades dev stop --json
sporades deploy stop --json
```

Restart or remove a stopped local Container session:

```sh
sporades deploy restart --json
sporades deploy remove --json
```

Inspect generated Capsule service state with structured JSON:

```sh
sporades dev status --json
sporades deploy status --json
```

Reset generated Capsule service state, including Compose networks, volumes,
orphans, and Sporades-owned Capsule service data for the current project:

```sh
sporades dev reset --json
sporades deploy reset --json
```

Reset only removes Sporades-managed Capsule service state. It does not remove
shared third-party service images such as database images.

## Sporades Doctor

`sporades doctor` is the read-only diagnostic coordinator for a Capsule project.
It gathers project configuration, security posture, Capsule authoring, local
runtime, Capsule service, and Hosted Capsule signals into one report. It does
not repair state, does not mutate Runtime files, does not start or stop
containers, and does not replace the focused inspection and lifecycle commands
that already own those jobs.

In short: doctor is read-only, does not repair state, and does not mutate
project or runtime state.

Run doctor without flags for project-level checks:

```sh
sporades doctor
```

Target a local Dev session, local Container session, or Hosted Capsule when you
want runtime-specific checks:

```sh
sporades doctor --session dev
sporades doctor --session container --json
sporades doctor --session hosted --host personal --subname team-notes --json
```

For CI and AFK agents, use strict JSON output:

```sh
sporades doctor --strict --json
```

Normal mode exits non-zero for failed checks. `--strict` also exits non-zero for
warnings, which makes it useful before handoff, release, or automated repair
loops. JSON output includes the check `id`, `scope`, `status`, `severity`,
message, optional hint, follow-up commands, and non-secret details.

Check statuses mean:

- `pass`: doctor inspected the surface and found the expected state.
- `warn`: doctor found drift, missing optional state, or risky configuration.
- `fail`: doctor found a blocking problem or could not inspect a required
  surface.
- `skip`: doctor did not have enough local state to run that check, such as a
  missing Dev or Container binding.

Doctor coordinates existing inspection surfaces instead of replacing them. Use
the `next` commands in doctor output to continue with the focused command that
owns the surface, including `sporades security`, `sporades env`, `sporades
deploy ssh`, `sporades host health`, `sporades host stats`, `sporades host
logs`, and `sporades host ssh`.

Doctor output avoids secrets. It may include fingerprints, counts, paths, and
structured state, but it must not print private keys, full Server env values, or
full SSH public-key material.

## Troubleshooting

- `Unknown command`: run `sporades --help`.
- Dev session cannot start on a port: pass `--port <number>` or update
  `sporades.json`.
- Browser does not update after auth config changes: restart `sporades dev`.
- `sporades logs` or `sporades db` cannot connect: start a Dev session or pass
  `--port`.
- Google sign-in is unavailable: run `sporades auth status` and confirm Google
  is enabled and configured.
- Container session fails immediately: run `sporades deploy --json` and inspect
  the structured error hint.
- Hosted Capsule route returns `503`: the Capsule is registered, but has no
  running container or the current release failed to start. Check
  `sporades host stats <subname>` and `sporades host logs stdout`.
- Hosted Capsule keeps crashing: inspect `sporades host logs stdout --subname
  <subname> --json`, then restart or push a fixed release. Automatic fallback
  only applies to `host push --verify --fallback-to-previous-release`, not to
  later runtime crashes.
