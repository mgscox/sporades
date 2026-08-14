# Files

Use the client Files SDK to upload private bytes, retrieve metadata, create or
revoke public URLs, replace versions, and delete Files.

Files are private to their owner by default. A Capsule can deliberately share
normal File reads, public-URL creation, or deletion through `files.acl`; those
rules receive the constrained ACL context, including explicit Team decisions
through `ctx.acl.teams`. Sharing never transfers File ownership: public URLs
created by an ACL-approved collaborator are still recorded to—and revocable
by—the File owner.

The [File uploads reference](../reference/files-and-realtime.md#file-uploads)
covers the complete workflow and access rules. Storage implementation is
runtime plumbing; app code continues to use File references whether bytes live
locally or in a configured service.

For storage service configuration, see [configuration](./configuration.md).
