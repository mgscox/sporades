# Sporades Host Server MVP

Status: ready-for-agent

## Problem Statement

Sporades currently supports local dev sessions and local container sessions, but there is no remote host that can receive, run, and manage Capsules. The immediate need is an MVP server that can host Capsules on subdomains, starting with `mattgscox.co.uk` resolving to `168.119.161.21`, while avoiding a design that hard-codes that domain or server into the product.

The user needs a Host server that can be controlled entirely through the CLI: register a Capsule subname, push a Capsule Bundle, start/stop/restart the Hosted Capsule through Docker, list Hosted Capsules, and inspect Docker stats. A dashboard may come later, but it is deliberately not part of the MVP.

## Solution

Build a single-node Sporades Host server controlled over SSH. The local Sporades CLI will use configured Host profiles to resolve a Host server, Hosted domain, scheme, and remote root. The Host server will store the authoritative domain-aware registry, Capsule release directories, persistent data directories, Docker container metadata, and generated reverse-proxy configuration. A single Host server installation should be able to manage multiple Hosted domains from day one.

The first configured Host profile can point at `root@168.119.161.21` with Hosted domain `mattgscox.co.uk`, but the implementation must support any future domain/server pair from the outset. A Host profile such as `personal` should be a local convenience, not a platform assumption.

The Host server should run Hosted Capsules as Docker containers using the existing Sporades Bundle shape: server bundle, client bundle, `index.html`, `sporades.json`, optional Server env, and persistent `/app/data`. Caddy should use per-Capsule generated routes for each `subname.domain`, aided by Docker labels for container discovery and automation. Hosted domains are assumed to sit behind Cloudflare wildcard SSL, with Caddy presenting a Cloudflare origin certificate on the Host server rather than obtaining public certificates per Capsule. The MVP can use root SSH because the target server is already prepared that way, but the implementation should keep that as configuration, not a security model embedded forever like bad eyeliner.

Registration creates a Hosted Capsule record: a Capsule subname reservation plus server-side state on a Hosted domain. It does not require a release to exist, and it does not permanently bind the Hosted Capsule to one local checkout. A push installs a release into an already registered Hosted Capsule.

A registered Hosted Capsule that is not currently running should resolve to a Host-server-owned `503 Service Unavailable` response rather than a generic reverse-proxy error. This applies to registered Capsules with no release, pushed-but-stopped Capsules, and failed-start states. Unregistered subnames remain outside the Hosted Capsule registry and may return the reverse proxy's normal not-found behavior.

## User Stories

