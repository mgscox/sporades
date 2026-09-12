# Deployment files journal before seed publication

`deploy.files` lets a Capsule declare exact project-relative server files.
Replacement files are release-owned and read-only. Preserved files are seeded
once into persistent storage and mounted writable, so server edits must survive
redeployment, restart, and rollback. That promise cannot depend on the deploying
process living long enough to finish: a CLI or Host helper can exit between
publishing a seed and committing the binding or registry record.

Sporades therefore writes an attempt journal, `deploy-file-attempt.jsonl`,
beside `preserved-files/` before any seed is published. The journal records the
attempted release, the candidate and previous Containers, every temporary seed
path before it is created, and each published seed's inode and content hash. A
successful install or a completed rollback removes it. A surviving journal
blocks `sporades deploy`, `deploy stop`, `deploy restart`, `deploy remove`, and
Hosted start, restart, rollback, and verification fallback. Blocking is
deliberate: a later command cannot tell an uncommitted seed from an operator's
edit by looking at the file alone, and adopting it silently would let a failed
release's bytes masquerade as preserved state.

Recovery is a runtime-owned command, not a procedure. `sporades deploy
reconcile` and `sporades host reconcile` read the journal and settle exactly
what it recorded. An attempt that never committed is discarded: the untracked
candidate Container is removed by its transaction label, the previous
Container's name is restored, seeds whose inode and bytes still match the
journal are moved to `.rollback-<id>` recovery files, the candidate snapshot or
release directory and private key are removed, the Host `current` pointer
returns to the recorded release, and bound file access is repaired. A committed
attempt keeps everything and clears only the journal and its temporary files.
Edited seeds are never removed, and the command is idempotent.

Preserved storage is flat: each file is stored as the SHA-256 of its
NFC-normalized logical path so historical ancestor and descendant declarations
can coexist while their `/app` mounts keep the declared paths. Preserved copies
stay owned by the invoking user with mode 0600, exactly like `.sporades/data`:
no ownership change and no privileged helper, so the CLI never widens its own
authority. Each lifecycle action proves every active preserved file is a
regular single-link inode and tightens it back to owner-only before a runtime
starts.

The trade-off is a stricter operator contract: interrupted deployments require
one extra command before the next lifecycle action. Source reads reject symlink
substitution everywhere; Linux and macOS use no-follow descriptors, other
platforms prove the opened inode still matches a symlink-free walk. Dev
sessions are unaffected: they read project files directly and never snapshot,
validate, or mount `deploy.files`.
