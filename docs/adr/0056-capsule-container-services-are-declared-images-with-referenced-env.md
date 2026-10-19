# ADR-0056: Capsule container services are declared images with referenced env

Status: Proposed

## Context

Capsules increasingly need companion processes that are not a database or file
store: a `llama.cpp` server for embeddings, a search engine, a headless browser,
an OCR or transcoding worker. ADR 0020 made Capsule services declared intent in
`sporades.json`, with Sporades generating and owning the Docker Compose files,
but only the closed `database` (libSQL, Postgres) and `storage` (MinIO) kinds
exist. Their connection details are runtime plumbing injected as reserved
`SPORADES_SERVICE_*` variables that only the Database and Storage adapters read.

A companion service differs in three ways:

1. App code, not a runtime adapter, is its client, so the Capsule must learn a
   trustworthy address for it.
2. The image is third-party and arbitrary, so it is the least trusted process in
   the stack.
3. It usually needs configuration shared with the Capsule: provider tokens (for
   example `HF_TOKEN` to download a model), and a shared API key so only the
   Capsule can call it (for example `llama-server --api-key`).

Values like these already live in Sealed Server env (ADR 0023) and are exposed to
server code as `ctx.env`. The question is how a service receives a subset of
them, plus secrets that exist only to connect the Capsule to the service, without
weakening the Container hardening, Sealed env custody or the deterministic
Compose ownership of ADR 0020.

## Decision

### Declaration

Add a third Capsule service kind, `container`, keyed by a Capsule-chosen service
name in the existing `services` object:

```json
{
  "services": {
    "embeddings": {
      "kind": "container",
      "image": "ghcr.io/ggml-org/llama.cpp:server-b6500@sha256:<digest>",
      "command": ["--embeddings", "--pooling", "mean",
                  "-hf", "ggml-org/embeddinggemma-300M-GGUF",
                  "--host", "0.0.0.0", "--port", "8080"],
      "port": 8080,
      "health": { "http": "/health", "startPeriodSeconds": 900 },
      "state": { "path": "/models" },
      "env": {
        "LLAMA_CACHE": "/models",
        "LLAMA_ARG_CTX_SIZE": "2048",
        "HF_TOKEN": { "sealed": "HF_TOKEN" },
        "LLAMA_API_KEY": { "generated": "apiKey" }
      },
      "compose": {
        "restart": "unless-stopped",
        "depends_on": { "database": { "condition": "service_healthy" } },
        "mem_limit": "4g",
        "cpus": 2,
        "shm_size": "1g",
        "stop_grace_period": "30s"
      }
    }
  }
}
```

- The name matches `^[a-z][a-z0-9-]{0,30}$`. `database` and `storage` stay
  reserved for the built-in kinds. A Capsule declares at most 8 container
  services.
- `image` requires an explicit tag or digest; `latest` and untagged references
  are rejected. Doctor warns when a digest is absent, and when the image lacks the
  architecture of the target (arm64 locally, amd64 on most Hosts).
- `command` is an array of literal strings. Secrets are never interpolated into
  arguments, because arguments are visible in process listings.
- `port` is the one internal TCP port the Capsule calls. A container service has
  no public route; a Capsule that wants to expose one proxies it through a
  Custom endpoint, which keeps admission policy, CSP and auth in front of it.
- `health` is required: an HTTP path or `{ "tcp": true }`, with a bounded
  `startPeriodSeconds` (model loading and first download can take minutes).
  `health.await` (default `true`) controls whether the Capsule start waits for
  readiness; `false` starts the Capsule immediately, and the Capsule must
  tolerate an unavailable service (for example, by retrying a Job).
- `state` optionally names one container path that Sporades backs with
  persistent Runtime state at `.sporades/services/<name>/`.
- `compose` passes any other Compose service key through to the generated
  service, as described below. Resource limits, restart policy, ordering, GPUs
  and the like live there rather than in bespoke Sporades fields.

Sporades renders the declaration into the same generated Compose file and
network as the built-in services. There is no separate user-supplied Compose
file or override to merge in: `compose` is the only route for raw Compose keys,
and it applies to one service at a time.

