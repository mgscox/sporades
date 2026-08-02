# Security Review: Sporades CLI and Host Server Helper

**Date:** 2026-08-01
**Scope:** `src/cli/sporades.ts` (CLI), `src/cli/sporades-host-helper.ts` (Host server helper), and the supporting modules they depend on: `host-helper-validation.ts`, `host-helper-archive.ts`, `host-helper-config.ts`, `sealed-server-env.ts`, `project-config.ts`.
**Method:** Manual source review of the release-push, registry, container-lifecycle, sealed-env, SSH-accesss, logging, and bootstrap paths. Static review only; no dynamic exploitation performed.

## Executive summary

The overall security posture is strong. The codebase demonstrably understands its threat model: DNS-label validation for Capsule subnames, strict Hosted domain/remote-root regexes, canonical-path claims for uploaded archives with ownership and link-count checks, size bounds on every archive dimension, symlink rejection across release trees, SHA-256 re-verification to close TOCTOU windows, TLS of the archive claim directory (`0700`), atomic registry writes under a lock, and a properly hardened Docker runtime contract (`--read-only`, `tmpfs noexec`, `--cap-drop ALL`, `no-new-privileges`, loopback-only port publishing, log rotation). Caddy route changes are validated with `caddy validate` and rolled back on failure.

The findings below are defense-in-depth gaps rather than headline exploits: most require either direct Host-helper invocation over SSH (i.e. an actor who already has shell access) or a misbehaving/malicious CLI. They are still worth fixing because the Host helper is documented as a standalone server-side component and may outlive the trust assumptions of "only our CLI ever calls it."

## Findings

### 1. MEDIUM — Host helper does not re-validate identifiers server-side

All attack-surface validation (`validateCapsuleSubname`, `validateHostedDomain`, `validateHostRemoteRoot`, `validateHostAlias`) lives **only in the CLI** ([sporades.ts:5407-5484](../src/cli/sporades.ts)). The helper's validators in [host-helper-validation.ts](../src/cli/host-helper-validation.ts) check merely that `host.domain`, `capsule.subname`, `host.remoteRoot` are non-empty strings.

These values are then interpolated into:
- filesystem paths (`registryPath`, `defaultCapsuleHttpLogPath`, capsule data/release directories, deletion targets under `deleteCapsule`),
- Caddy route files (`renderRoute` interpolates `route.hostname` directly into the Caddyfile, and `tls.certificate`/`tls.key` paths into `renderRouteTlsLine`).

A request like `capsule.subname = "../../etc"` would traverse path joins (partially mitigated where `path.resolve` canonical comparisons exist, but not on every path), and a `host.domain` containing a newline would inject arbitrary Caddyfile directives during `host bootstrap` — a classic config-injection primitive on the edge proxy.

**Recommendation:** mirror the CLI's regexes inside `host-helper-validation.ts` and apply them in every `validate*Request`, plus reject `\r`, `\n`, `\{`, `\}` in any string interpolated into Caddy content. Cheap to do, closes the entire class.

### 2. MEDIUM — Sealed Server env uses RSA PKCS#1 v1.5 padding

[sealed-server-env.ts:115](../src/sealed-server-env.ts) calls `publicEncrypt(publicKey, dataKey)` and [:136](../src/sealed-server-env.ts) calls `privateDecrypt(...)` without a `padding` option. Node's default is `RSA_PKCS1_PADDING` (PKCS#1 v1.5), which is vulnerable to Bleichenbacher-style padding-oracle attacks whenever the decrypt side reveals valid/invalid outcomes.

The current attack surface is modest (decryption happens locally and inside the Capsule, and the envelope format is hybrid RSA + AES-256-GCM), but any future path that repeatedly unseals attacker-influenced envelopes — e.g. host-side key rotation tooling or error-distinguishing logs — would turn this into a practical oracle.

**Recommendation:** pass `{ padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }` on both encrypt and decrypt, and version the envelope (`version: 1` → `2`) so old v1.5 envelopes can be migrated and then refused.

### 3. MEDIUM — Test hooks shipped in the production helper artifact

The deployed helper honours several environment-variable escape hatches:

- `SPORADES_TEST_HOST_ARCHIVE_SWAP_PATH` ([sporades-host-helper.ts:618](../src/cli/sporades-host-helper.ts)) — renames an arbitrary path onto the release `remoteArchive` mid-install.
- `SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE` (:~line "writeRegistryRecordAtomic") — forces registry write failures.
- `SPORADES_HOST_HELPER_CONFIG` — redirects config loading to an arbitrary file.
- `SPORADES_REGISTRY_LOCK_TIMEOUT_MS` — lowers the registry lock timeout.

