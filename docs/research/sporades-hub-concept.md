# Sporades Hub concept

Status: design concept, not an implemented or committed product surface

Last updated: 2026-08-08

## Summary

Sporades Hub is a universal desktop interface for operating Sporades. It reduces
human friction around the existing agent-first CLI and Host-helper workflows
without replacing them or creating a second hosting control plane.

The desktop and CLI are sibling adapters over one shared operations module. The
CLI remains the deterministic, scriptable interface for agents and automation;
Hub provides a visual alternative for people who prefer templates, status
views, browser-launch actions, and tiled terminals.

The first promise is deliberately concrete:

> Choose a Sporades template, choose a Host, create a real Hosted Capsule,
> watch its progress, and see **Ready** only when its routed URL passes health
> verification.

Hub borrows the attractive convenience of products such as Replit and Abacus.AI
SuperComputer — one-click templates, visual project management with obvious
status and launch actions, integrated logs and environment panels, and an
integrated terminal workspace — without becoming a rented cloud computer,
remote IDE, model marketplace, or multi-tenant SaaS.

## Product position

Sporades is agentic-first and CLI-first. Hub does not change that position. It
makes the same capabilities easier to discover and operate manually.

Hub is:

- a cross-platform desktop cockpit for Sporades;
- a graphical alternative to the CLI, not a replacement for it;
- a template-to-Hosted-Capsule workflow;
- a view over authoritative Host and Capsule state;
- a Host management surface for adding, editing, listing, and health-checking
  remote Host profiles;
- a rich capsule management surface with visual lifecycle, logs, environment,
  monitoring, database, users, configuration, files, domain linking, and
  SSH inspection;
- a workspace for multiple local or SSH-backed terminal sessions; and
- a replaceable adapter over shared Sporades operations.

Hub is not:

- a remote development machine or VPS product;
- a browser-hosted shell exposed from the production Host;
- a code editor or IDE;
- a bespoke Codex, Claude, Hermes, or OpenClaw client;
- a model router, credential broker, or subscription reseller;
- a new Host registry or deployment database;
- a generic Docker management dashboard;
- a multi-tenant hosting control plane; or
- a source of GUI-only lifecycle semantics.

The fastest way to ruin this concept would be to make the desktop look
convenient while requiring agents and CLI users to follow a different
operational model. Hub should remove human friction, not manufacture
architectural friction with nicer icons.

## Domain model and authority

### Hub

The user-facing desktop product. Hub renders templates, Hosts, Capsules,
capsule management surfaces, operation progress, recovery actions, and terminal
layouts. It owns presentation preferences, not hosting truth.

### Operations module

A deep, UI-independent module that exposes Sporades orchestration through a
small typed interface. It owns validation, lifecycle ordering, Host-helper
invocation, idempotency, cancellation, structured progress, recovery,
redaction, and verification.

The operations module does not know about Electron windows, renderer state, CLI
flags, ANSI formatting, or dashboard widgets.

### Desktop adapter

The Hub-specific adapter. It translates clicks and form input into operation
requests, subscribes to structured events, and renders results. It must not
parse human-formatted CLI output or reimplement Host logic.

### CLI adapter

The existing command-line interface, incrementally migrated to use the same
operations module. It translates arguments and standard input into operation
requests and renders results for humans or automation.

### Host server registry

The authoritative source of Hosted Capsule registration, release pointers,
route state, and lifecycle metadata. Hub may cache data for presentation, but
it must reconcile consequential reads and every mutation with the Host-owned
state.

Project bindings remain convenience pointers. Closing Hub, reinstalling it, or
switching computers must not alter the existence or lifecycle state of a
Hosted Capsule. This follows [ADR 0016](../adr/0016-host-server-registry-authoritative.md).

## Product principles

1. **One operation model.** Desktop and CLI invoke the same typed operations
   and observe the same results.
2. **Host truth survives every client.** Long-lived state belongs to the Host
   registry, not the desktop.
3. **Ready is externally meaningful.** A deployment is Ready only when its
   routed public URL passes health verification.
4. **Capsule state is rich and visual.** Hub presents registration, process
   state, route state, health, logs, environment, monitoring, database, users,
   configuration, files, domain linking, and SSH as integrated per-Capsule
   visual surfaces — not a flat list with a start/stop button.
