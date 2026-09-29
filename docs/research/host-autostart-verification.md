# Hosted Capsule autostart verification

Verified 2026-09-29. The fix is part of the Sporades Host helper/bootstrap and
shared manual/automatic installation contract, not a VPS-specific script.
Docker keeps `on-failure:3` for crashes. A systemd oneshot service performs boot
recovery through normal authenticated startup and Caddy route locking.

## Regression coverage

The helper recovery test failed before implementation and passed afterward.
Focused public-helper tests cover stopped, failed, unregistered, never-started,
already-running and foreign-container cases; exhausted crash retries remain
unavailable. Successful recovery uses authenticated readiness and retains the
bounded Docker policy. The installed helper dispatcher also forwards boot
arguments without replacing them with checksum output.

The opt-in `test/host-autostart.acceptance.test.js` invokes
`scripts/verify-host-autostart.mjs`. Set `SPORADES_HOST_AUTOSTART_TEST_ROOT` to a
prepared disposable harness containing `ssh_config` (alias `sporadesautostart`).
The VM must be named `sporades-autostart-test`; it must already have been
bootstrapped through the installed CLI at `/srv/sporades`, domain
`autostart.example`, with four real Capsules: `awake` running, `asleep` explicitly
stopped, `doomed` exhausted after three Docker retries, and `newborn` uploaded
without ever starting. The script asserts that exact VM hostname before reboot.
It writes `reboot-evidence.json` in the harness directory. Never point it at Live.

## Disposable Linux Host

- Ubuntu 24.04, Docker 29.1.3, Caddy 2.6.2, Node 22.23.3.
- Real installed Sporades 0.9.30 package built from this change; real generated
  Capsule, actual helper upgrade and shared bootstrap; no telemetry setup was
  needed to obtain autostart.
- Fresh bootstrap installed/enabled `sporades-capsules-209775c142f0f635.service`.
  Repeated bootstrap and helper upgrade worked.
- Actual VM reboot changed the kernel boot ID. `awake` returned HTTP 200 without
  a workstation start command. `asleep` and `newborn` had no running container.
- Four fatal terminations inside the disposable runtime's lifecycle exhausted
  its three Docker restart attempts. `doomed` remained exited with retry count 3
  after reboot; recovery marked it unavailable rather than resetting the budget.
- Repeating the service preserved `awake`'s exact start time. A separate Docker
  service restart also recovered HTTP 200 while the other Capsules stayed down.
- The first real upgraded-helper boot exposed the dispatcher's argument-clobber
  bug. It was corrected and the packaged reboot acceptance then passed.

## Live retrofit

The same installed package upgraded Live through `sporades host upgrade`, then
`sporades host bootstrap` installed/enabled
`sporades-capsules-a60877894168b0ea.service`. A recovery snapshot was retained at
`/root/telemetry-rollout-backup/capsule-autostart-20260929`. No Live reboot or crash
drill was performed. The service was started once to verify it skips the two
already-running production Capsules. See the PR validation record for final
check results and deployed helper checksum.

No npm/global CLI release is implied; this change ships in repository source,
generated CLI/helper artifacts and installation documentation. Existing Hosts
need the updated CLI/helper plus bootstrap to install the service.

Live's installed service reports `enabled`, `active (exited)` and `Result=success`.
Its first pass returned `already-running` for both CIC and Tickets, preserving
container start times `2026-09-28T16:58:20.367351009Z` and
`2026-09-28T17:00:18.308002791Z`. Both public app routes returned HTTP 200;
telemetry `/health` returned `{ok:true}` and monitoring `.env` was byte-identical.
Deployed/source helper SHA-256:
`0107fd8fb138b4ae8fa62eedbfaec4b2f162946b0ba35f76ae1cfd6d50de1cba`.