The archive-swap hook is partially neutered by the claim + double SHA-256 checks, but these are still unauthenticated behaviour modifiers baked into a privileged server component; anyone able to influence the helper's environment (wrapper scripts, systemd overrides, a co-tenant SSH user with a permissive `ForceCommand`) can alter security-relevant control flow.

**Recommendation:** strip or gate these hooks in release builds (e.g. only when `NODE_ENV === "test"`, or compile them out of `bin/sporades-host-helper.js`), and assert at helper startup that none are set in production.

### 4. LOW — Runtime health probe follows redirects

[sporades-host-helper.ts:1149](../src/cli/sporades-host-helper.ts) `fetch(health.runtimeHealthUrl, { headers: { ..., "x-sporades-host-probe": token } })` uses fetch's default `redirect: "follow"`. The URL is constructed from registry/Host-profile data (not directly attacker-controlled), so exploitation requires a DNS/route compromise — but if the Hosted domain ever redirects (misconfigured Caddy, hostile takeover of a decommissioned subname), the 32-byte probe token is forwarded on same-origin redirects, and possibly cross-origin depending on the runtime's header-cleansing behaviour.

**Recommendation:** pass `redirect: "manual"` and treat any 3xx as a route failure; additionally pin the probe to `https` and send the probe against the loopback published port rather than the public hostname where feasible.

### 5. LOW — Registry lock has no staleness recovery

`withRegistryLock` uses `mkdir` on `.lock` with a fixed timeout, but the lock directory carries no owner PID/timestamp. If the helper is killed mid-operation (`SIGKILL`, OOM, SSH disconnect), the lock persists and **every subsequent write operation for that Hosted domain fails** until an operator manually removes it — a self-inflicted availability failure and a ready-made single-SSH-user DoS primitive (create the directory, walk away).

**Recommendation:** record PID + creation time inside the lock directory and treat locks older than a threshold (e.g. 5 minutes) with no live PID as stale, or use `flock` on a lock file so the kernel releases it on process death.

### 6. LOW — `host.logs` reads whole log files into memory

`readManagedCaddyAccessLog` does `readFile(file, "utf8")` then slices the tail. Files are bounded by Caddy roll policy (10 MiB × 5), so memory impact is small, but a misconfigured or maliciously grown log on the shared Host costs the helper process proportionally. **Recommendation:** read the last N bytes via `fs.createReadStream` with a start offset, then parse the tail.

### 7. LOW — Error hints can echo untrusted subnames into operator terminals

Helper error messages interpolate `request.capsule.subname` and domain values directly into hint strings (e.g. "Run `sporades host register ${subname} --host ${alias}`"), which the CLI prints verbatim. Terminal escape sequences embedded in these fields would survive to the user's terminal (mitigated today by the CLI regexes, but see Finding 1). **Recommendation:** once helper-side validation is added this disappears; until then, strip control characters when composing envelope messages.

### 8. INFORMATIONAL — Verified good practices worth preserving

- Release archives are claimed into a `0700`, UID-checked directory, re-hashed before *and after* extraction, with symlink/hardlink/path/Unicode-canonicalization checks on both the tar listing and the extracted tree.
- `docker run` hardening (`--read-only`, noexec tmpfs, `cap-drop ALL`, `no-new-privileges`, non-root user, `127.0.0.1::` publishing) is exemplary; Capsule ports are never exposed publicly — Caddy is the only edge.
- SSH access to Capsules is strictly opt-in, mounts `authorized_keys` read-only, audits enable/inspect events, and never logs key material.
- Runtime probe tokens are 256-bit random, generated host-side only, and stored in the registry record — never accepted from the request.
- Caddy route writes go through validate-then-rename with explicit rollback on reload failure.
- Sealed env private keys are `0600`, key roots `0700`, and old host keys are garbage-collected by fingerprint reference counting.

## Recommendations by priority

1. **(Do first)** Add server-side format validation for `subname`, `domain`, `remoteRoot`, and any Caddy-interpolated string in the Host helper (Finding 1).
2. Switch sealed-env RSA wrapping to OAEP-SHA256 with envelope versioning (Finding 2).
3. Remove or compile out test hooks from the shipped helper; refuse to start if they are set outside test runs (Finding 3).
4. Set `redirect: "manual"` on the health probe fetch (Finding 4).
5. Make the registry lock self-healing via `flock` or PID/TTL staleness (Finding 5).
6. Tail log files instead of fully buffering them (Finding 6).

## Out of scope

- The generated Capsule application server (`src/server.ts`), runtime job scheduler, and OAuth flows — reviewed by existing test suites but not audited here.
- npm dependency vulnerabilities (recommend `npm audit` in CI).
- The base Docker image contents (`Dockerfile.base`) beyond its consumption by the helper.
