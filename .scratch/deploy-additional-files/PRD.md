# Additional deployment files

Agreed user contract:

- Optional `deploy.files` in `sporades.json` lists exact project-relative file paths.
- Node path resolution must keep normalized paths under the app root and outside Sporades-managed files and directories.
- Each file appears at the same relative path under `/app` in the container.
- `update` defaults to `replace`. Replacement files belong to the release.
- `preserve` seeds absent persistent files and retains server edits across deployments, restarts, and rollbacks.
- Removing a preserve entry stops mounting it but retains stored bytes. Switching to replace leaves the preserved copy inactive; returning to preserve reuses it.
- Missing declared source files fail the local build before upload or server changes, even for preserve entries.
- Reject symlinks, including parent directories, and conflicting entries.
- Application code owns file reading and reloading; Sporades adds no reload behavior.
- Support the shared build and both local Container and Hosted Capsule deployment paths. Dev uses project files directly.

Validation: local build failures and snapshot bytes, archive admission and packaging, preserved edits across successive releases and restart/rollback, reserved paths and symlinks, generated CLI parity, typecheck and regression suite.
