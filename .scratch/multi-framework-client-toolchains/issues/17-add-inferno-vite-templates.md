# 17 — Add Inferno/Vite and complete template parity

**What to build:** Inferno authors can choose either supported toolchain and every Sporades template while retaining Inferno-native runtime, lifecycle, and release behavior.

**Blocked by:** 06 — Admit React through Vite; 16 — Admit Inferno through esbuild.

**Status:** ready-for-agent

- [ ] Configuration and scaffolding accept Inferno/Vite and use an Inferno-specific Vite transform without importing React behavior.
- [ ] Inferno/Vite blank and todo scaffolds produce normalized public output and equivalent SDK behavior to Inferno/esbuild.
- [ ] Guestbook, Photo Library, and Campfire scaffolds are available for Inferno with admitted dependencies and work through both supported toolchains.
- [ ] Generated HTML, styles, imported assets, TypeScript settings, README, and agent instructions describe Inferno rather than React compatibility.
- [ ] Both toolchains produce structured rebuild recovery and full-page refresh behavior without promising unverified state-preserving HMR.
- [ ] Focused tests prove native lifecycle cleanup and each template's defining public behavior; shared fixtures cross Dev, Container, and Hosted release seams for both toolchains.
