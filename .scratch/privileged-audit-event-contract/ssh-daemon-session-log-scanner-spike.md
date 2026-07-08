# SSH daemon session-log scanner spike

Issue: `.scratch/privileged-audit-event-contract/issues/03-spike-ssh-daemon-session-log-scanner.md`

## Decision

Proceed with a focused Base image/startup implementation of the dedicated
`sshd` log-file scanner, gated by one real Base-image container smoke when
Docker is available. Do not add a second audit daemon, do not enable
Capsule-level Fail2ban as the audit source, and do not expose raw daemon text as
the user-facing audit contract.

The design should configure OpenSSH to write its daemon log to
`/app/data/ssh/sshd.log`, then have Sporades scan from
`/app/data/ssh/sshd-audit-cursor.json` and emit normalized Privileged audit
events through the common envelope from issue 01.

## Proof Outcome

OpenSSH `sshd -E` can write authentication and session facts to a dedicated log
file while preserving key-based authentication. A local smoke using the host
OpenSSH server started `sshd` on `127.0.0.1` with:

- `-E <temp>/sshd.log`
- `LogLevel VERBOSE`
- `PasswordAuthentication no`
- `PubkeyAuthentication yes`
- a generated host key and generated authorized public key

The successful login produced suitable facts for:

- accepted public key, including username, remote address, key type, and
  SHA256 key fingerprint;
- accepted public-key authentication;
- session start;
- client disconnect and user disconnect.

A negative login with an untrusted key produced a safe authentication failure
fact with username, remote address, key type, and SHA256 key fingerprint.

The smoke also proved an important boundary: with `sshd -E`, the log lines do
not carry a daemon timestamp in this OpenSSH build. The normalized audit event
timestamp should therefore be the scanner emission time unless a later Base
image smoke proves a timestamped `sshd` file format is available without adding
syslog or another daemon.

## Docker Limitation

The Base-image/container proof could not be completed in this worktree because
Docker Desktop was not running. `docker build -f Dockerfile.base -t
sporades-ssh-log-spike:local .` failed before build with:

`failed to connect to the docker API at unix:///Users/mattcox/.docker/run/docker.sock`

That means this spike proves the OpenSSH logging mechanism and scanner design,
but it does not honestly prove an end-to-end local Container session or Hosted
Capsule login against the current Base image. The implementation issue should
include a focused Base-image smoke that starts the current `sporades-start`
path with SSH enabled and asserts that `/app/data/ssh/sshd.log` receives the
same facts.

Because local Container sessions and Hosted Capsules already share
`Dockerfile.base`, `/usr/local/bin/sporades-start`, and the `/app/data` writable
mount contract, one successful Base-image smoke covers both runtime shapes for
the daemon logging mechanism. Hosted-specific code should still verify that the
same environment variables and data mount are used through the Host helper.

## Startup Design

When SSH is enabled, `sporades-start` should add:

- `SPORADES_SSHD_LOG_PATH`, defaulting to `/app/data/ssh/sshd.log`;
- `SPORADES_SSHD_LOG_LEVEL`, defaulting to `VERBOSE`;
- an `sshd` launch option equivalent to `-E "$SPORADES_SSHD_LOG_PATH"`;
- an `sshd` option equivalent to `-o LogLevel="$SPORADES_SSHD_LOG_LEVEL"`.

The log path stays under the writable data mount. The release mount remains
read-only. The existing key-only authentication, `sporades` user, no root login,
no sudoers access, loopback-only Docker publishing, and dormant Fail2ban posture
remain unchanged.

## Scanner Design

The scanner should live in Sporades runtime/platform code, not in a new daemon.
It should run only when the log file exists and should degrade quietly if the
file is absent, unreadable, or still empty.

The cursor state should be stored as JSON at
`/app/data/ssh/sshd-audit-cursor.json` with:

- schema version;
- active log path;
- per-file identity from `dev`, `ino`, `size`, and `mtimeMs`;
- byte offset last scanned for each known file identity;
- a bounded LRU of recently emitted source line hashes;
- scanner timestamp for diagnostics.

On runtime restart, the scanner resumes from the persisted offset for the same
file identity. If the active file shrinks below the remembered offset, treat it
as truncation and resume from byte `0`, using the persisted recent-line hashes
to suppress duplicate event emission. If the active path has a new file
identity, treat it as rotation, scan known rotated siblings such as
`sshd.log.1` before the active file where present, and then persist the new
active cursor.

