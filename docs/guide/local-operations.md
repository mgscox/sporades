# Local Operations

Use Dev sessions for iteration and local Container sessions for production-like verification.

Inspect an active session with `sporades logs`, `sporades db`, `sporades jobs`,
and `sporades schedules`. Use `sporades doctor` for read-only coordinated diagnostics.

```sh
sporades logs
sporades db list
sporades db dump --json
sporades doctor --session dev --json
```

Run `sporades deploy` only after the Dev loop is healthy. Reset commands delete
owned runtime or service state deliberately; inspection commands should come first.

Continue with [inspection and debugging](./reference.md#inspecting-and-debugging), [local Container sessions](./reference.md#local-container-sessions), [Container SSH](./reference.md#container-ssh-access), and [Sporades Doctor](./reference.md#sporades-doctor).
