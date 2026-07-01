Status: ready-for-agent

## What to build

Add automated or documented smoke coverage that creates a disposable `photo-library` Capsule, runs it through a real Dev session or Hosted Capsule path, and verifies the required upload, visibility, gallery, and personal library flows through HTTP/browser behavior.

## Acceptance criteria

- [ ] A fresh `photo-library` scaffold can install dependencies and start successfully.
- [ ] Browser-level verification uploads an anonymous image and confirms it appears in the public gallery.
- [ ] Browser-level verification simulates or links a Google-authenticated user, uploads an image, and confirms it is private by default.
- [ ] Browser-level verification toggles the authenticated user's image public and private and observes the gallery changing accordingly.
- [ ] Browser-level verification confirms the personal page is available only to the Google-authenticated user and shows owned photos with public/private status.
- [ ] The verification path is suitable for a disposable Hosted Capsule on Host server `168.119.161.21`.

## Blocked by

- .scratch/photo-library-template-capsule/issues/02-implement-photo-library-capsule-behavior.md

## Comments
