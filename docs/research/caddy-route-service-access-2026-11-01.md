# Durable Caddy route access — 2026-11-01

## Cause and implementation

The Capsule route publisher requested mode `0644` when creating a temporary
file, then published it without correcting the mode reduced by the caller's
umask. With umask `077`, a published route was `0600`, unreadable by the
unprivileged Caddy service. A later publication under `022` could make it
readable again, but also expose its internal probe/address tokens to other
users. A root-operated reload hid the service-user failure.

The publisher now creates a private candidate, retains its descriptor, and sets
the helper owner's UID, installed Caddy primary GID and mode `0640` before
publication. Production ownership is `root:caddy`. Existing routes are repaired
before retention for rollback. Bootstrap upgrades the registered Capsules'
legacy route metadata without changing their bytes or restarting Capsules.
Removal/rollback uses the same access contract. Canonical Cloudflare TLS material
is prepared for the service account during bootstrap.

Metadata mutation uses no-follow descriptors, trusted ancestor/inode checks and
single-link regular files. Configuration directories are service-group-readable
and searchable (`0750`); the installation root gains search access without new
listing access. Root retains write ownership. No service runs as root, and no
periodic permission repair or post-deployment chmod script is required.

## Regression and local evidence

- The new publication regression failed before the fix: `capsule.start` under
  umask `077` produced `0600` instead of `0640`.
- Running/unavailable routes pass under `077` and `022`. Bootstrap repairs a
  seeded legacy `0600` route while preserving its exact bytes.
- Validation and reload failures preserve a readable retained route. A
  hard-linked route is refused without changing the other file's permissions.
- A disposable Linux container ran six focused cases with no external network,
  a read-only source mount and separate writable temporary storage. Distinct
  UID/GID checks proved service read access, denied service writes and denied
  unrelated-user reads. A matching service group on a restricted installation
  root was also covered.
- Host/observability/autostart suite: 393 passed and 15 explicit opt-in cases
  skipped. Five process-inspection cases initially failed under the Mac sandbox;
  all five passed unchanged with the native process visibility required by the
  repository's test prerequisites. The distinct Linux-user case was verified
  separately as above. This is scoped Host coverage, not the full repository suite.
- Build, typecheck and 56 documentation tests passed. Focused rollback tests
  additionally passed after seeding the retained route with mode `0600`.

## Live application and acceptance

Applied the built helper through `host upgrade --host live`, then applied the
normal `host bootstrap --host live` repair. Installed helper SHA-256:
`b3c04470872b0867d98f01d57dfac82ff87e631acb82124b0c7ee25993797be7`.

For TallyTray and Tickets, root ownership, Caddy primary group and mode `0640`
were verified. The real `caddy` user could read but could not write; the real
`nobody` user could not read. Capsule route bytes and the Kimatt analytics alias
were unchanged. Caddy configuration validation as the service user and normal
`systemctl reload caddy` both succeeded. The Caddy PID, both Capsule container
IDs and their start times were unchanged. Tickets, TallyTray and Umami heartbeat
each returned public HTTPS 200 afterward.

Protected pre-upgrade helper/config metadata, original Capsule identities and
the verification summary are retained in `/root/caddy-permissions-20261101` on
the existing Host. A full production reboot/restart was not performed.