### Compose passthrough

Sporades cannot predict every Compose feature a service will need, so the
`compose` object accepts any key of a Compose service definition, written in
Compose's own snake_case form, and copies it into the generated service. Sporades
only checks each key and the path it widens, and treats every key as one of
three classes:

| Class | Keys | Behaviour |
| --- | --- | --- |
| Ordinary | Every key Sporades classifies as non-widening in the pinned Compose specification, for example `restart`, `depends_on`, `mem_limit`, `cpus`, `deploy.resources.limits`, `ulimits`, `shm_size`, `stop_signal`, `stop_grace_period`, `init`, `entrypoint`, `working_dir`, `tmpfs`, `logging`, `platform`, `pull_policy`, `x-*` extensions | Copied verbatim. |
| Sporades-owned | `image`, `command`, `environment`, `env_file`, `healthcheck`, `container_name`, `networks`, `ports`, `expose`, `secrets`, `configs`, `user`, `read_only`, `cap_drop`, `security_opt`, and `com.sporades.*` labels | Rejected with a hint naming the first-class field that controls it (`image`, `command`, `env`, `health`, `port`, `user`, `hardening`). This keeps env custody, readiness, addressing and hardening defaults under Sporades. Other labels merge. |
| Elevated | `privileged`, `cap_add`, `devices`, `device_cgroup_rules`, `gpus`, `deploy.resources.reservations.devices`, `network_mode`, `pid`, `ipc`, `uts`, `userns_mode`, `cgroup`, `cgroup_parent`, `runtime`, `sysctls`, `group_add`, `extra_hosts` (it can reach the host through `host-gateway`), `volumes_from`, `oom_kill_disable`, host-path entries in `volumes` (elevation name `volumes.bind`), and a first-class `user` that resolves to root (elevation name `root`) | Allowed only when the key is also named in the service's `elevated` list, for example `"elevated": ["gpus"]`. |

Rules that apply to every class:

- **Unknown keys are elevated.** Sporades pins the Compose specification version
  it classifies against. A key from a newer specification that Sporades has not
  classified is treated as elevated until it is, so a new Compose capability can
  never widen authority silently.
- **Validation runs twice.** Sporades validates each key against the pinned
  Compose schema, then runs `docker compose config --quiet` on the generated
  file. Both failures report the offending `services.<name>.compose` path.
- **`depends_on` uses declared names.** It may name `database`, `storage` or
  other container services of the same Capsule. Sporades translates these to the
  generated container names and rejects unknown names and cycles. The Capsule
  itself is not a target; its readiness is governed by `health.await`.
- **Named volumes in `volumes` are ordinary.** Sporades labels and namespaces
  them, and `reset` removes them like `state`.
- **Some mounts are always rejected.** The Docker socket, paths inside the
  Runtime directory, and the Sealed env key store are refused even when
  elevated.
- **Values are literals.** Interpolation syntax (`${…}`) in passthrough values is
  rejected. Secrets reach a service only through `env`.
- **Hosted lifecycle keys stay with the Host.** On a Hosted Capsule, the Host
  replaces `restart` with its own crash and boot-recovery policy. Doctor warns
  when a declared `restart` will not apply.

Elevation is acknowledged where the authority is granted:

- **Dev and local Container sessions.** Naming a key in `elevated` is the
  developer's acknowledgement. Doctor reports every elevated key, and starting
  such a service emits a Privileged audit event that lists the elevated keys and
  no values.
- **Hosted Capsules.** A repository change alone cannot escalate on a shared
  Host. `host push` also requires a Host-owned allowance for that Capsule and key,
  which the operator grants and revokes through `sporades host ...`. A release
  whose elevated keys are not allowed is refused before it starts.

The same passthrough is not extended to the built-in `database` and `storage`
services in this decision.

### Env: three value sources, all explicit

Each entry in a service's `env` map is a variable the service sees. Names match
`[A-Za-z_][A-Za-z0-9_]*`, and the reserved `SPORADES_` prefix is rejected. A
service has at most 64 variables and 64 KB of values, matching Server env. Each
value is one of:

