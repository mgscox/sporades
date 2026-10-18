# Files

Use the client Files SDK to upload private bytes, retrieve metadata, create or
revoke public URLs, replace versions, and delete Files. Trusted Capsule server
code can delete through `ctx.files.delete(fileReference)` without sending the
operation back through the browser.

Files are private to their owner by default. A Capsule can deliberately share
normal File reads, public-URL creation, or deletion through `files.acl`; those
rules receive the constrained ACL context, including explicit Team decisions
through `ctx.acl.teams`. Sharing never transfers File ownership: public URLs
created by an ACL-approved collaborator are still recorded to—and revocable
by—the File owner.

Server deletion uses the frozen `ctx.auth` and `ctx.credential` snapshot
admitted when the handler context is created; replacing either context property
cannot change the actor. That actor must own the File or pass a declared
`files.acl.delete` rule. The operation resolves to deleted File metadata directly
and fails opaquely when the reference is missing or unauthorized. Metadata
deletion and public-URL revocation are transactional;
stored bytes are removed after commit on a best-effort basis. Use
`privilegedCtx.files.delete(fileReference)` only inside an explicitly audited
`ctx.privileged.run(...)` when trusted userless work must bypass current-user
ownership and File ACLs. Userless lifecycle hooks cannot synthesize Session
provenance for `ctx.files.delete`; enter the audited privileged operation when
that maintenance behavior is intentional.

The [File uploads reference](../reference/files-and-realtime.md#file-uploads)
covers the complete workflow and access rules. Storage implementation is
runtime plumbing; app code continues to use File references whether bytes live
locally or in a configured service.

For storage service configuration, see [configuration](./configuration.md).

## Upload policy

Existing apps continue to allow SDK uploads, including guest uploads. Opt in to
an upload hook to limit which actors can create or replace Files:

```ts
files: {
  acl: {
    upload: (ctx, meta) => ctx.auth.isAuthenticated && !ctx.auth.isGuest
      && meta.sizeBytes <= 2 * 1024 * 1024,
  },
}
```

The hook receives the read-only File ACL context (`auth`, `credential`, `acl`)
and `{ sizeBytes, mimeType, name }`. It runs before an upload URL is issued;
only `true` allows the upload. Exceptions deny without exposing their contents.
The PUT must match the admitted size when a hook is configured. Upload URLs
are capabilities granted by that decision; changing policy does not revoke URLs
already issued. Multipart endpoints retain their own admission hooks.

In `sporades.json`, set `files.allowedMimeTypes` to an exact lowercase MIME list,
for example `["image/png", "image/jpeg", "application/pdf"]`. Omitting it
preserves existing behavior; an empty list denies all new uploads. This policy
also narrows multipart ingress. See the [reference](../reference/files-and-realtime.md#upload-policy-and-mime-validation)
for signature checks, typed errors, and their limits.

## Orphan cleanup

`privilegedCtx.files.list()` pages through live uploaded Files across all owners.
Scheduled Jobs receive this Privileged context directly; ordinary trusted handlers
enter an audited `ctx.privileged.run(...)` first. Use a scheduled Job to inspect
old candidates and delete only those your app confirms are unreferenced.
Sporades cannot infer references stored in app tables or external systems and
never automatically deletes unreferenced Files. The [sweep pattern](../reference/files-and-realtime.md#orphaned-file-sweep)
shows pagination, reference checks, and concurrency requirements.