1. As a Sporades developer, I want to configure a named host alias, so that I do not need to pass the server and domain to every command.
2. As a Sporades developer, I want host configuration to support arbitrary domains, so that `mattgscox.co.uk` is only the first hosted domain rather than a hard-coded platform constant.
3. As a Sporades developer, I want host configuration to support arbitrary SSH targets, so that the hosting server can move without changing command semantics.
4. As a Sporades developer, I want to choose a current host alias, so that repeated host commands target the intended server/domain pair.
5. As a Sporades developer, I want to override the host alias per command, so that I can work with multiple remote hosts from one machine.
6. As a Sporades developer, I want to bootstrap a remote host, so that Docker, reverse proxying, directories, and the remote host helper are installed consistently.
7. As a Sporades developer, I want bootstrap to be idempotent, so that rerunning it repairs or confirms setup without destroying Capsules.
8. As a Sporades developer, I want to register a Capsule subname on a configured domain, so that I receive a stable hosted URL.
9. As a Sporades developer, I want subnames to be validated before remote execution, so that invalid names cannot create broken DNS, proxy, directory, or container state.
10. As a Sporades developer, I want subnames to be unique within a domain, so that two Capsules on the same hosted domain cannot collide.
11. As a Sporades developer, I want the same subname to be allowed on different domains, so that domain boundaries are clean and future multi-domain hosting works.
12. As a Sporades developer, I want registration to create persistent server-side metadata, so that the host remembers Capsules independently of my local working copy.
13. As a Sporades developer, I want registration to return JSON output, so that agents and scripts can capture the URL and subname deterministically.
14. As a Sporades developer, I want local remote binding metadata, so that `push` can infer the registered Capsule for the current project.
15. As a Sporades developer, I want pushing a Capsule to reuse the existing Bundle pipeline, so that remote Capsules run the same bundled code as dev and container sessions.
16. As a Sporades developer, I want pushing a Capsule to transfer only runtime inputs, so that the server does not need project source files or npm install.
17. As a Sporades developer, I want the remote host to preserve previous releases, so that the current release can be represented as a stable pointer.
18. As a Sporades developer, I want pushing to update the current release atomically, so that a partial upload does not become the active Capsule.
19. As a Sporades developer, I want Server env to be included when present, so that hosted Capsules can use the same server-only variables as local container sessions.
20. As a Sporades developer, I want Server env to remain server-side and not be printed by normal commands, so that secrets are not exposed in CLI output.
21. As a Sporades developer, I want Capsule data to live outside release directories, so that pushes and restarts do not delete SQLite data or uploaded files.
22. As a Sporades developer, I want to start a registered Capsule, so that it begins serving at its hosted subdomain.
23. As a Sporades developer, I want start to fail clearly when no release has been pushed, so that I know to push before starting.
24. As a Sporades developer, I want start to run the Capsule in Docker using the existing base image, so that hosted behavior matches local container session behavior.
25. As a Sporades developer, I want start to mount runtime files read-only, so that running code cannot mutate the active release.
26. As a Sporades developer, I want start to mount the data directory read-write, so that SQLite and platform-managed files persist across container restarts.
27. As a Sporades developer, I want start to attach labels to containers, so that host management commands can find Sporades Capsules reliably.
28. As a Sporades developer, I want stop to stop a Capsule container without deleting its data, so that maintenance is reversible.
29. As a Sporades developer, I want restart to replace the running container from the current release, so that configuration and bundle updates take effect.
30. As a Sporades developer, I want restart to be safe when a container is already stopped, so that scripts can converge state without fragile prechecks.
31. As a Sporades developer, I want list to show all Capsules for a host/domain, so that I can see what is registered and what is running.
32. As a Sporades developer, I want list to include hosted URLs, so that I can quickly open or share a Capsule.
33. As a Sporades developer, I want list to include Docker status, so that I can distinguish registered, stopped, and running Capsules.
34. As a Sporades developer, I want stats to return Docker stats for one Capsule, so that I can inspect CPU, memory, network, and block IO usage.
35. As a Sporades developer, I want stats to support JSON output, so that agents can monitor hosted Capsules without scraping tables.
36. As a Sporades developer, I want every host command to return Sporades JSON output under `--json`, so that automation receives `{ ok, data, error }`.
37. As a Sporades developer, I want host command errors to include actionable hints, so that server, DNS, Docker, and registry issues are easy to resolve.
38. As a Sporades developer, I want SSH failures to be reported distinctly from remote command failures, so that I know whether to fix connectivity or host state.
39. As a Sporades developer, I want DNS assumptions documented, so that wildcard DNS can be configured once and new subnames work without additional DNS changes.
40. As a Sporades developer, I want reverse proxy configuration generated from the registry, so that routing is deterministic and recoverable.
41. As a Sporades developer, I want the remote helper to own server-side operations, so that local CLI code does not assemble brittle shell fragments.
42. As a Sporades developer, I want all remote commands to treat subnames and domains as data, so that user input does not become arbitrary shell execution.
43. As a Sporades developer, I want the MVP to avoid a hosted web API, so that the only remote control surface is SSH.
44. As a Sporades developer, I want the MVP to avoid a dashboard, so that the first server can be shipped quickly and remain CLI-first.
45. As a Sporades developer, I want the server layout to be stable and inspectable, so that I can debug hosted state directly over SSH when needed.
46. As a Sporades developer, I want remote host state to be domain-aware on disk, so that multiple domains can later coexist on one server.
47. As a Sporades developer, I want container names to include domain-safe identity, so that Capsules with the same subname on different domains do not collide.
48. As a Sporades developer, I want Caddy or equivalent proxy reloads to happen after routing changes, so that registered Capsules become reachable without manual server edits.
49. As a Sporades developer, I want failed proxy reloads to avoid corrupting the previous working config, so that existing Capsules stay reachable.
50. As a Sporades developer, I want the first production host to work at `mattgscox.co.uk`, so that the MVP can be tested as soon as DNS points to `168.119.161.21`.

## Implementation Decisions

