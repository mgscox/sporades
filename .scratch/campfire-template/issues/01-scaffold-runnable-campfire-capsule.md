# 01 — Scaffold a runnable Campfire Capsule

**What to build:** Add `campfire` as a first-class scaffold choice that generates a deterministic, installable, buildable Capsule with a polished firelit community-room shell. The generated UI uses Tailwind CSS and source-owned Shadcn/UI conventions while remaining ordinary editable Capsule code.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `campfire` is accepted and displayed anywhere existing scaffold templates are selected, validated, or described.
- [ ] Creating Campfire through the public scaffold entry produces a complete Capsule that installs and builds without importing files from the Sporades repository checkout.
- [ ] The generated interface contains a responsive community-room shell with channel navigation, message space, composer space, and a global activity-panel space.
- [ ] The generated interface presents exactly `#general`, `#ideas`, `#random`, and `#protect-the-crown` as its initial channel navigation.
- [ ] Tailwind CSS is loaded through the documented browser-CDN path under the current fixed client-Bundle contract.
- [ ] Shadcn/UI-style components are generated as source-owned Capsule code rather than downloaded as runtime component logic.
- [ ] Required React primitives, icons, and class utilities are declared as generated Capsule dependencies and survive a fresh install.
- [ ] The visual design is warm, dark, firelit, keyboard-usable, and legible without relying on colour alone.
- [ ] React and Preact scaffold choices both generate syntactically valid, buildable Campfire output where those choices are supported by the existing scaffold contract.
- [ ] Repeated generation with identical inputs produces deterministic output.
- [ ] Existing scaffold templates and the repository's relevant broad tests remain green.
