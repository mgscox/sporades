# Wait for cloud-init and apt locks during fresh Host provisioning

Status: done

## Problem

Fresh Ubuntu cloud servers may still be running cloud-init package work when the
Sporades Host installation step starts. The current provisioning script can hit:

```text
E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process ...
E: Unable to acquire the dpkg frontend lock
```

This is not a Host runtime failure; it is a provisioning race with first-boot
package initialization.

## Acceptance criteria

- [x] The shared Host provisioning script waits for cloud-init to finish when
  `cloud-init` is available.
- [x] The script waits for apt/dpkg frontend locks to clear before running
  `apt-get update` or `apt-get install`.
- [x] The wait is bounded or emits progress so agents can diagnose a genuinely
  stuck server.
- [x] The behavior is documented in `docs/agents/host-provisioning.md` and
  `docs/server-installation.md`.
- [x] Retrying provisioning on a fresh DigitalOcean Ubuntu droplet does not fail
  solely because cloud-init still owns the apt lock.
