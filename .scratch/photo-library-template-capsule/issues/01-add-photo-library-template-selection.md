Status: ready-for-agent

## What to build

Make `photo-library` a supported scaffold template in `sporades create`, including structured JSON output, validation messaging, generated Capsule config, README, agent instructions, and framework-aware dependencies.

## Acceptance criteria

- [ ] `sporades create <name> --template photo-library --no-install --no-git --json` succeeds and reports `template: "photo-library"`.
- [ ] Unsupported template errors mention `photo-library` alongside the existing supported templates.
- [ ] The generated `sporades.json`, README, and agent instruction files identify the `photo-library` template.
- [ ] React and Preact framework selections continue to generate framework-appropriate dependencies and client imports.
- [ ] Existing blank, todo, and guestbook create tests keep passing.

## Blocked by

None - can start immediately

## Comments
