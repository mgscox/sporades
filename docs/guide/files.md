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