5. **The GUI exposes valid doors.** Hub presents supported Sporades workflows
   rather than every possible infrastructure control.
6. **Escape hatches remain available.** Tiled terminals, SSH, Git, and the CLI
   remain accessible when a visual workflow is insufficient.
7. **Agents remain first-class users.** Structured operations, deterministic
   results, actionable errors, and resumable observation are requirements, not
   CLI leftovers.
8. **The shell is replaceable.** Product logic must not depend on Electron,
   allowing another desktop shell or a loopback web adapter later.
9. **Credentials remain user-controlled.** Hub does not pool, resell, or
   silently reuse model-provider or Cloud subscription credentials.

## Initial desktop surfaces

### Templates

Templates provide the primary quick-win entry point. The surface should expose
the real Sporades template, framework, and toolchain capability matrix rather
than a separate Hub catalogue that can drift from the CLI.

A user can:

- browse and filter supported templates;
- inspect what a template creates and requires;
- choose its framework and toolchain where supported;
- select a destination directory;
- name the project and Hosted Capsule;
- choose a configured Host profile;
- supply required non-secret inputs and guided secret references;
- instantiate the project using the same scaffold path as `sporades create`;
- deploy it as a real Hosted Capsule; and
- open the verified public URL.

Template cards are workflow entry points, not screenshots with optimistic
buttons.

### Hosts

The Hosts surface is the per-Host management surface in Hub. It represents
configured Sporades Host profiles and their observed health, and it is the
visual equivalent of the relevant `sporades host add|use|current|bootstrap`
operations — expanded with editing and listing that the first tracer should
introduce through the operations module.

#### Host overview

The surface should present all configured Host profiles as visual cards or a
list, each showing at a glance:

- profile name;
- SSH target (host and port);
- Hosted domain;
- scheme (http or https);
- TLS mode (automatic, edge, or cloudflare-origin);
- remote root path;
- health badge: `healthy`, `degraded`, `unreachable`, or `unknown`;
- Capsule count registered on this Host; and
- last health-check timestamp.

#### Host detail

Selecting a Host opens a detail view with per-Host management surfaces:

**Profile tab**

- add a new Host profile: enter name, SSH target, Hosted domain, scheme, remote
  root, and TLS mode — the visual equivalent of `sporades host add`;
- edit an existing Host profile's configuration: change SSH target, Hosted
  domain, scheme, remote root, or TLS mode through a schema-validated form;
- delete or remove a Host profile from local configuration, with confirmation
  and clear indication that this does not unregister or destroy any Hosted
  Capsules on the remote Host;
- set the active Host profile — the visual equivalent of `sporades host use`;
- inspect the current Host profile — the visual equivalent of `sporades host
  current`;
- validation of SSH target format, domain format, and TLS mode compatibility
  before saving; and
- no SSH credentials stored or rendered in the UI — Hub uses the system SSH
  agent or configured key paths, never exposes private keys.

**Health tab**

- run Host health checks on demand — the visual equivalent of `sporades host
  bootstrap` for initial setup and ongoing verification;
- bootstrap or repair a Host through an explicit guided operation with
  structured progress;
- health-check history: results over time, not just the latest result;
- connection and configuration failures shown with actionable recovery
  guidance;
- Docker availability and version on the remote Host;
- Caddy availability and configuration state;
- Host registry state and integrity;
- Base image availability and version on the Host; and
- refresh from the real Host rather than trusting stale desktop state.

**Capsules tab**

- list all Hosted Capsules registered on this Host — the visual equivalent of
  `sporades host list`;
- per-Capsule summary: name, lifecycle state, route state, health, current
  release, and last-updated timestamp;
- click-through to the full Capsule detail view; and
- aggregate Host-level stats: total Capsules, running count, stopped count,
  failed count.

The Hosts surface and the Capsules surface are two views over the same
authoritative Host registry. The Hosts Capsules tab is a Host-scoped filter;
the Capsules surface is the cross-Host management view. Both read through the
operations module and reconcile with Host-owned state.

Provider provisioning — creating a new cloud server and installing the
Sporades hosting stack — may be linked or guided later, but it is not required
for the first Hub tracer.

### Capsules

The Capsules surface is the primary management surface in Hub. It is a view
over the authoritative Host registry, enriched with visual lifecycle, logs,
environment, database, and stats — closer to how Replit presents deployed
projects than a bare CLI-to-table mapping.