- Add a host-management concept separate from local container sessions. Local `deploy` remains the command for local Docker container sessions; remote hosting lives under a host-oriented CLI namespace.
- Local host configuration should be stored outside projects and keyed by alias. The config stores at least server, domain, scheme, and remote root, with a current/default alias.
- Project-level remote binding should store the selected host alias, domain, subname, hosted URL, and remote Capsule identity after registration.
- The Host server registry is authoritative for Hosted Capsule existence and lifecycle state. Project-level remote binding is only a convenience pointer for inferring where the current project should push.
- Commands that do not need the local project bundle, such as list, start, stop, restart, and stats, should operate from any directory when given a Host profile and Hosted Capsule identity.
- If local remote binding disagrees with the Host server registry, the CLI should trust the Host server and ask the user to rebind or pass explicit Host profile and subname flags.
- Registration creates a Hosted Capsule record before any release is pushed. The record reserves the Capsule subname, creates server-side metadata, prepares release and data areas, and may update proxy routing to a not-started/no-release response.
- Registration should create or regenerate the Capsule route immediately. Before a container is running, that route points to the Hosted Capsule unavailable response.
- Registration requires the target Hosted domain to have been bootstrapped/enabled on the Host server. It should not install Host server dependencies or configure a new Hosted domain implicitly.
- If registration is attempted before bootstrap, the command should fail with an actionable hint that names the bootstrap command and the expected Hosted domain TLS directory files.
- Pushing installs a new release into an existing Hosted Capsule. It should not be the operation that first creates the authoritative Hosted Capsule identity.
- Push should install the release without restarting the Hosted Capsule by default. A `--restart` flag should install the release and then restart the Hosted Capsule from the new current release.
- Registered Hosted Capsules without a running container should return a Host-server-owned `503 Service Unavailable` response. This avoids exposing generic reverse-proxy failures for valid-but-unavailable Capsule subnames.
- Start should regenerate the Capsule route to point at the running container. Stop should regenerate the Capsule route back to the Hosted Capsule unavailable response. Restart should end with the route pointing at the replacement running container.
- If start or restart fails to leave a healthy running container, the Capsule route should point to the Hosted Capsule unavailable response, and the CLI should return structured JSON failure output with an actionable hint.
- For the MVP, a healthy running container means Docker accepted the start and the container is still running after a short grace check. A full Capsule health endpoint is not required.
- The target server/domain pair must always come from host configuration or explicit command flags. `mattgscox.co.uk` and `root@168.119.161.21` are seed values for the first setup, not constants.
- The remote server layout should be domain-aware. Host state should be grouped by domain under the configured remote root, with each domain containing its registry and Capsule directories.
- A single Host server can manage multiple Hosted domains. Host profiles keep CLI targeting simple by selecting one Host server and one Hosted domain, while the server-side registry, storage, container names, labels, and proxy config remain domain-scoped.
- Capsule identity uniqueness is scoped to a domain. Container names and labels should include a domain-safe component plus subname to avoid collisions.
- Bootstrap may install or configure only the Host server substrate: Docker, Caddy, the Sporades remote helper, the Hosted Capsule Docker network, the remote root and domain-scoped directories, Caddy config for the Hosted domain, and service reloads needed for Caddy.
- Bootstrap must not configure Cloudflare, create DNS records, create origin certificates, harden the server, create Unix users, install app dependencies, or start Hosted Capsules.
- The remote registry records registered Capsules, URLs, release metadata, status-adjacent metadata, and timestamps. Docker remains the source of truth for live container state.
- A remote helper script should be installed during bootstrap and should own server-side operations such as register, install release, start, stop, restart, list, stats, and proxy regeneration.
- The local CLI should call the remote helper over SSH and transfer release archives using standard SSH-compatible tools. The local CLI should not build long remote shell programs from raw user input.
- Push should call the existing Bundle pipeline locally, package runtime inputs, upload an archive, and ask the remote helper to install it as a new release.
- Push should not require source files or `node_modules` on the server. The host runs the bundled server through Node in Docker.
- Releases should be immutable directories. A `current` pointer or equivalent server-side metadata identifies the active release.
- Start and restart should always run the current release. The MVP should not expose release selection or rollback; users roll back by pushing a previous bundle again.
- Persistent Capsule data should live outside releases and be mounted at `/app/data`, matching the current container session runtime expectation.
- Runtime files should be mounted read-only in Docker. The data directory should be mounted read-write.
- The base runtime image for MVP hosted Capsules should match the current local container session base image.
- The reverse proxy should route `subname.domain` to the matching Capsule container. The generated proxy config should be derived from registry state and reloaded by the remote helper.
- Caddy should use per-Capsule generated routes rather than a wildcard dynamic lookup for the MVP. Each route targets one Hosted Capsule's full subdomain.
- Docker containers should include labels that identify the Host server domain scope, Capsule subname, Hosted Capsule identity, and managed Sporades ownership so Caddy/proxy automation and host management commands can discover them reliably.
- Hosted domains should assume Edge TLS through Cloudflare wildcard SSL. The Host server should present a configured Cloudflare origin certificate; it should not use per-Capsule ACME or DNS-provider certificate automation in the MVP.
- Bootstrap should assume the Cloudflare origin certificate and key already exist on the Host server. It should configure Caddy to use the Hosted domain TLS directory and fail with an actionable hint if those files are missing or unusable.
- The Hosted domain TLS directory should live under the domain-scoped remote root at `hosts/<domain>/tls/`, with expected files named `origin.crt` and `origin.key`.
- The MVP should assume wildcard DNS for each hosted domain. For the first host, both the apex/wanted domain and wildcard subdomains should resolve to `168.119.161.21`.
- All host commands should support `--json` using the existing Sporades JSON output envelope.
- Server stats should use Docker stats in no-stream mode and normalize the output enough for JSON consumers.
- The MVP may use root SSH because the target server already has key access configured. The design should keep SSH user and server configurable so a dedicated Unix user can replace root later.