| Form | Source | Use |
| --- | --- | --- |
| `"literal"` | `sporades.json` (committed) | Non-secret tuning such as context size or log level. |
| `{ "sealed": "KEY" }` | The Capsule's Sealed Server env key `KEY` | Operator-owned values the Capsule may also read through `ctx.env.KEY`: provider tokens, login details, licence keys. |
| `{ "generated": "secretName" }` | A random 256-bit value Sporades generates and keeps | Secrets that exist only to connect the Capsule to its service, such as a shared API key. |

A service receives only the variables it declares. Sporades never forwards the
whole of Sealed Server env, the Capsule's `ctx.env`, or any `SPORADES_*` value
to a container service. A third-party image therefore cannot reach the Stripe,
mail, or OAuth credentials of its Capsule unless the declaration names them.

`sealed` references are resolved from the same Sealed Server env the Capsule
uses, so one value has one source of truth. Starting a service whose referenced
key is missing or blank fails before the container starts, with a names-only
error. When the `env` stanza of Required Server env is present, doctor and
`host push` include service references in the same presence checks as SMTP,
mail webhook and Stripe references.

`generated` secrets are stable across restarts and redeploys. Locally they join
the existing `0600` `.sporades/services/credentials.json`; on a Host they live in
Host-owned per-Capsule state, never in a release archive. Service reset or
removal discards them. Explicit rotation is later work.

### Delivery of values

The generated Compose file contains literals only. Each secret-bearing entry
renders as a unique, required interpolation variable, for example
`HF_TOKEN: ${SPORADES_SVC_EMBEDDINGS_HF_TOKEN:?}`, and the CLI (or, later, the
Host helper) supplies resolved values solely in the environment of the
`docker compose` child process. Plaintext therefore never lands in generated
files, command arguments, Bundles, logs or JSON output. The values do persist in
the container's Docker configuration; as for Telemetry profile credentials,
anyone with Docker administration on the machine can read them. Doing the same
for the existing built-in database and storage credentials is a separate
follow-up.

File-mounted secrets (`/run/secrets/<name>`) suit images that read
`*_FILE` variables. They are a later additive form,
`{ "sealed": "KEY", "as": "file" }`, and not needed for the first slice.

### Capsule access: `ctx.services`

Trusted server contexts (queries, mutations, Custom endpoints, App messages,
Jobs, context middleware and mutation hooks) gain a read-only
`ctx.services.<name>`:

```ts
const { url, secrets } = ctx.services.embeddings;
const response = await fetch(`${url}/v1/embeddings`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${secrets.apiKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ input: texts }),
});
```

- `url` is the Sporades-resolved origin for the current mode: a loopback
  published port in a Dev session, the Compose DNS name on the services network
  in a local Container session, and the per-Capsule Host network name for a
  Hosted Capsule.
- `secrets` contains exactly the `generated` values of that service. `sealed`
  values are already available through `ctx.env`, so they are not duplicated.
- The object is deeply frozen and absent from ACL contexts, browser code, client
  Bundles, inspection JSON and logs. Unknown names are `undefined`.

Connection details are not added to `ctx.env`. That keeps the reserved
`SPORADES_` prefix runtime-only and keeps operator-owned values separate from
runtime plumbing.

### Isolation and lifecycle

Container services inherit the posture of the Base image, made explicit per
service: non-root user `10001:10001` unless `user` is declared, `cap_drop: ALL`,
`no-new-privileges`, Docker's default seccomp profile, a read-only root
filesystem with a hardened `/tmp` tmpfs (an explicit
`hardening.readOnlyRootFilesystem: false` opts out), no Docker socket, no host
network, no privileged mode, and no host ports except the loopback-only port
published for Dev sessions. Only an acknowledged `elevated` passthrough key can
relax these defaults, and the Docker socket stays unavailable even then. Egress is allowed by default so a service can fetch
models. `network.egress: false` places it on an internal network, available for
Container and Hosted sessions only, because Dev sessions need a published port.