#### Capsule overview

The surface should present registered Hosted Capsules as visual cards or a
list, each showing at a glance:

- Capsule name and Hosted domain URL;
- lifecycle state badge: `registered`, `building`, `pushing`, `starting`,
  `verifying`, `ready`, `stopped`, `failed`, or `unavailable`;
- route state: whether the public URL routes to a running container or the
  Hosted Capsule unavailable response;
- health state: the result of the last routed URL health verification;
- current release identity and when it was pushed;
- quick actions: open URL, start, stop, restart, push, and logs; and
- last-updated timestamp from the Host registry, not from desktop cache.

Hub must distinguish registration, process state, route state, and application
health. A running container is not necessarily a healthy application, and a
registered Capsule with no running release may correctly return the Host-owned
unavailable response. The visual design should make these four states
independently visible, not collapse them into a single green/red dot.

#### Capsule detail

Selecting a Capsule opens a detail view with tabbed or pane-based management
surfaces. Every surface is per-Capsule: it reflects one Hosted Capsule's state
on one Host, retrieved through the operations module, not from desktop cache.

**Lifecycle tab**

- current lifecycle state with a visual timeline of the last deployment flow;
- start, stop, restart, push, and verification actions as explicit buttons;
- structured progress for in-flight operations with stage-level failure
  context;
- retry, resume, or recover actions when an operation failed;
- explicit destructive actions (unregister, delete storage) with clear scope
  and confirmation;
- release history: current and recent releases with identity, push time, and
  active indicator;
- rollback consideration: a future capability to re-activate a prior release,
  not a new database;
- domain linking: view and manage the Capsule's route — its subname on the
  Hosted domain, the full public URL, route state (pointing to the running
  container or the unavailable response), and TLS mode (automatic, edge, or
  cloudflare-origin);
- rename the Capsule subname where the Host registry supports it, with
  conflict validation before mutation; and
- open the routed URL in the user's browser through an allow-listed HTTPS
  action.

**Logs tab**

- real-time log streaming from the Hosted Capsule — the visual equivalent of
  `sporades host logs <name> --json` and `sporades host logs <name> --tail`;
- level filtering (info, warn, error, audit);
- text search across recent logs;
- structured JSONL event rendering, not raw text scraping;
- bounded scrollback with explicit "load more" or time-range selection; and
- platform audit events visible alongside app logs when the operator has
  appropriate access.

The logs tab streams through the operations module's `subscribe` interface. It
must not open a second SSH connection or parse CLI text output.

**Environment tab**

- visual management of Sealed Server env keys for the Capsule — the visual
  equivalent of `sporades env set`, `sporades env has`, and `sporades env
  import`;
- key listing with presence indicators (value is set, never the value itself);
- add, update, and remove individual keys through the operations module;
- import from a legacy `.env.sporades.server` file through guided action;
- clear distinction between sealed and legacy env state; and
- no secret values ever rendered in the UI — only key names and presence.

The environment tab mutates state through the same sealed-env mechanisms the
CLI uses. Hub must not store env values in desktop state, renderer memory, or
local cache.

**Monitoring tab**

- bounded resource stats for the running Capsule — the visual equivalent of
  `sporades host stats`;
- CPU, memory, and network summaries where the Host helper exposes them;
- uptime and restart count;
- health-check history: results of routed URL health verifications over time,
  not just the latest result;
- process state and route state shown alongside health so the operator can
  distinguish a stopped Capsule from a running-but-unhealthy one;
- Base image version and update policy indicator; and
- refresh-on-demand by default, with optional live polling when the tab is
  focused.

**Database tab**

- visual database browser for the Capsule's SQLite data — the visual
  equivalent of `sporades host db list|dump|query` for Hosted Capsules;
- table listing with row counts;
- paginated row browsing with column-aware rendering;
- bounded read-only query execution with result rendering; and
- no write capability through the database tab — mutations go through the
  Capsule's own API.

The database tab reads through the operations module's `observe` interface. It
is an inspection convenience, not a second database client.

**Users tab**

- list of Sporades auth users registered in the Capsule — the visual
  equivalent of `sporades auth status` and `sporades auth clients` extended to
  Hosted Capsules;
- per-user summary: linked providers (email, Google, Apple, Microsoft,
  Facebook), provider subjects, display name, and account creation time;
