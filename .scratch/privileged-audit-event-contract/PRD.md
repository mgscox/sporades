# Privileged Audit Event Contract

Status: draft

## Source Planning

- `docs/ROADMAP.md` (Recommended Next Features: "Privileged audit event contract")
- `docs/PRD.md`
- `CONTEXT.md`
- `docs/adr/0022-acl-rules-are-runtime-policy-functions.md`
- `docs/adr/0025-base-image-carries-dormant-ssh-capability.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/05-centralize-json-server-logging.md`
- `.scratch/ssh-to-docker/PRD.md`

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to reflect the implementation status, per the roadmap Promotion Rule.

## Problem Statement

Sporades is preparing to add a Privileged server role: a server-only authority
for trusted runtime and Capsule operations that intentionally run outside normal
user rights. That role will be able to bypass normal app ACLs or inspect
runtime-owned resources through explicit server-code APIs.

Sporades already has a JSONL log stream, Log index, `ctx.log`, `sporades logs`,
and Host log surfaces. Those are enough to support a narrow audit contract, but
the current roadmap-level language does not yet define what privileged activity
must emit, which fields are safe, how events are inspected, or how existing
high-impact access paths such as Container SSH access should fit into the same
model.

Without this contract, the Privileged server role could ship as a hidden
skeleton key and only gain useful auditability later. That is backwards. The
audit contract should be defined first, using the existing JSONL log stream,
without waiting for the broader centralized JSON server logging feature.

## Solution

Define a small, stable Privileged audit event contract for security-relevant
server-side actions. A Privileged audit event is a structured JSONL log event
emitted when privileged or comparable server-controlled activity starts,
completes, errors, or finishes, and for selected existing access paths that have
comparable operational sensitivity.

The first contract should define:

- the event category and naming vocabulary;
- the required fields for privileged actor, operation, Capsule identity,
  call site or API surface, request/job/correlation identity, target resource
  kind, outcome, and safe error code;
- the redaction and payload-size rules;
- how events appear in `sporades logs --json`, `sporades logs tail --json`,
  Container stdout, and Hosted Capsule logs where those surfaces already exist;
- how the contract differs from the broader centralized JSON server logging
  roadmap item.

The contract should also capture how existing Container SSH access can begin
using the same audit vocabulary:

- Sporades-controlled SSH configuration, validation, lifecycle, and inspection
  actions are good first audit sources.
- Real SSH login/session events are desirable, but require a Base image/startup
  design decision because the OpenSSH daemon owns those events. This PRD should
  shape that decision rather than pretending it is free.

## User Stories

