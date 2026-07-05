# File operations accept File references

Sporades file operations may resolve existing files by File reference: either a stable File ID or an absolute Capsule-scoped File path. This extends the ID-first examples in ADR-0013 without changing the high-level upload model: app code still uses the `files` SDK, public/private read URLs remain Sporades-owned runtime routes, and storage backends keep their filesystem paths, object keys, Object buckets, and prefixes private behind the runtime.

ADR-0024 replaces the old user-scoped `default` bucket semantics in ADR-0013.
File ownership and privacy come from runtime File metadata and ACL behavior.
The Default File bucket is only a logical namespace fallback for omitted File
paths; it is not a user bucket, storage location, or policy boundary.

Absolute File paths give developers and agents a filesystem-like address for storage ACLs and ordinary file workflows, while File IDs remain stable metadata identities for stored references and compatibility. A File reference must resolve to exactly one live file metadata record before reads, deletes, public URL creation, or overwrites proceed.