- session listing: active sessions with provenance, creation time, and expiry;
- connected-client count per session where the transport exposes it;
- read-only by default: the Users tab is an inspection surface, not a user
  management console;
- future capabilities may include session revocation or user disablement
  through the operations module, but these are not required for the first
  tracer; and
- no secret exposure: session tokens, provider secrets, and OAuth credentials
  are never rendered.

**Configuration tab**

- visual view of the effective `sporades.json` for the Capsule — the
  configuration that was baked into the current release;
- structured rendering of app name, client framework, auth providers, security
  policy, scheduling policy, deploy port, services (database and storage
  declarations), and SSH authorized-keys configuration;
- editing of the local project's `sporades.json` through a schema-validated
  form — Hub validates the edit against the known `sporades.json` shape before
  saving, and the change takes effect on the next release push;
- clear indication that editing `sporades.json` changes the local project
  file, not the running Capsule — a redeploy is required for the change to
  take effect on the Host;
- side-by-side view of the deployed configuration versus the local
  configuration when they differ, so the operator can see what will change on
  the next push; and
- no raw JSON free-text editing in the renderer — the form is structured and
  validated, though a "view raw JSON" read-only display is available.

The configuration tab reads the deployed configuration through the operations
module and writes the local file through the project-scoped file-system
bridge. It must not mutate Host registry state directly.

**Files tab**

- visual browser of stored cloud files for the Capsule — file metadata, File
  IDs, absolute File paths, File versions, MIME types, sizes, and original
  names;
- File bucket listing and navigation;
- public URL management: list active public file URLs with TTL or no-expiry
  status, create new public URLs, and revoke existing ones;
- file replacement history: version chain for a given File ID;
- storage stats: total bytes, file count, and bucket breakdown where the Host
  helper exposes them;
- read-only inspection by default: the Files tab does not upload, delete, or
  replace file bytes — those operations go through the Capsule's own API or
  CLI;
- future capabilities may include file deletion or bucket management through
  the operations module, but these are not required for the first tracer; and
- no file byte content rendered in the UI — metadata and URLs only, never raw
  file contents or storage credentials.

The Files tab reads through the operations module's `observe` interface. File
byte storage is owned by the Capsule's execution environment; Hub inspects
metadata, not bytes.

**SSH tab**

- effective SSH inspection state — the visual equivalent of `sporades host ssh`;
- user, host, port, key count, and fingerprints;
- explicit "open SSH terminal" action that launches a tiled terminal session;
- visible opt-in state: SSH is only available when `ssh.authorizedKeys` is
  configured; and
- no credential exposure — fingerprints only, never private keys.


#### Capsule actions and safety

All capsule actions go through the operations module with the same idempotency
and duplicate-safety guarantees as the CLI. Repeating an operation with the
same idempotency key must not create a second Capsule or push a second release
because a user double-clicked or the desktop reconnected.

Destructive actions — unregister, delete storage — must present:

- the exact scope of what will be destroyed;
- which data is permanent and which is recoverable;
- a typed confirmation input (e.g., type the Capsule name); and
- no bypass through keyboard shortcuts or auto-dismiss.

### Tiled Terminals

Terminals are the universal escape hatch and the main bridge between visual and
agentic operation.

The desktop should support:

- multiple terminal tiles and tabs;
- horizontal and vertical splits;
- focus, rename, resize, and close;
- local shells and SSH-backed sessions;
- copy, paste, search, and scrollback;
- visible working-directory and connection context; and
- reconnect where the underlying session supports it.

Users may run Sporades, Git, Codex, Claude, SSH, or ordinary shell tools in
these terminals. Hub does not need a bespoke AI chat surface. Codex
authentication remains between the user and Codex, whether the user chooses a
supported ChatGPT subscription login or their own API key.

Terminal tiling is a desktop capability, not permission for an Electron
renderer to receive an arbitrary shell bridge.

## Template-to-Ready workflow

The first canonical workflow is one operation from a selected template to a
verified Hosted Capsule.

1. Validate the template, framework, toolchain, project name, destination,
   Host profile, and Capsule subname.
