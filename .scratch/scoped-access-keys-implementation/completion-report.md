# User-owned scoped Access keys — completion report

Date: 2026-08-21  
Tested commit: `82ac350`  
Branch: `codex/trusted-read-foundation`

## Mandatory release gate

```sh
PATH=/Users/mattcox/.nvm/versions/node/v22.23.2/bin:$PATH \
SPORADES_POSTGRES_TEST_URL=postgres://sporades:[REDACTED]@127.0.0.1:55432/sporades_w17 \
npm run test:access-key-release
```

Result: passed.

- Node: `v22.23.2`
- Docker server: `29.7.2`
- SQLite adapter: per-test temporary file-backed database
- libSQL adapter: per-test service-backed loopback HTTP endpoint on an ephemeral port, backed by a temporary SQLite database
- PostgreSQL adapter: `127.0.0.1:55432/sporades_w17`
- Tests: 1,895 total; 1,858 passed; 0 failed; 0 cancelled; 37 reviewed optional live-smoke skips; 0 todo
- Generated-source manifest: passed
- Documentation build: passed
- Packed-package contract smoke: passed
- SQLite, service-backed libSQL, dedicated PostgreSQL, restart/concurrency, and emitted-SQL quoting cases: passed and required by the fail-closed gate

The 37 allowed skips were only the reviewed external/live smokes: real SSH Hosted operations, live Mailjet SMTP, an environment-dependent Facebook browser redirect, and the opt-in real Base-image framework matrix. No Access-key acceptance, PostgreSQL, emitted-SQL, generated-Bundle, or packed-package proof was skipped.

## Redacted runtime acceptance evidence

- Dev port: `59932`
- fresh Container port: `59945`
- user ID: `0da5785b-cfb8-4038-94c8-15b3cd296208`
- Access-key ID: `db10c5ec-d380-43b3-8bd7-8b6eff1cc821`
- durable Job ID: `7a61772e-637f-4fdb-bf5e-b170e6da2027`
- Hosted action path: CLI → Host helper → container exec → generated Bundle
- disclosed bearer values scanned: 6
- retained bearer files: 0

The purpose-built Capsule proved linked-Session owner management, Bearer admission, Credential provenance, central scoped admission, middleware, current Table/Team/File authority, durable Job execution after rotation/revocation/restart, password-reset bulk retirement, opaque 401/403/429 behavior, one-time browser disclosure and recovery, CLI/operator routing, generated runtime parity, and absence of disclosed credentials from captured non-disclosure surfaces and retained files. Wildcard matching was proved separately by the integrated scope suite.

## Review and cleanup

Independent Spec and Standards reviews were clean at `82ac350`. The acceptance cleanup retains the validated deployment-owned container ID, attempts normal CLI removal first, then verifies and removes only that exact ID if Docker shows it remains. The final focused cleanup proof and mandatory release gate left no acceptance container behind.
