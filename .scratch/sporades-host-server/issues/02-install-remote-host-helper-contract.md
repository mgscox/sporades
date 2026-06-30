# Install the remote Host helper contract

Status: ready-for-agent

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Add the local-to-Host-server command contract used by hosted Capsule operations. The local CLI should invoke a remote helper over SSH, send requests as JSON, receive standard Sporades JSON responses, and report SSH failures distinctly from remote helper failures. This slice should establish the contract with fake SSH tests before deeper Host server behavior exists.

## Acceptance criteria

- [ ] The CLI can invoke a configured remote helper over SSH using a Host profile.
- [ ] Remote helper requests are sent as JSON rather than assembled from user-controlled shell fragments.
- [ ] Remote helper responses use the standard `{ ok, data, error }` Sporades JSON envelope.
- [ ] SSH transport failures are reported differently from remote helper command failures.
- [ ] User-controlled Hosted domain and Capsule subname values are treated as data in the remote helper contract.
- [ ] Tests use fake SSH/remote helper executables to assert request shape, response handling, and failure handling.

## Blocked by

- .scratch/sporades-host-server/issues/01-add-host-profiles-and-remote-binding.md