1. As a Capsule operator, I want privileged server operations to emit structured audit events, so that I can understand when normal user rights were bypassed.
2. As a Capsule operator, I want audit events to use the existing JSONL log stream, so that I can inspect them with existing Sporades log commands.
3. As a Capsule operator, I want audit events to include the Capsule identity, so that I can distinguish activity across local Container sessions and Hosted Capsules.
4. As a Capsule operator, I want audit events to include the operation name, so that I can tell whether the event came from runtime inspection, ACL bypass, Job execution, SSH setup, or another privileged path.
5. As a Capsule operator, I want audit events to include the actor kind, so that I can distinguish Privileged server role activity from captured-user activity.
6. As a Capsule operator, I want audit events to include the call site or API surface, so that I can trace which server-code surface requested privileged behavior.
7. As a Capsule operator, I want audit events to include request, Job, or correlation identity when available, so that I can connect audit events to surrounding logs.
8. As a Capsule operator, I want audit events to include target resource kind rather than raw resource contents, so that auditability does not leak private data.
9. As a Capsule operator, I want audit events to include outcomes, so that started, completed, errored, and finished privileged activity is visible without implying business success or authorization policy.
10. As a Capsule operator, I want safe error codes instead of raw stack traces, so that failures are diagnosable without leaking internals.
11. As a Capsule operator, I want audit events to redact known sensitive keys, so that secrets do not leak into logs.
12. As a Capsule operator, I want audit events to cap payload size, so that a privileged operation cannot flood the log stream.
13. As a Capsule author, I want the Privileged server role to be blocked until audit events exist, so that privileged APIs are not added as invisible power tools.
14. As a Capsule author, I want the audit contract to distinguish privileged execution from running as a captured user, so that Jobs and scheduled Jobs can make actor semantics explicit.
15. As a Capsule author, I want the audit event contract to avoid adding new browser-visible credentials, so that privileged behavior remains server-side only.
16. As an AFK agent, I want audit events to be machine-readable, so that I can verify privileged behavior without scraping human logs.
17. As an AFK agent, I want tests to prove audit event shape and redaction, so that future privileged features cannot silently skip the contract.
18. As an operator using Container SSH access, I want SSH configuration and lifecycle actions to emit audit events where Sporades controls the behavior, so that opt-in emergency access has an audit trail.
19. As an operator using `sporades deploy ssh`, I want SSH inspection to be auditable without exposing full authorized-key material, so that I know when access state was inspected.
20. As a Host server operator using `sporades host ssh`, I want Hosted Capsule SSH inspection to be auditable through the Host helper path, so that remote access diagnostics are visible.
21. As a Host server operator, I want SSH audit events to include key counts and fingerprints where already safe, so that I can identify configured access policy without printing public-key contents.
22. As a Host server operator, I want real SSH login/session auditing to be evaluated explicitly, so that Sporades does not confuse "SSH was configured" with "someone connected".
23. As a security officer, I want to review all privileged audit events for a Capsule, time window, operation class, or actor kind using existing JSON log surfaces, so that I can reconstruct an incident without needing a separate dashboard.
24. As a security officer, I want audit events to distinguish started, completed, errored, and finished outcomes, so that I can tell whether the privileged action boundary began, returned, threw, and reached its final close marker without overclaiming side-effect durability.
25. As a security officer, I want audit events to prove that browser/client credentials, sessions, and ordinary Capsule app code cannot forge Privileged server role activity, so that privileged access remains server-side and runtime-owned.
26. As a security officer, I want audit events to state what sensitive evidence was redacted or represented only by fingerprints, counts, stable IDs, or resource kinds, so that logs are useful without becoming a second secret store.
27. As a security officer, I want SSH audit coverage to explicitly separate configured/inspected access from real login/session capture, so that emergency-access evidence is not overstated.
28. As a security officer, I want audit events to preserve enough correlation identity to build an incident timeline across CLI commands, Host helper actions, Jobs, requests, and surrounding logs, so that follow-up investigation is possible.
29. As a maintainer, I want the audit contract to stay narrower than centralized JSON logging, so that the dependency does not balloon into a broad observability release.
30. As a maintainer, I want the contract to reuse JSONL log stream and Log index semantics, so that this feature does not invent a second log store.
31. As a maintainer, I want Log index failures to degrade inspection rather than fail privileged workflows, so that audit emission stays aligned with the existing logging model.
32. As a maintainer, I want audit events to be documented before implementation issues are split, so that future privileged features inherit a consistent contract.

## Security Officer Coverage

The existing Capsule operator, AFK agent, Host server operator, and maintainer
stories already cover much of what a security officer would need: structured
events, Capsule identity, actor kind, operation name, call site, correlation
identity, safe outcomes, redaction, machine-readable inspection, SSH lifecycle
coverage, and tests that prevent contract drift.

The distinct security-officer scope is incident review rather than day-to-day
operation. The audit contract should therefore make these needs explicit:

- reconstruct who or what started privileged activity, where it entered the
  runtime, which Capsule/resource was targeted, and how the callback completed;
- prove the difference between started, completed, errored, and finished
  privileged activity;
- verify that privileged audit events are runtime/platform-owned and cannot be
  forged by browser code, session tokens, or ordinary `ctx.log` calls;
- understand the evidence boundary for SSH, especially the difference between
  configured access, inspected access state, and real login/session events;
- inspect redacted, bounded, machine-readable evidence without exposing
  secrets, raw authorized keys, request bodies, Server env values, or session
  credentials.

These use cases do not require a new audit database, dashboard, retention
system, or SIEM integration in this feature. They should be satisfied by the
same JSONL log stream, recent Log index behavior, and CLI/Host log inspection
surfaces already in scope.

## Implementation Decisions

- Privileged audit events are JSONL log events, not a new database table or a separate audit-log product.
- Privileged audit events should use the existing JSONL log stream as the durable append stream.
- The bounded Log index may index Privileged audit events for recent structured inspection, but the JSONL log stream remains the durable source.
- Log index write or pruning failures must not roll back the privileged operation that emitted the event.
- Privileged audit event emission must run through the runtime logging envelope so it inherits timestamping, redaction, payload caps, stdout emission, and recent-log inspection behavior.
- Privileged audit event emission is not best-effort. Failure to emit a required
  privileged audit event must throw rather than allow privileged work to proceed
  or appear complete without durable audit evidence.
- If required audit emission fails after the audited action has thrown, the
  audit-emission error should be thrown with the original action error attached
  as structured context. If required audit emission fails after the audited
  action has returned, the audit-emission error should be thrown with the action
  result attached as structured context.
- Attached action errors and action results are server-side structured context
  only. They must not be exposed in default client-visible error responses;
  browser and external caller responses remain opaque and stable unless Capsule
  code explicitly catches the error and returns a safe response shape.
