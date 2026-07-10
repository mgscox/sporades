# 08 — Add Lit Capsules with reactive controllers

**What to build:** Capsule authors can scaffold Lit Web Component clients through Vite and consume Sporades state through a Lit-native reactive-controller interface. The design may also enable esbuild only if doing so preserves the same public interface and verification surface.

**Blocked by:** 02 — Add a framework-neutral Vanilla TypeScript client; 03 — Add the Vite client toolchain through React.

**Status:** ready-for-agent

- [ ] `sporades create` accepts Lit, selects Vite, installs the supported dependencies, and emits idiomatic Lit scaffolds for every supported template.
- [ ] Lit components, decorators where supported, CSS, and imported assets compile into the normalized public asset tree.
- [ ] Reactive controllers expose query, mutation, and auth state and connect or disconnect transport subscriptions with their host lifecycle.
- [ ] Lit Capsules run through Dev, Container, and Hosted execution with structured build diagnostics and rebuild recovery.
- [ ] Any esbuild support is either fully verified as an equivalent supported combination or explicitly rejected with structured guidance rather than partially implemented.
