# Host-managed errors and analytics

Sporades 0.9.x can opt a Host into pinned GlitchTip and Umami services. Existing
Capsules, external providers and ordinary Host bootstrap remain unchanged.
The runtime integrations remain opt-in through
[Errors and analytics](./errors-and-analytics.md).

## Install

Use a bootstrapped Linux Host with Docker Compose v2, Caddy and systemd. The
installer refuses fewer than **2 Docker CPUs, 2 GiB Docker memory, or 20 GiB
free disk** at the remote root. These are minimums for a small observability
stack, not spare capacity for Capsules. Prefer a dedicated 4 GiB or larger ops
Host, reserve additional CPU/RAM for Capsules, and size disk/retention for event
volume. No server is resized automatically.

Ensure `errors.<hosted-domain>` and `analytics.<hosted-domain>` resolve to this
Host and TCP 80/443 reaches Caddy. Routes use Caddy automatic TLS, including on
Hosts whose Capsule routes use Cloudflare origin certificates. These service
hostnames therefore require public certificate issuance to work.

```sh
sporades host services enable observability --on ops --json
sporades host services status observability --on ops --json
```

Omit `--on` to use the current Host profile; `--host` is also accepted for stack
operations. Installation starts GlitchTip web/worker, Valkey, two separate
Postgres databases, and Umami. Only web listeners publish ports, on loopback.
Images are release-owned exact version pins, with bounded container logs and
no-new-privileges. Current pins: GlitchTip `v5.2.1`, Umami `postgresql-v2.20.2`,
Postgres `16.10-alpine`, Valkey `8.1.3-alpine`. Pins advance through reviewed
Sporades patches; do not substitute `latest` tags. Upstream references:
[GlitchTip installation](https://glitchtip.com/documentation/install/) and
[Umami installation](https://docs.umami.is/docs/install).

Enable generates private database/app secrets and admin passwords under
`<remote-root>/hosts/<domain>/services/observability/secrets.json` (0600 inside
a protected directory). Credentials appear only in the first successful enable
response; save them in your password manager. Subsequent enables do not disclose
or rotate them. If output is lost, an authorized Host administrator can recover
the passwords from that protected file. Do not copy it into a Capsule or commit
it. Status never returns passwords or provider tokens. The GlitchTip admin is
`ops@<hosted-domain>`; the Umami admin is `admin`. Public self-registration is
disabled. GlitchTip host and CSRF origin checks explicitly allow its managed
HTTPS hostname (plus loopback API access). Mail defaults to console-only output. Configure protected SMTP below if email
alerts are wanted; Capsule `mail.smtp` is a separate subsystem.

Retry the same enable after a failed installation. Intent is written before
starting containers; service hostnames remain reserved through partial installs,
disable and uninstall. Existing Capsule or alias ownership blocks installation.
Caddy routes appear only after the default Umami password has been replaced and
both services have initialized. Route validation/reload failure restores the
previous route file. Compose projects and volumes are isolated by remote root
and Hosted domain.

## Public analytics hostname

The operator can select an exact public Umami hostname independently of the
Host registry/Compose domain. In the protected services directory
`<remote-root>/hosts/<hosted-domain>/services/observability/`, install a
helper-owned mode-`0600` regular file named `public.json`:

```json
{"version":1,"analyticsDomain":"analytics.example.com"}
```

Point that hostname's DNS to the services Host and rerun
`sporades host services enable observability --on <services-host> --json`.
The generated route proxies directly to Umami's current loopback port, preserving
the public Host/Origin for authenticated requests. Status and Capsule provisioning
use this hostname too. Do not use a second proxy route that rewrites the Host to
a legacy domain. Remove an existing operator alias route before applying the
managed replacement, retaining its protected rollback copy until validation.

The hostname is reserved against Capsule aliases while the service intent
exists, including while disabled. Invalid configuration fails closed; absent
configuration retains `analytics.<hosted-domain>`. The file is operator routing
intent: disable/uninstall and database restore leave it in place. Preserve it
with the protected services directory during Host disaster recovery; database
snapshots do not replace the destination's routing configuration.

Verify an authenticated dashboard after a hostname change, including a page
refresh and website navigation. Heartbeat/login API success alone does not
establish that dashboard Server Actions work.

## Protected GlitchTip SMTP

The installed helper and CLI must include `mail-configure` and `mail-apply`.
Installing that version is a separate operator-controlled deployment. Applying or
rotating SMTP on a compatible installation does **not** require `host upgrade` or
restarting the whole stack. These commands target the services Host (`--on`).

Stage a JSON file **on the services Host**, using the helper's OS user. Use an
operator password manager or a protected editor with backup/swap disabled; never
put credentials in a shell command, environment override, command history, chat,
or a diagnostic capture. The staged file and its eventual `mail.json` must be
regular single-link files owned by that user with exact mode `0600`. All parent
directories must be helper/root-owned and not writable by group/other. Symbolic
links, hard links, unsafe ownership/modes, unknown fields and partial input fail
closed. Keep staging outside `/tmp` and outside Capsule-readable directories.

For example, create `<remote-root>/mail-staging/` with mode `0700`, then use the
protected editor to write `<remote-root>/mail-staging/glitchtip.json` with mode
`0600`. Its complete schema is:

```json
{
  "version": 1,
  "transport": "smtp-ssl",
  "host": "smtp.example.com",
  "port": 465,
  "username": "synthetic-user@example.com",
  "password": "synthetic-replace-in-protected-editor",
  "from": "alerts@example.com"
}
```

Only authenticated implicit TLS is supported. Supply an exact lowercase DNS
hostname, an integer port `1..65535` (including `465`), nonempty printable ASCII credentials and
a plain sender mailbox without a display name. The helper encodes credentials
for the pinned provider's `smtp+ssl://` URL. Certificate and hostname verification
use the provider container's normal CA store. There is no insecure, plaintext,
STARTTLS fallback, arbitrary environment input, or verification bypass.

From the configuring workstation, publish the on-Host staged file and apply it:

```sh
sporades host services mail-configure observability --on ops --file /srv/sporades/mail-staging/glitchtip.json --json
sporades host services mail-apply observability --on ops --json
sporades host services status observability --on ops --json
```

Substitute the actual protected remote root in `--file`; this is an absolute
**remote** path, not a file uploaded/read from the workstation. Publication is
atomic and synced to disk under the Host lock. It writes the validated setting to
`<remote-root>/hosts/<hosted-domain>/services/observability/mail.json`, without
printing credentials. Remove the staged copy securely after publication according
to the operator's storage policy. Status reports only `mail.configured` and
`mail.transport`; it does not test authentication, message acceptance or receipt.

`mail-apply` requires an enabled, ready stack with no interrupted restore. It
updates the mail fields in the protected Compose file and pins the existing web
listener so Caddy keeps its working route, then recreates exactly
**web and worker**, using `up -d --no-deps --force-recreate web worker`. There is a
brief GlitchTip interruption. Postgres, Valkey, Umami, Caddy, Capsules, volumes,
image pins, project identities, DSNs and analytics routing remain in place.
Readiness checks the web API; it is not SMTP acceptance. Configuration may also be
staged while services are disabled or before initial installation; the next
`enable` consumes it. Repeated enable and disable/uninstall/re-enable retain it.
Do not edit the generated Compose file to configure mail.

### Rotation, rollback and recovery

Keep a protected rollback copy in the operator credential store. Stage a complete
replacement with the new credential, run `mail-configure`, then `mail-apply`.
Verify a real GlitchTip notification before revoking the previous credential.
If apply fails or stops between recreations, retain both credentials and retry
`mail-apply`; the desired config remains durable. For rollback, stage the previous
complete JSON and run the same two commands. Provider authentication responses
are omitted from helper diagnostics; investigate with the provider's protected
operator tooling without publishing raw responses or container environment dumps.

To return to console-only behavior, stage `{"version":1,"transport":"console"}`
and publish/apply it the same way. Console mail writes notification content into
GlitchTip logs. Removing `mail.json` also restores the historical default at the
next apply/enable, so loss of this file must be treated as lost configuration.
Malformed/unsafe installed config fails closed: repair ownership/mode or quarantine
the damaged file in protected storage, then republish a complete known-good copy.
Never repair by printing its contents. If credentials are lost, issue a replacement
through the provider's operator process and stage it; do not infer them from logs.

Database backup/restore does not back up or replace SMTP credentials or `public.json`.
After database restore, enable reads the **destination's current** mail setting.
For Host disaster recovery, separately restore `mail.json`, `public.json` and the
existing protected service secrets with their ownership/modes. Preserve the old
integration identities and database history. Keep these files in encrypted
operator-controlled backups, separate from application database dumps.

### Acceptance evidence

Run the disposable local acceptance from a Linux checkout with protected
ancestors, Docker Compose v2, OpenSSL and restic `0.18.1` (the tested version).
The older restic `0.14` emits short backup summary IDs that the existing helper
rejects. A container runner can bind the checkout under protected ancestors;
keep its CLI configuration inside that checkout. The command is:

```sh
SPORADES_CONFIG_DIR="$PWD/.tmp/observability-config" SPORADES_OBSERVABILITY_SMTP_TEST=1 SPORADES_OBSERVABILITY_BACKUP_TEST=1 node scripts/verify-host-observability.mjs
```

It uses the pinned providers, synthetic credentials, an isolated TLS SMTP receiver
on internal port 465, and a real GlitchTip worker alert for a stored issue. It
checks rejection of the receiver's initially untrusted certificate, then adds its
test CA **only to the disposable containers**, and repeats delivery after enable,
database restore and disable/re-enable. No receiver port is published. A passing
receiver acceptance proves authenticated SMTP acceptance; it does **not** prove
external inbox receipt, spam placement, SPF/DKIM/DMARC alignment or live delivery.
Jem owns operator deployment and live acceptance, including sender verification,
a real notification, provider acceptance and separately confirmed inbox receipt.

## Connect Capsules

The services Host and Capsule Host may use different infrastructure providers.
Umami collection is also usable from Dev/Container deployments or other hosting
environments through the explicit Server env configuration in
[Errors and analytics](./errors-and-analytics.md#umami-pageviews). Installing a
cloud Host is not required to configure the runtime collection tunnel. Deployment
policy may require analytics for every production SaaS Capsule while Sporades'
runtime remains opt-in.

Declare `observability.errors` and/or `analytics.provider: "umami"` in
`sporades.json`, using the env names shown in the runtime guide. Then register:

```sh
# Services and Capsule on the same Host:
sporades host register tickets --host personal --json

# Capsule on personal, services on a dedicated ops Host:
sporades host register tickets --host personal --on ops --json

# Already registered Capsule (run from its local project):
sporades host services connect tickets --host personal --on ops --json
sporades host push --host personal --subname tickets --restart --verify --json
```

Registration automatically wires declared integrations when the selected service
Host is enabled. `connect` verifies the target registration. Neither command
adds runtime config or restarts a running Capsule. They create the GlitchTip
project and Umami website through the service APIs, seal the resulting values
locally, and let the normal Host push encrypt them for the Capsule. Custom env
names are honored; names must be distinct and must not be reserved. No provider
values are printed. Import nonempty legacy Server env explicitly before
connecting. Registration reports that import is needed without changing it.
If any declared provider env value is already populated, registration skips
automatic provisioning without contacting the service Host and leaves the sealed
env unchanged. External providers therefore remain usable during a managed-service
outage. Explicit connect requires removing conflicting sealed keys first.

Provider identity is deterministic from the exact Capsule subname and Hosted
domain, so retrying after an API success or local sealing failure reuses the same
project/site. GlitchTip project names are `capsule-<32 hex digest>` because this
pinned version derives slugs from names. Identical subnames on different Hosted
domains have separate identities. Custom domain aliases do not create new sites.
Disable/unregister does not delete collected history. A public DSN grants event
ingestion only; provisioning credentials stay on the ops Host.

## Backup and restore

Initialize restic and configure the existing [Host backup policy](./capsule-backups.md)
on the **services Host**, even if Capsules run elsewhere. Its scheduled timer
also snapshots enabled observability services and applies the same retention.
The two independent databases each use a transaction-consistent `pg_dump`; no
Capsule outage is needed. They do not share one application transaction.

```sh
sporades host services backup observability --on ops --json
sporades host services backups observability --on ops --json
sporades host services disable observability --on ops --json
sporades host services restore observability --on ops \
  --id <full-snapshot-id> --confirm observability --json
sporades host services enable observability --on ops --json
```

Snapshots have a separate `_observability` namespace, checksums and a protected
manifest with the credentials needed for database recovery. Restore accepts only
this Hosted domain's snapshots with the retained credentials, verifies both
dumps before mutation and leaves collectors disabled. An interrupted import
retains a journal; retry the same snapshot. Enable stays fenced until both
imports finish. This is a same-Host database restore, not full Host disaster
recovery. Preserve the protected service directory and named volumes separately
for full Host recovery; uploaded source maps/files in GlitchTip's uploads volume
are outside these database snapshots. Never prune a repository after an
incomplete snapshot. Backups while services are disabled are an explicit manual
operation after starting their databases; the scheduled timer skips them.

## Monitoring and removal

Enable installs `sporades-observe-<identity>.timer`, checking both private
listeners every minute with the protected helper. With Host resource telemetry
connected, the existing node_exporter textfile path exports
`sporades_observability_up`, `sporades_observability_enabled` and
`sporades_observability_checked_seconds`. `SporadesObservabilityUnavailable`
alerts on failed or stale checks, linking to both service dashboards and
Alertmanager. Database backup age uses the existing stale-backup alert with
`capsule_subname="_observability"`. Reconcile/upgrade the monitoring stack to
load the new release-owned rule; installing services alone does not connect a
Host to a Monitoring server.

```sh
sporades host services disable observability --on ops --json
sporades host services uninstall observability --on ops --json
```

Disable stops containers and the health timer, serving a deliberate 503.
Uninstall also removes this stack's containers and network. Both retain secrets,
named volumes, hostname reservations and Capsule sealed env; collection is best
effort while offline. Enable recreates the stack with the same identities.
No purge is implicit. To permanently erase data, an administrator must separately
review and remove the exact retained Compose project volumes, protected service
state, route file and backup snapshots. Do not use a blanket Docker prune.

## Verification

After `npm run build`, run `node --test test/host-observability.test.js` for the
local contracts. Run `node scripts/verify-host-observability.mjs` against a
**local disposable Docker engine** for real pinned-provider coverage, or set
`SPORADES_REAL_OBSERVABILITY_DOCKER=1` for the test runner. Set
`SPORADES_OBSERVABILITY_BACKUP_TEST=1` with restic installed to include real
database backup/restore. The harness creates unique projects and removes only
its own containers/volumes. It exercises interrupted enable recovery, repeated
enable, per-Capsule API identities and encrypted env. A generated synthetic
Capsule writes and throws through its actual HTTP endpoint; the harness verifies
the exact marked event in the provisioned GlitchTip project, including endpoint
surface, Capsule, release and environment. Browser `error` and
`unhandledrejection` hooks run through the generated loader and same-origin
tunnel, with synthetic credential/query/fragment redaction checked in stored
events. Direct capture remains separate lower-level transport coverage.

The harness also checks opaque client errors, transaction rollback, successful
commits and continued runtime health while the provider is running, stopped,
and with no integration configured. Fault endpoints exist only in temporary
test Bundles. Event polling is bounded and database totals alone cannot satisfy
runtime capture acceptance. It exercises pageview storage, disable/re-enable
and uninstall. It uses loopback collection URLs and
a route callback; public DNS/TLS and systemd reboot behavior require the final
disposable Linux Host rehearsal.

Keep `SPORADES_CONFIG_DIR` inside the checkout. The harness pins the local Docker
socket and a unique Compose project, never a saved remote Docker context. Its
scratch path must have protected ancestors, as required by the production
secret-path checks; on shared checkouts, run it in a disposable local runner
with the checkout mounted under protected parents. No live Host, SSH, provider
credentials or production fault routes are needed.

For that rehearsal: enable twice, register/push an opted-in Capsule, trigger a
query failure and browser pageview, confirm them in both dashboards, confirm
no credentials in CLI status or page source, snapshot/disable/restore/enable,
and reboot. Verify TLS, retained data and fresh monitoring samples. Never run
this rehearsal on a production Capsule.