- The first event category should be explicit enough to filter from ordinary app logs. Candidate: `security` or `audit`. The implementation PRD/issues should pick one and use it consistently.
- Event names should be category-specific and stable. Candidate names include `privileged.started`, `privileged.completed`, `privileged.errored`, `privileged.finished`, `ssh.config.validated`, `ssh.access.enabled`, `ssh.access.disabled`, `ssh.state.inspected`, and later `ssh.session.opened` / `ssh.session.closed` if real SSH session capture is implemented.
- Required event fields should include timestamp, category, event name, level, message, Capsule identity, release identity when available, actor kind, operation, call site or API surface, correlation identity, target resource kind, outcome, and safe error code where applicable.
- Actor kind must distinguish at least `privileged-server-role`, `captured-user`, `platform`, and `unknown`.
- Privileged audit events should not store raw request bodies, full authorized keys, private keys, Server env values, session tokens, cookies, authorization headers, passwords, client secrets, or raw stack traces.
- Privileged audit events may include SSH public-key fingerprints and key counts because the existing SSH contract treats fingerprints as safe inspection metadata.
- Privileged audit events should prefer resource kinds and stable IDs over full resource contents.
- The contract should define outcome vocabulary: `started`, `completed`, `errored`, and `finished`.
- Outcomes should describe the audit-event lifecycle state, not authorization policy or business result. `completed` means the audited callback or action returned; `errored` means it threw, rejected, or otherwise surfaced an error; `finished` means the privileged-run wrapper reached its `finally` path and gives log readers a stable end event to pair with `started`.
- Existing and future SSH audit emitters must use the same `outcome` field
  vocabulary. Event names may remain domain-specific, but the `outcome` field
  does not use SSH-specific or legacy success/failure terms.
- The contract should support correlation with requests, Jobs, scheduled Jobs, Host helper actions, and CLI operations without requiring all of those systems to exist first.
- Existing app `ctx.log` should not become privileged audit logging. App code can log ordinary app facts, but Privileged audit events are runtime/platform-owned.
- Privileged audit event emission should not expose a general app-facing logging API that can forge privileged audit events.
- Privileged server role implementation is blocked on this contract.
- Job scheduling is indirectly blocked on this contract through Privileged server role.
- The broader centralized JSON server logging feature remains separate. It may later improve envelope consistency, export, retention, and indexing, but is not a prerequisite for this contract.

## SSH Audit Decisions

- Sporades-controlled SSH actions are in scope for the audit contract because Container SSH access is opt-in emergency/compatibility access with a security-sensitive surface.
- The first SSH audit slice should cover events Sporades already controls:
  - SSH config validation success/failure during local `sporades deploy`;
  - SSH config validation success/failure during `sporades host push`;
  - local Container session start/redeploy where SSH is enabled;
  - Hosted Capsule start/restart where SSH is enabled;
  - local `sporades deploy ssh` inspection;
  - Hosted `sporades host ssh` inspection;
  - disabled/no-effective-key states where an explicit SSH block resolves to no effective keys.
- SSH audit events must not print full public keys, private key material, source key file paths for Hosted releases, or generated authorized-key file contents.
- SSH audit events may include enabled state, running state, target port, loopback-only exposure, key count, and fingerprints where existing SSH inspection already exposes them.
- Actual SSH login/session events are not automatically captured by the current Sporades runtime because OpenSSH runs from the Base image startup path, not inside `sporades/server`.
- The preferred first design spike for real SSH login/session events is to enable `sshd` auth/session logging to a dedicated file under the writable data mount, then have a Sporades-owned scanner periodically translate newly observed daemon log lines into normalized Privileged audit events.
- The SSH log scanner should be cursor-based and idempotent so it can resume after runtime restart, file truncation, or log rotation without duplicating old audit events.
- The SSH log scanner should parse a small whitelist of events, such as authentication success, authentication failure where safe, session open, session close, and disconnect. Unknown daemon log lines should remain raw diagnostic logs, not privileged audit events.
- Translated SSH audit events may use domain-specific event names, such as `ssh.session.opened`, `ssh.session.closed`, `ssh.auth.succeeded`, and `ssh.auth.failed`, while preserving the source as `sshd`; their `outcome` field must still use `started`, `completed`, `errored`, or `finished`.
- Translated SSH audit events must preserve the same redaction rules as the rest of the contract. They may include safe daemon metadata such as username, remote address where acceptable, key fingerprint where available, and session outcome, but must not include full public keys, commands, environment values, or raw daemon log lines by default.
- The raw `sshd` log file is an implementation source, not the user-facing audit contract. The user-facing contract is the normalized JSONL audit event emitted through Sporades logging surfaces.
- The Base image should include Fail2ban as dormant SSH hardening material alongside OpenSSH, but enabling it inside a Capsule must be proven compatible with Sporades container hardening. It must not require broad extra capabilities, public SSH exposure, writable release mounts, sudo, or root login.
- Host server provisioning should install and enable Fail2ban for the Host server's own `sshd` service, with an explicit `sshd` jail, because Host operator SSH is a live server access path separate from per-Capsule SSH.
- Capsule-level Fail2ban activity is hardening-adjacent telemetry, not the audit source of truth. If enabled later, bans may emit structured audit events, but the audit contract should still rely on normalized `sshd` events for login/session facts.
- A separate long-running daemon that calls back into the Sporades audit logger should not be the initial design unless the log-file scanner proves insufficient. That path risks creating a second lifecycle, failure mode, and privilege boundary.
- Alternative designs remain available if the scanner fails the spike:
  - configure `sshd` to emit auth/session logs to container stdout in a parseable format and translate or preserve them as audit events;
  - use OpenSSH hooks such as `ForceCommand` or wrapper scripts where compatible, while preserving normal SSH/SCP/SFTP compatibility guarantees;
  - defer per-login audit until a broader Base image logging path exists.
