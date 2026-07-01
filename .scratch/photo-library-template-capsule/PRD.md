# Photo Library Template Capsule

## Overview

Add a `photo-library` scaffold template that demonstrates Sporades auth and Storage API behavior through a small photo sharing Capsule.

## User stories

- Anonymous visitors can upload image files and those uploads are public.
- Google-authenticated users can upload image files that are private by default.
- Google-authenticated users can mark their own uploaded photos public or private after upload.
- Everyone can view a gallery page containing all public photos.
- Google-authenticated users can view a personal page containing all of their uploaded photos with a public/private status indicator.

## Product decisions

- Use React or Preact; React is acceptable as the default scaffold path.
- Use Tailwind CSS and ShadCN only where they fit the existing scaffold conventions.
- Store bytes through the Sporades Storage API Upload call. Domain rows should store returned File metadata identifiers and any public URL records needed for gallery display.
- Anonymous uploads become public immediately.
- Google-linked uploads start private unless the user explicitly chooses public during upload.
- Personal library access is only visible and useful to Google-authenticated sessions.

## Verification

- `sporades create --template photo-library` writes a runnable Capsule.
- A disposable Hosted Capsule on `168.119.161.21` can be opened in an HTTP browser.
- Browser verification covers anonymous public upload, Google simulated linked identity upload defaulting private, visibility toggle, public gallery filtering, and authenticated personal library status display.