Event idempotency should be based on internal source identity, not user-facing
payload. A stable source event key can be derived from source `sshd`, file
identity, byte offset, normalized event name, and a hash of the raw source line.
The raw source line hash is internal scanner state only; it must not appear in
the Privileged audit event.

## Parser Whitelist

The parser is allow-list only. Unknown daemon log lines remain raw diagnostics
in `/app/data/ssh/sshd.log`; they do not become Privileged audit events.

Allowed translations:

| OpenSSH fact | Audit event | Outcome | Safe metadata |
| --- | --- | --- | --- |
| Accepted public-key authentication | `ssh.auth.succeeded` | `succeeded` | `username`, `remoteAddress`, `remotePort`, `authMethod: "publickey"`, `keyType`, `keyFingerprint`, source: `sshd` |
| Failed public-key authentication | `ssh.auth.failed` | `failed` | `username`, `remoteAddress`, `remotePort`, `authMethod: "publickey"`, `keyType`, `keyFingerprint`, source: `sshd`, `safeErrorCode: "SSH_AUTH_FAILED"` |
| Safe session start shapes such as shell, command type, or SFTP subsystem without command text | `ssh.session.opened` | `succeeded` | `username`, `remoteAddress`, `remotePort`, `sessionKind`, source: `sshd` |
| User disconnect or session close | `ssh.session.closed` | `succeeded` | `username`, `remoteAddress`, `remotePort`, `sessionOutcome: "disconnected"`, source: `sshd` |

The parser must reject or ignore lines that would require exposing command
arguments, environment values, unstructured daemon payloads, or ambiguous text
as audit metadata.

## Audit Envelope

Translated events should use the issue 01 common envelope:

- `category: "audit"`
- `data.schema: "sporades.privileged-audit.v1"`
- `actorKind: "platform"`
- `operation` matching the event, such as `ssh.auth.succeeded`
- `surface: "sshd-log-scanner"`
- `targetResourceKind: "container-ssh-session"`
- `source: "sshd"`
- `outcome` from the whitelist table
- `correlation` containing a scanner/run id when available

Raw daemon lines are implementation input. The user-facing audit contract is
the normalized JSONL event.

## Safe Metadata

Safe metadata:

- username where present in the daemon fact;
- remoteAddress for loopback or Host-side source addresses;
- remotePort;
- keyFingerprint where OpenSSH emits a SHA256 fingerprint;
- keyType;
- `authMethod`;
- `sessionKind` when it is a bounded value such as `shell`, `command`, or
  `sftp`;
- source: `sshd`;
- session outcome.

Forbidden metadata:

- full public keys;
- generated authorized-key file contents;
- source key file paths from Hosted releases;
- private key material;
- commands or command arguments;
- environment values;
- raw daemon log lines;
- passwords, tokens, cookies, authorization headers, Server env values,
  client secrets, and other secrets;
- raw stack traces.

## Recommendation

Proceed, but keep the implementation split small:

1. Update `Dockerfile.base` startup to make `sshd` write
   `/app/data/ssh/sshd.log` with `LogLevel VERBOSE` only when SSH is enabled.
2. Add a scanner/parser module behind the runtime-owned Privileged audit
   emitter.
3. Add parser and cursor tests for restart, truncation, rotation, duplicate
   suppression, safe line translation, and unknown-line ignore behavior.
4. Add one opt-in or focused Base-image smoke that proves a real key-auth login
   writes the expected file facts when Docker is running.
5. Add Host helper assertions that Hosted Capsules pass through the same
   startup/data-mount contract.

Defer to broader Base image logging work only if the Base-image smoke shows
that `sshd -E /app/data/ssh/sshd.log` cannot run under the existing hardening
model. Use an OpenSSH hook or stdout design only if the file scanner fails that
smoke or cannot produce the safe whitelist facts above.

## Process Cleanup

The local OpenSSH smoke used temporary directories under `/tmp`, generated
throwaway host/client keys, killed the background `sshd` process through a shell
trap, and removed the temporary directories. No Docker containers or images were
created because the Docker daemon was unavailable.
