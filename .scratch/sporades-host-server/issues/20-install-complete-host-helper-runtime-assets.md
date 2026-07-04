# Install complete Host helper runtime assets during provisioning

Status: done

## Problem

`docs/agents/host-provisioning.md` and `docs/server-installation.md` currently describe copying only `bin/sporades-host-helper.js` to the Host server. The helper now imports shared source modules and Hosted base-image fallback also requires `Dockerfile.base` on the Host.

A fresh Host installation must not rely on manual follow-up `scp` commands for helper dependencies or base-image build inputs.

## Acceptance Criteria

- [x] Host provisioning instructions copy every runtime asset required by `bin/sporades-host-helper.js`.
- [x] Shared source modules required by the helper are installed under `<remote-root>/src/`.
- [x] `Dockerfile.base` is installed under `<remote-root>/Dockerfile.base` for Host-side base-image fallback builds.
- [x] The installation script remains safe to rerun.
- [x] Host provisioning docs and manual server installation docs agree on the helper asset layout.

## Notes

Discovered during live disposable Capsule verification. Copying only the helper was insufficient after the helper began importing shared modules.
