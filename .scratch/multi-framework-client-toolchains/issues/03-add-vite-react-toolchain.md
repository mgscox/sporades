# 03 — Add the Vite client toolchain through React

**What to build:** React Capsule authors can explicitly select Vite as the client toolchain while esbuild remains compatible. Vite produces the same normalized public asset contract and participates in Sporades-owned Dev, Container, and Hosted lifecycle behavior rather than introducing a separate application model.

**Blocked by:** 01 — Normalize public client assets for existing React Capsules.

**Status:** ready-for-agent

- [ ] Project configuration and `sporades create` accept a validated React/Vite combination while preserving existing React/esbuild Capsules.
- [ ] The internal client-toolchain seam selects esbuild or Vite without exposing toolchain-specific output shapes downstream.
- [ ] Vite builds React, CSS, and imported assets into the normalized public asset tree with deterministic entry resolution and source maps.
- [ ] Dev sessions report structured Vite build success and failure events, recover after a corrected edit, and refresh the browser without colliding with Sporades WebSocket routes or Public Dev security.
- [ ] React/Vite Capsules run through Dev, Container, and Hosted execution and preserve no-Server-env-leakage and release-parity checks.