Lifecycle follows ADR 0020. `dev` and `deploy` start the declared services
before the Capsule, wait according to `health`, and own `status`, `stop` and
`reset`. A Dev rebuild of Capsule code does not restart services; a changed
declaration recreates only the affected service. Reset removes service state and
generated secrets but never removes third-party images. Labels identify the
Capsule, the service name and `kind: container`.

Service state is not part of the Capsule data backup (SQLite plus uploaded
files) in this decision. Model caches are reproducible. A
`state.backup: true` opt-in can follow when there is a durable-state use case.

### Rollout

The first slice is local only (Dev and local Container), like ADR 0020's
built-in services. Hosted support is delivered with Hosted Capsule service
orchestration and reuses this declaration unchanged. The Host decrypts `sealed`
references with the Host-generated key of the release (ADR 0023) and keeps
`generated` secrets in Host state. Until then, `host push` refuses a release
that declares container services and gives a hint, rather than starting a
Capsule without the service it depends on.

## Alternatives considered

- **User-supplied Compose file or override.** Merging an arbitrary file gives no
  per-key boundary: it can rename networks, replace env, drop hardening or add
  top-level resources, and the result cannot be classified, explained by doctor
  or carried to a Host deterministically. Rejected, consistent with ADR 0020.
  The per-service `compose` passthrough keeps the same reach (any service key)
  while keeping classification and elevation.
- **Bespoke Sporades fields for every Compose option** (`resources`,
  `restartPolicy`, `dependsOn` and so on). Each new need would wait for a
  Sporades release, and the fields would drift from Compose semantics. Rejected;
  first-class fields are reserved for what Sporades must own.
- **An allowlist of passthrough keys.** This is safer by default, but every
  harmless Compose option would wait for a Sporades release. Rejected in favour
  of the three-class model, where an unclassified key is elevated and so is
  still usable after explicit acknowledgement.
- **Forward all Sealed Server env to services.** This is simpler to author, but
  it hands every Capsule secret to the least trusted process. Rejected in favour
  of per-variable references.
- **Secrets as literals in `sporades.json` or the generated Compose file.** This
  commits or persists plaintext. Rejected.
- **Expose service URLs through `ctx.env`** (for example
  `SPORADES_SERVICE_EMBEDDINGS_URL`). This collides with the reserved prefix,
  is untyped, and mixes runtime plumbing with operator values. Rejected for
  `ctx.services`.
- **Run inference in-process** (for example `node-llama-cpp` or WASM). This
  suits tiny models, but it puts native addons in a self-contained Bundle
  (ADR 0040), enlarges the Base image and gives no memory isolation. Capsules
  may still choose it; it is not a platform feature.
- **A purpose-specific `kind: "embeddings"`.** This is friendlier, but it is
  premature. A curated preset can later compile to a `container` declaration
  without changing this contract.

## Consequences

- `ctx.services` and the `container` service kind are new public contracts.
  Server types, the generated `bin/` and `dist/` runtime, the configuration
  reference, doctor checks and parity tests must ship together.
- An agent can add a companion service by editing `sporades.json` alone. The
  same declaration is portable across Dev, Container and, once Host
  orchestration exists, Hosted sessions.
- The least-privilege env model makes sharing explicit. A Capsule that wants a
  value in both places stores it once in Sealed Server env and references it.
- Users can adopt any Compose service feature without a Sporades release.
  Sporades's maintenance cost moves to keeping the key classification current
  as the Compose specification changes, which is a single, testable table.
- Hosted elevation needs a new Host-owned allowance store and `sporades host`
  commands, and its deny and revocation paths need tests.
- Docker Desktop on Apple Silicon exposes no Metal GPU to containers, so local
  `llama.cpp` runs on the CPU. Small embedding models are practical; large
  generative models are not a goal of the first slice.
- Third-party images remain the operator's supply-chain responsibility. Digest
  pinning and doctor warnings reduce that risk but do not remove it.
- Embeddings produced by such a service are the natural input to the planned
  SQLite vector extension and pgvector work. Neither depends on the other.