2. Resolve conflicts before creating remote state.
3. Materialise the same project scaffold used by the CLI.
4. Register the Capsule in the authoritative Host registry.
5. Build the normalized release.
6. Prepare and seal required Server env through existing Sporades mechanisms.
7. Push and install the release.
8. Start or restart the Hosted Capsule.
9. Observe Host progress and expose structured failures.
10. Verify the routed public URL.
11. Report **Ready** and enable **Open** only after verification succeeds.

The user-visible lifecycle should distinguish at least:

```text
validating -> creating -> registered -> building -> pushing
           -> starting -> verifying -> ready
                                     -> failed
```

Failures retain enough structured context to retry, resume, or recover safely.
Repeating an operation with the same idempotency key must not create a second
Capsule because a user double-clicked or the desktop reconnected.

## Architecture

```text
┌──────────────────┐       ┌──────────────────┐
│   CLI adapter    │       │ Desktop adapter  │
│ args / JSONL UI  │       │ Electron UI/PTY  │
└────────┬─────────┘       └────────┬─────────┘
         │                          │
         └────────────┬─────────────┘
                      ▼
          ┌────────────────────────┐
          │   operations module    │
          │ validate / submit      │
          │ observe / subscribe    │
          │ recover / verify       │
          └────────────┬───────────┘
                       │ structured SSH operations
                       ▼
          ┌────────────────────────┐
          │      Host helper       │
          └────────────┬───────────┘
                       ▼
          ┌────────────────────────┐
          │ authoritative Host     │
          │ registry and runtime   │
          └────────────────────────┘
```

The conceptual operations interface is intentionally small:

```typescript
interface SporadesOperations {
  submit(intent: OperationIntent, idempotencyKey: string): Promise<OperationReceipt>;
  observe(query: OperationQuery): Promise<OperationSnapshot>;
  subscribe(cursor?: EventCursor): AsyncIterable<OperationEvent>;
  cancel(operationId: string): Promise<CancelResult>;
}
```

`OperationIntent` carries domain intent such as template instantiation,
Host profile management (add, edit, remove, list), Host health and bootstrap,
Capsule lifecycle, release push, log inspection, env management, database
inspection, user and session inspection, configuration inspection, file
metadata inspection, public file URL management, routed verification, stats
retrieval, or domain route management. The caller does not orchestrate
low-level SSH steps. That complexity belongs behind the seam, where one
correction benefits the desktop, CLI, tests, and future adapters.

The desktop may initially call the operations module in the Electron main
process. A future local daemon or loopback web adapter is acceptable only if it
preserves this interface and authority model; it is not required for the
Preview.

## Desktop technology and security

Electron is the pragmatic initial shell because Sporades is already
Node.js/TypeScript-based and Hub needs PTYs, OpenSSH integration, filesystem
access, and cross-platform window management. Electron is an implementation
choice, not part of the operations interface.

The renderer must:

- run sandboxed with context isolation enabled;
- have Node integration disabled;
- load packaged local content rather than arbitrary remote pages;
- receive a small, allow-listed preload interface;
- send typed, schema-validated IPC requests;
- have IPC senders and permissions validated in the main process; and
- open Capsule URLs through an allow-listed HTTPS action in the user's browser.

The PTY interface should be narrow: create, write, resize, signal, observe, and
dispose. The renderer must not receive generic command execution, filesystem
access, SSH credentials, Host-helper primitives, Docker socket access, or
Capsule secrets.

Hub and the production Host remain separate by default. Hub does not elevate
Codex or another terminal-run agent, or grant it implicit Docker socket, Host
registry, SSH credential, Capsule secret, or unrelated repository access.

## Repository shape

The repository is currently a single npm package named `sporades`; the root
[`package.json`](../../package.json) does not declare workspaces. Hub should
therefore introduce separation incrementally rather than pretend a workspace
monorepo already exists.

The proposed first additions are:

```text
packages/operations   shared deep operations module
apps/desktop          Electron main process, preload, renderer, and desktop assets
```

The existing root CLI and package remain intact while command families migrate
behind the shared seam. The first extraction should include only what the
template-to-Ready tracer needs. Splitting every runtime and utility package at
once would be excellent ceremony and poor evidence.

## Hermes, OpenClaw, and third-party agents

Hermes and OpenClaw do not shape Hub's core architecture. Sporades developers
can run such tools through terminals or install them independently.

If Hub later offers one-click recipes for third-party agents, each recipe
should run as an untrusted OCI workload with explicit policy for:

