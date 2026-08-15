# 01 — Normalize and structurally key query channels

**What to build:** Refactor the existing argument-free reactive query channel so every client query entry crosses one pure normalization seam and every channel is located structurally by query name and canonical argument identity. Preserve all current public and wire behavior while establishing immutable, bounded, prototype-safe snapshots that later argument-bearing subscriptions can use without duplicating lifecycle logic.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Existing name-only framework-neutral subscriptions and every existing framework adapter remain source- and runtime-compatible.
- [ ] One pure normalizer accepts a JSON-value argument array and returns an immutable deep snapshot, canonical identity, and UTF-8 JSON byte length.
- [ ] Canonical identity preserves array order while ignoring object-key insertion order recursively.
- [ ] The snapshot retains no caller-owned array or object references, so later caller mutation cannot change its identity or contents.
- [ ] Functions, undefined values, symbols, bigint values, non-finite numbers, cyclic values, dates, and custom class instances are rejected rather than silently transformed.
- [ ] Canonical objects use prototype-safe property creation and preserve `__proto__`, `constructor`, and `prototype` as ordinary own JSON properties without prototype mutation or inherited pollution.
- [ ] The normalizer accepts an encoded snapshot of exactly 65,536 UTF-8 bytes and rejects 65,537 bytes, including multibyte boundary coverage.
- [ ] Query channels use a nested lookup from query name to canonical argument identity rather than a delimiter-built composite string.
- [ ] Query names containing brackets, quotes, commas, pipes, and argument-like JSON text cannot collide with any other name and argument identity.
- [ ] Public framework-neutral subscription normalizes once before entering the internal normalized-subscription seam, and a newly created channel stores that supplied result without normalizing again.
- [ ] Existing same-name subscribers still share one wire subscription, last-listener teardown remains idempotent, and reconnect behavior remains unchanged.
- [ ] Existing client-runtime and adapter suites remain green after the prefactor.
