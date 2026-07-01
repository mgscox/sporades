Status: ready-for-agent

## What to build

Implement the generated photo library Capsule end to end. The server should model photo rows tied to uploaded File metadata, ownership, visibility, and optional public file URLs. The client should provide an upload flow, a public gallery, Google sign-in/sign-out actions, and a personal library for Google-authenticated users.

## Acceptance criteria

- [ ] The generated server Capsule stores photo metadata for each uploaded image using File metadata returned by the Storage API Upload call.
- [ ] Anonymous uploads are made public immediately and appear in the public gallery.
- [ ] Google-authenticated uploads are private by default unless the uploader chooses public during upload.
- [ ] Google-authenticated users can toggle their own photos between public and private.
- [ ] The public gallery query returns only public photos and includes usable image URLs.
- [ ] The personal library query returns only the current Google-authenticated user's photos and includes a public/private status indicator.
- [ ] Anonymous users cannot see or use the personal library as an authenticated owner view.
- [ ] Generated React and Preact clients build without importing auth provider SDKs directly.

## Blocked by

- .scratch/photo-library-template-capsule/issues/01-add-photo-library-template-selection.md

## Comments
