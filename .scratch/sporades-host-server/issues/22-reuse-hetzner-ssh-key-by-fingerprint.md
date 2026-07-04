# Reuse Hetzner SSH keys by fingerprint during provisioning

Status: done

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

The documented Hetzner provider script creates an SSH key only by checking
whether `SPORADES_SSH_KEY_NAME` exists:

```sh
hcloud ssh-key describe "$SPORADES_SSH_KEY_NAME"
```

During the Hetzner photobook smoke test, the account already contained the same
local public key under a different name. `hcloud ssh-key create` then failed
with:

```text
hcloud: SSH key not unique (uniqueness_error, ...)
```

Update the Hetzner Host provisioning path so it is safe to retry when the same
local public key already exists in the Hetzner project under another name.
Provisioning should first reuse a key with the requested name, then fall back to
matching the local public key fingerprint against existing Hetzner SSH keys, and
only create a new key when neither match exists.

## Acceptance Criteria

- [x] The Hetzner provider script first checks for a key matching
  `SPORADES_SSH_KEY_NAME`.
- [x] If no name match exists, it computes the local public key fingerprint and
  searches existing Hetzner SSH keys for the same fingerprint.
- [x] If a fingerprint match exists, server creation reuses the matched Hetzner
  SSH key instead of attempting to create a duplicate.
- [x] If no name or fingerprint match exists, provisioning creates a new key as
  it does today.
- [x] `docs/agents/host-provisioning.md` documents the duplicate-key behavior
  and remains safe to retry.

## Blocked by

None - can start immediately

## Notes

Discovered during the Hetzner photobook smoke test for
`sporades-photobook-hetzner-20260704-172547`. The workaround was to use the
existing Hetzner key name `user@ubuntu` instead of the documented default
`workstation`.
