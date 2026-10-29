# Disposable hosted route recovery acceptance (#318)

The complete hosted matrix passed on 2026-10-29 for follow-up source
`2206b68143dd7ecb8876b0181f25aa1d14c314b9`. The originally merged #317 source
`08ff36b89ed9053c99235f612fd1d901dd91d669` **failed automatic recovery**. The narrow
follow-up fix is required; these results do not establish that an existing Host
or the published 0.9.41 package contains it.

[Detailed redacted evidence](./host-route-recovery-318.json) contains every UTC
start/end time, container/release identity, old/new Docker mapping, Caddy upstream,
protocol result, fault diagnostic, fixture check and cleanup result. No rows were
waived. [Original verification record](./host-route-recovery-verification.md).

## Finding and correction

The route worker supplies a one-second readiness budget. After its first Docker
inspection, `performance.now()` leaves a fractional number of milliseconds.
Passing that value through the emitted probe to `AbortSignal.timeout()` throws
before HTTP contact. The probe catches it as a connection failure, so repeated
timer runs never repair the stale route, even while the runtime is ready.

On the real VM, the unchanged emitted probe returned `kind: connection` with
argument `900.5`, but a valid, ready HTTP 200 response with argument `1000`.
Read-only Docker-exec timings were 0.361–0.393 seconds without the test wrapper
and 0.428–0.495 seconds with it, ruling out the wrapper as the observed failure.
The original candidate stayed on HTTPS 502 for each 90-second automatic-recovery
observation, despite protected runtime readiness.

The follow-up rounds the remaining probe budget down to an integer, retaining
the existing bounds. The regression executes the actual emitted Docker-exec
script against a real authenticated HTTP runtime through the timer entry point;
it fails on the merged source and passes with the fix. Earlier fake Docker
responses bypassed that script and missed this failure.

## Installed candidate and isolation

- Provider: DigitalOcean, fresh Droplet `614023637`,
  `sporades-issue-318-20261029`, `lon1`, `s-2vcpu-4gb`, Ubuntu 24.04.
- Empty initial Docker container inventory. All Capsules, files, data and backup
  snapshots were synthetic and created for this run. `awake` was the target,
  `sibling` retained a sentinel-data checksum and working route, and `asleep`
  remained intentionally stopped with no container.
- Installed helper SHA-256: `ef79656e8070e4a6ff87faf293157b48c98c8eeca704e3adfbc060b04052c24e`.
- Unfixed base: `02920387d85e882af633c627139c597339d26fe9`; helper SHA-256
  `693ccdd7af609844dd97507f446de2a13ecea6086d96f3453339d3e569cec85c`. Initial merged helper SHA-256:
  `2c83088d42141f9b02903446c57a172f75f17abc5616cadd44f11677e9ef6469`.
- Local build: Node 24.19.0; Host Node v24.22.2; Docker version 29.1.3, build 29.1.3-0ubuntu3~24.04.2;
  Caddy 2.6.2; restic 0.16.4 compiled with go1.22.2 on linux/amd64.
- The GHCR Base image pull was denied. The VM built the repository's
  `Dockerfile.base`, including its pinned Node 24.22.1 Alpine digest, and used
  image `sha256:60c9c56661a58aed769afd9c49fa41b4e2b5fbb3e22813f47d601c6491c74503`. This is a source-built Base image, not registry
  delivery validation.
- Package version remained 0.9.41. No package was published. The freshly built
  helper was copied to this disposable Host; the follow-up was staged then
  atomically renamed into place. Its unchanged bootstrap-installed systemd units
  used that helper. No experimental helper was installed on a pre-existing Host.
- Temporary sslip.io names provided DNS and Caddy obtained valid public HTTPS
  certificates. No DNS-provider records, external backup services, production
  data, mail, billing or provider callbacks were used.
- Hetzner refused creation at its Primary IP limit, including an IPv4-only retry.
  No Hetzner VM or issue-owned Primary IP resulted; its test SSH key was removed.

## Matrix results

Every successful recovery was checked through certificate-verified HTTPS root
200, marked connection-token request 200, actual WebSocket upgrade 101, and
`query.subscribe` → `query.result` for the read-only `probe` query. No connection
or protected-probe token is included in the evidence. The sibling received the
same protocol checks, retained its sentinel checksum, and the stopped fixture's
registry/container state was checked after every row, including reboot.

| Scenario | Result | Target Docker port change |
| --- | --- | --- |
| Initial candidate baseline | Pass | See JSON snapshots |
| Unfixed reproduction with forced dynamic port change | Pass | 32768 → 32770 |
| Candidate restart | Pass | 32771 → 32772 |
| Candidate start | Pass | 32772 → 32773 |
| Deployment replacement | Pass | 32773 → 32774 |
| Deployment rollback | Pass | 32774 → 32775 |
| Successful backup capture/resume | Pass | 32775 → 32776 |
| Failed capture with resume | Pass | 32776 → 32777 |
| Interrupted-backup recovery | Pass | 32777 → 32779 |
| Resume/route failure followed by recovery | Pass | 32779 → 32781 |
| Out-of-band Docker restart | Pass | 32781 → 32782 |
| Worker restart and missed changes | Pass | 32782 → 32783 |
| Disposable VM reboot | Pass | 32783 → 32768 |
| Sibling and intentionally stopped fixture isolation | Pass | See JSON snapshots |
| Cleanup | Pass | VM, local storage, test cloud keys and tag removed |