- image provenance and version pinning;
- allowed mounts;
- network access;
- secret injection;
- CPU and memory limits;
- restart and update policy; and
- deletion and persistent-data behavior.

Such workloads must not receive the Docker socket, Host registry internals,
broad SSH credentials, Codex credentials, Capsule secrets, or unrelated source
trees. This is an optional recipe system, not a reason to make Hub a privileged
agent appliance.

## Preview implementation slice

The first implementation should prove one vertical tracer rather than build
every panel shallowly:

1. create `packages/operations` and `apps/desktop` as the only new workspace
   units;
2. extract the minimum create, Host profile management (add, edit, remove,
   list), Host health and bootstrap, registration, push, progress,
   verification, logs, env, database inspection, user/session inspection,
   configuration inspection, file metadata inspection, stats, domain route
   management, and open behavior into the operations module;
3. migrate the corresponding CLI path to that module without changing its
   public contract;
4. build the sandboxed Electron shell with Templates, Hosts (with profile,
   health, and capsules tabs), Capsules (with lifecycle, logs, environment,
   monitoring, database, users, configuration, files, and SSH tabs), and Tiled
   Terminals;
5. instantiate one supported template on a configured real Host;
6. show structured lifecycle progress and actionable failure recovery;
7. manage the resulting Capsule through the visual surfaces: view logs, inspect
   environment, browse database, check monitoring, list users, view
   configuration, inspect stored files, and manage domain linking;
8. withhold Ready until the routed URL passes health; and
9. prove the CLI and desktop observe and mutate the same authoritative Host
   state.

### Acceptance criteria

- The same operation contract drives CLI and desktop behavior.
- A supported template becomes a real Hosted Capsule on a configured Host.
- The public routed URL is checked before Ready is reported.
- Capsule detail shows lifecycle, logs, environment, monitoring, database,
  users, configuration, files, and SSH as integrated visual surfaces driven
  by the operations module.
- Log streaming in the desktop reflects the same events as `sporades host logs
  --json`.
- Environment management in the desktop uses the same sealed-env mechanisms as
  the CLI and never renders secret values.
- Database browsing in the desktop is read-only and reflects the same data as
  `sporades host db` commands.
- The Users tab lists auth users and sessions without exposing tokens, provider
  secrets, or OAuth credentials.
- The Configuration tab shows the deployed `sporades.json` and allows
  schema-validated editing of the local file with clear redeploy indication.
- The Files tab lists file metadata and public URLs without rendering file
  bytes or storage credentials.
- Domain linking shows the Capsule subname, full URL, route state, and TLS mode,
  with rename validation through the Host registry.
- The Monitoring tab shows health-check history alongside process and route
  state, not just a single status dot.
- Restarting Hub does not lose or redefine Capsule truth.
- Retrying an interrupted workflow is duplicate-safe.
- Terminal IPC cannot invoke operations outside its narrow contract.
- Renderer IPC is typed, validated, allow-listed, and covered by automated
  tests.
- Failure output identifies the failed stage and presents a safe recovery
  action.
- No model-provider credential is pooled or exposed to renderer or Capsule
  code.
- Host profile management (add, edit, remove, list) uses the same operations
  module as the CLI and never stores SSH credentials in desktop state.
- One real Host acceptance test complements module and IPC tests.

## Deferred decisions

The concept intentionally leaves these choices for implementation planning:

- initial supported desktop operating systems and release order;
- Electron packaging, signing, notarisation, and auto-update mechanism;
- PTY implementation and terminal persistence strategy;
- the exact template metadata and input schema;
- local cache technology and retention;
- whether a later loopback browser adapter warrants a local daemon;
- provider-specific Host provisioning integrations;
- whether the database tab should support write operations in the future;
- whether the Users tab should support session revocation or user disablement;
- whether the Files tab should support file deletion or bucket management; and
- whether constrained third-party OCI recipes are useful enough to build.

None of these decisions changes the central contract: Hub is a disposable
human-friendly adapter, the CLI remains complete, shared operations own
orchestration, and the Host registry owns Hosted Capsule truth.

## Related documentation

- [Repository context](../../CONTEXT.md)
- [Product requirements](../PRD.md)
- [Host server registry ADR](../adr/0016-host-server-registry-authoritative.md)
- [Sporades feature reference](../guide/reference.md)
- [Host provisioning contract](../agents/host-provisioning.md)
