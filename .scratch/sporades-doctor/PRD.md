# sporades doctor

Status: ready

## Source Planning

- `docs/ROADMAP.md` (Ops And Automation: "`sporades doctor`")
- `docs/PRD.md`
- `CONTEXT.md`
- `docs/adr/0016-host-server-registry-authoritative.md`
- `docs/adr/0020-capsule-services-declared-in-sporades-config.md`
- `docs/adr/0022-acl-rules-are-runtime-policy-functions.md`
- `docs/adr/0023-host-generated-sealed-env-keys.md`
- `docs/adr/0025-base-image-carries-dormant-ssh-capability.md`

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to remove the item, per the roadmap Promotion Rule.

## Problem Statement

Sporades has grown a set of strong inspection surfaces: `sporades security`,
`sporades env status`, `sporades deploy status`, `sporades deploy ssh`,
`sporades host health`, `sporades host stats`, `sporades host logs`, and
`sporades host ssh`. These commands expose useful facts, but an operator or AFK
agent still has to know which command to run, how to correlate the output, and
which warnings matter before a Dev session, local Container session, or Hosted
Capsule is safe to use.

`sporades doctor` provides one read-only diagnostic command that gathers the
most important project, local runtime, and Hosted Capsule signals into
structured checks with actionable hints. It is not a replacement for the
underlying lifecycle and inspection commands; it points to them.

## Goals

- Add a top-level `sporades doctor` command for local project and runtime
  diagnostics.
- Support targeted diagnostics for Dev sessions, local Container sessions, and
  Hosted Capsules.
- Emit deterministic JSON for agents and CI.
- Emit concise human output grouped by severity.
- Surface warnings for configuration and runtime hygiene without changing
  existing allow-by-default runtime semantics.
- Reuse existing inspection surfaces and Host helper contracts wherever
  possible.

## Non-Goals

- Do not add automatic repair or mutation behavior in the first doctor release.
- Do not create a dashboard or long-running monitor.
- Do not duplicate SSH, Host health, Host stats, logs, security, or env command
  contracts as separate hidden implementations.
- Do not expose secrets, full Server env values, private keys, or full SSH
  public-key material.
- Do not introduce the Privileged server role or privileged runtime table inspection
  as part of doctor.
- Do not add Hosted Capsule service orchestration.

## Command Shape

```sh
sporades doctor [options]
```

Options:

- `--session <name>`: Target `dev`, `container`, or `hosted`. Without a session,
  doctor runs project-level checks plus best-effort local runtime checks.
- `--host <alias>`: Host profile alias for Hosted Capsule checks.
- `--subname <name>`: Hosted Capsule subname for Hosted Capsule checks.
- `--strict`: Exit non-zero when any warning or error is present.
- `--json`: Write structured JSON output.

`sporades doctor` is read-only. It may inspect files, parse Capsule definition
metadata, query local Docker, call existing Host helper inspection actions, and
read Runtime directory state. It must not start, stop, push, reset, repair,
rotate, import, export, or delete anything.

## Diagnostic Model

Each check has:

- `id`: stable machine-readable check identifier.
- `title`: short user-facing check title.
- `scope`: `project`, `dev`, `container`, or `hosted`.
- `status`: `pass`, `warn`, `fail`, or `skip`.
- `severity`: `info`, `warning`, or `error`.
- `message`: concise diagnosis.
- `hint`: next action in command-oriented language where available.
- `commands`: optional follow-up commands.
- `details`: optional non-secret structured metadata.

Normal runs exit `0` when checks pass or warn, and non-zero when any check
fails. `--strict` exits non-zero for warnings as well as failures. Skipped
checks do not fail the command.

## Checks

### Project and configuration checks

- Validate `sporades.json` structure and supported keys.
- Resolve effective Capsule security policy for the requested session.
- Warn on Public Dev posture when requested or when a running Dev session is
  public.
- Validate `ssh.authorizedKeys` shape and key material without printing full
  public keys.
- Report empty SSH configuration as a warning, because empty effective key sets
  disable SSH.
- Detect legacy plaintext `.env.sporades.server` when Sealed Server env exists
  and point users to explicit env import or cleanup choices.

### Capsule authoring posture checks

- Inspect bundled or loadable Capsule schema metadata enough to identify tables
  without declared ACL rules.
- Warn when file metadata or app tables appear open by default, while clearly
  stating that missing ACLs are not deny-by-default today.
- Do not evaluate arbitrary policy logic beyond loading the Capsule definition
  through the existing bundle/runtime-safe path.
- Do not inspect runtime-owned auth, system metadata, logs, or raw storage
  tables through normal ACL helpers.

### Local runtime checks

- Inspect Dev session binding state, port reachability, and Public Dev posture.
- Inspect local Container binding state, Docker container state, Base image
  policy labels, runtime user, read-only release mounts, writable data mount,
  restart policy, and loopback-only published ports where available.
- Inspect Capsule service declarations, generated Compose file state, service
  containers, health, ports, networks, and known drift between `sporades.json`
  and Runtime directory state.
- Point users to existing lifecycle commands such as `sporades dev status`,
  `sporades deploy status`, `sporades deploy restart`, and `sporades deploy
  reset`.

### Sealed Server env checks

- Report local Sealed Server env envelope availability, public/private key
  availability, and non-secret envelope summary.
- Report Host-generated Sealed Server env public-key fingerprint availability
  for Hosted Capsule checks.
- Warn when local sealed material cannot be promoted to a Host because source
  values or matching private keys are unavailable.
- Warn when Hosted Capsule release metadata references a sealed-env key
  fingerprint that is unavailable on the Host, without exposing key material.

### Hosted Capsule checks

- Validate Host profile availability and remote binding fallback.
- Query existing Host health and Hosted Capsule health surfaces.
- Compare intended Hosted Capsule state with Host registry and release state.
- Report route/container mismatches, stopped Capsules, missing releases, failed
  health checks, and unavailable response conditions.
- Inspect effective Hosted Capsule SSH state through the same model as
  `sporades host ssh`; do not publish new public SSH exposure semantics.
- Point users to existing Host commands such as `sporades host health`,
  `sporades host stats`, `sporades host logs`, `sporades host ssh`, and
  `sporades host push --verify`.

## User Stories

1. As an AFK agent, I can run one read-only command and receive structured
   checks with exact follow-up commands.
2. As a developer, I can catch unsafe Public Dev posture, permissive security
   policy, or malformed SSH config before sharing a Capsule.
3. As a Capsule author, I can see missing ACL warnings without Sporades changing
   allow-by-default runtime behavior.
4. As an operator, I can diagnose why a local Container session differs from the
   current config or expected hardening model.
5. As an operator, I can diagnose Capsule service drift without hand-inspecting
   generated Docker Compose files.
6. As a developer/operator, I can understand whether Sealed Server env material
   is promotable locally and on a Host server without printing secrets.
7. As a Host operator, I can diagnose Hosted Capsule health/config mismatches
   from a structured CLI surface.
8. As a CI author, I can use `sporades doctor --strict --json` to fail on
   warnings before release.

## Implementation Issues

- `issues/01-define-doctor-command-and-check-envelope.md`
- `issues/02-add-project-config-and-security-posture-checks.md`
- `issues/03-add-capsule-authoring-posture-checks.md`
- `issues/04-add-local-runtime-and-service-checks.md`
- `issues/05-add-hosted-capsule-doctor-checks.md`
- `issues/06-document-doctor-and-update-roadmap.md`