- The PRD should not require real SSH session audit in the first implementation unless the design spike proves it can be done without weakening the SSH contract or turning SSH into a custom product surface.

## Testing Decisions

- Tests should verify external log behavior through `sporades logs --json`, `sporades logs tail --json`, Container stdout where applicable, and Host helper JSON outputs rather than private helper internals.
- Runtime/unit tests should prove Privileged audit event envelope shape, required fields, redaction, payload caps, and safe error codes.
- Dev-session tests should prove emitted audit events appear in the JSONL log stream and recent Log index inspection.
- Local Container tests should prove audit events survive Docker stdout JSONL behavior when `SPORADES_LOG_STDOUT=1` is active.
- Host helper tests should prove Hosted Capsule SSH lifecycle/inspection audit events can be emitted without requiring a real interactive SSH session.
- SSH tests should not require manual SSH sessions.
- If real SSH login/session auditing is pursued, it should be protected by focused Base image/startup tests and, if practical, an opt-in smoke test that proves one successful local SSH connection emits a safe audit event.
- If the `sshd` log-file scanner design is pursued, tests should prove cursor persistence, duplicate suppression, truncation or rotation recovery, safe parsing of known auth/session lines, and ignored handling for unknown daemon lines.
- Base image tests should assert that Fail2ban is available in the Docker build while remaining dormant unless a later implementation explicitly enables it safely.
- Host provisioning tests or smoke checks should verify that `fail2ban-client status sshd` succeeds on a prepared Host server.
- Redaction tests should include keys such as `password`, `token`, `secret`, `authorization`, `cookie`, client-secret-like keys, and exact Server env values.
- Tests should assert that raw authorized-key contents and private-key-looking material never appear in audit events.
- Tests should assert that raw `sshd` log lines do not become user-facing audit payloads by default.
- Tests should assert that Log index failures do not fail the workflow that emitted an audit event.

## Out of Scope

- Do not implement the Privileged server role in this feature.
- Do not implement Job queue or Job scheduling in this feature.
- Do not implement the full centralized JSON server logging feature.
- Do not add OpenTelemetry, metrics, trace export, dashboards, or retention policy management.
- Do not introduce a new persistent audit database separate from the JSONL log stream and Log index.
- Do not expose Privileged audit event forging to Capsule app code.
- Do not log raw request bodies by default.
- Do not log secrets, private keys, full public authorized-key contents, session tokens, cookies, authorization headers, or Server env values.
- Do not make SSH the primary management interface for Sporades.
- Do not add a second SSH audit daemon in the first design unless the dedicated `sshd` log-file scanner is proven insufficient.
- Do not enable Capsule-level Fail2ban by granting broad network administration capabilities or weakening the existing Docker hardening model.
- Do not require real interactive SSH sessions for normal automated test coverage.

## Further Notes

The useful line is not "log everything privileged." The useful line is "every
privileged boundary emits a small, structured, redacted fact that lets a human
or agent reconstruct what authority was used, where, and with what outcome."

SSH is the awkward but valuable existing case. Sporades can audit the parts it
already controls immediately: configuration validation, lifecycle setup,
effective-state inspection, and Hosted helper requests. Auditing the actual
OpenSSH login/session boundary is probably possible, but it lives closer to the
Base image and startup script than to the current server runtime. That should be
designed deliberately instead of quietly promised by the word "audit."

The least-surprising first path is probably not another daemon. Let `sshd` write
its own auth/session facts to a dedicated file, then let Sporades scan from a
remembered cursor and translate only known-safe lines into the same structured
audit envelope as everything else. That keeps OpenSSH as the authority for what
happened while keeping Sporades as the authority for what becomes a stable audit
event.