## Testing Decisions

- The highest-value test seam is the CLI-to-remote-host boundary. Tests should exercise user-visible commands while replacing `ssh`, upload tooling, Docker, and proxy commands with fake executables or fake remote helpers.
- Tests should assert external behavior: command arguments, created local metadata, JSON output, remote helper inputs, release archive contents, and error envelopes. They should avoid asserting private helper function internals.
- The existing container session tests provide prior art for fake Docker command capture, JSON CLI assertions, temp project scaffolds, and checking bundled runtime files.
- Host configuration tests should verify that aliases resolve correctly, current host selection works, explicit host overrides work, and no command relies on `mattgscox.co.uk` unless it was configured.
- Registration tests should verify subname validation, domain-scoped uniqueness, local remote binding writes, and JSON output.
- Push tests should verify that the existing Bundle pipeline is invoked and the uploaded release contains server bundle, client bundle, `index.html`, `sporades.json`, and optional Server env.
- Push tests should verify that `push` does not restart by default and that `push --restart` invokes the restart path after the release is installed.
- Lifecycle tests should verify that start, stop, and restart call the remote helper with validated domain/subname identity and report success/failure through the standard JSON envelope.
- List tests should verify that registry data and live container state are presented as Capsule-oriented output rather than raw Docker output.
- Stats tests should verify that Docker stats output is parsed or passed through in a stable JSON shape.
- Bootstrap tests should verify idempotent remote setup behavior at the command-contract level, not by installing real packages.
- Bootstrap tests should verify that bootstrap performs only Host server substrate setup and does not start Capsules or create Capsule registry entries.
- Integration against the real server can be manual for the MVP because it depends on DNS propagation, SSH access, Docker installation, and public network availability.

## Out of Scope

- A dashboard or browser-based management UI.
- A public hosted management API.
- Authentication or authorization beyond SSH access to the server.
- Multi-node hosting, scheduling, load balancing, or high availability.
- Automatic DNS provider integration.
- Per-Capsule custom domains beyond subnames on a configured host domain.
- Public ACME certificate issuance, wildcard certificate automation, or DNS-provider certificate challenges.
- Uploading or managing Cloudflare origin certificate/key material from the Sporades CLI.
- Image building from arbitrary Dockerfiles.
- Server-side npm install or source-code builds.
- Database migrations beyond the existing Sporades runtime behavior.
- Secrets management beyond transferring the current Server env file shape.
- Production hardening such as non-root containers, read-only root filesystems, seccomp profiles, metrics pipelines, log aggregation, or automatic backups.
- Rollback commands, although the release directory shape should not prevent them later.
- Starting or restarting a non-current historical release.

## Further Notes

The first manual host target is expected to be reachable with `ssh root@168.119.161.21`. DNS is expected to point `mattgscox.co.uk` and wildcard subdomains at that IP before end-to-end browser validation.

This PRD is intentionally for the server/host side of the hosted Capsule MVP. A separate CLI ergonomics or dashboard PRD can build on it later if needed.

The proposed test seam is one high-level CLI/remote-helper contract seam. That keeps the implementation flexible while still proving the behavior that developers and agents actually depend on.
