# Reuse Hetzner SSH keys by fingerprint during provisioning

Status: needs-triage

## Problem

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

Provisioning only continued after manually discovering the existing key name
and setting `SPORADES_SSH_KEY_NAME` to that value. That is a provider-script
workaround; the provisioning path should reuse an existing matching key by
fingerprint, like the DigitalOcean script already does.

## Acceptance Criteria

- [ ] The Hetzner provider script first checks for a key matching
  `SPORADES_SSH_KEY_NAME`.
- [ ] If no name match exists, it computes the local public key fingerprint and
  searches existing Hetzner SSH keys for the same fingerprint.
- [ ] If a fingerprint match exists, server creation reuses the matched Hetzner
  SSH key instead of attempting to create a duplicate.
- [ ] If no name or fingerprint match exists, provisioning creates a new key as
  it does today.
- [ ] `docs/agents/host-provisioning.md` documents the duplicate-key behavior
  and remains safe to retry.

## Notes

Discovered during the Hetzner photobook smoke test for
`sporades-photobook-hetzner-20260704-172547`. The workaround was to use the
existing Hetzner key name `user@ubuntu` instead of the documented default
`workstation`.