The unfixed base backup returned success while Docker changed from
`127.0.0.1:32768` to `127.0.0.1:32770`, Caddy retained
port `32768`, and public HTTPS returned **502**. A
candidate restart restored all protocols. This is an expected regression proof.

The revised worker converged **8.777 seconds**
after runtime readiness for out-of-band Docker stop/start, and
**9.501 seconds** after readiness for a mapping
change missed while its worker was stopped. Both meet the 30-second bound; the
second includes six seconds of deliberate worker outage. No `host health`,
manual route reconciliation or operator workaround was used in either timed
row or in reboot recovery. Genuine WebSocket reconnect/query exchange succeeded
after each recovery. These are recovery checks, not zero-downtime claims.

The failure rows deliberately reject a synthetic file symlink during capture,
kill the helper immediately after a real Docker stop, and reject Caddy reloads
during resume. They verify the primary error, exact-instance journal retention,
snapshot/resume distinction and recovery on retry. Real restic upload
observations show the journal still present while the resumed runtime and route
are settled; it is absent after successful completion.

## Commands and injected faults

Local preparation used `npm ci --no-audit --no-fund`, `npm run build`,
`npm run typecheck`, and the focused command in the original verification record
(now 46 tests). The regression-only command was:

```sh
node --test --test-name-pattern='automatic route recovery executes its real readiness probe' test/host.test.js
```

Provisioning used the repository's shared Host contract and CLI fallback:

```sh
doctl compute droplet create sporades-issue-318-20261029 \
  --region lon1 --size s-2vcpu-4gb --image ubuntu-24-04-x64 \
  --ssh-keys '<test-key-id>' --tag-name sporades-issue-318 \
  --user-data-file '<test-cloud-init.yaml>' --wait -o json
```

The Host installed Docker, Caddy, fail2ban, Node and restic, then received the
built helper and `Dockerfile.base`. JSON requests went to the actual helper on
stdin: `host.bootstrap`, `capsule.register`, `capsule.release.install`,
`capsule.stop`, `capsule.start`, `capsule.restart`, `capsule.release.rollback`,
`host.backup.configure`, and `capsule.backup.create`. The JSON artifact records
the release/container identities and operation/fault for each row.

Test-owned wrappers delegated to `/usr/bin/docker`, `/usr/bin/caddy` and
`/usr/bin/restic`. After an actual target Docker stop, a socket with
`SO_REUSEADDR` reserved only its old loopback port, accepting then closing
connections; Docker had to allocate a different port on resume. This forced
real mapping changes and exposed stale upstreams as 502. An early reservation
harness error was corrected; exploratory attempts are superseded by the final
matrix, not counted as product passes.

Automatic/missed-change tests used real `docker stop <exact-id>` followed by
`docker start <exact-id>`. The latter stopped then started
`sporades-routes-0bae309d483bb212.timer` around the missed mapping change.
Independent protected loopback HTTP polling recorded readiness and public HTTPS
polling recorded convergence, without calling a repairing CLI command.
Reboot used `systemctl reboot`, verified a changed boot ID and installed unit
activation, then repeated protocols and fixture checks.

## Cleanup and rollout boundary

At `2026-10-29T23:08:53.056881+00:00`, DigitalOcean GET for Droplet `614023637`
returned 404, the account's Droplet inventory was again empty, its temporary SSH
key `60477888` and test tag were absent, and the local temporary private key was
deleted. VM-local containers, volumes, images and restic data were destroyed
with the VM. The pre-existing default-lon1 VPC dates to 2019 and was left intact.
The pre-existing Hetzner server inventory was identical after cleanup. No
production Host/container/service or TallyTray workaround was contacted.

The helper fix must still be merged and delivered through the normal package
and Host upgrade flow. This acceptance run does not perform that rollout.

## Local validation limits

Build, typecheck, all 46 focused recovery tests, all 56 documentation tests and
the VitePress build passed. The new real-probe regression failed before the fix
and passed afterward.

The broad `npm test` run was stopped after repeated failures in existing Dev/Vite,
loader and scaffold paths. At interruption Node reported 4,322 tests: 4,025
passed, 44 failed, 166 cancelled and 87 skipped. The cancellations include test
files not reached by the serial run. **This is not a whole-suite pass.**

Two representative failures were rerun against rebuilt, unchanged base
`02920387d85e882af633c627139c597339d26fe9`: raw HTTP liveness failed its existing
`true !== false` event assertion, and React Vite rebuilds timed out waiting for a
WebSocket message. Only these two failures were independently reproduced on the
base; the other broad-run failures are not individually classified. The focused
Host checks and hosted matrix above completed independently.
