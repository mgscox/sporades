# Document Sealed Server env import before Host push

Status: needs-triage

## Problem

The Host deployment smoke path in `docs/server-installation.md` and
`docs/agents/host-provisioning.md` shows registering and pushing a Capsule, but
does not mention importing legacy `.env.sporades.server` values into Sealed
Server env first.

During the Hetzner photobook smoke test, `sporades host register` succeeded but
`sporades host push --restart --verify` failed with:

```text
Hosted Capsule push requires Sealed Server env.
Run `sporades env import --file .env.sporades.server --json` explicitly, then retry `sporades host push`.
```

The workaround was to run:

```sh
sporades env import --file .env.sporades.server --json
```

For Google-backed templates such as `photo-library`, the working sequence also
needs the OAuth client JSON step before import:

```sh
sporades auth set google --client-json ./client_secret_google.json --json
sporades env import --file .env.sporades.server --json
```

This should be part of the documented Host smoke flow so fresh Hosted Capsule
deployments do not require agents to infer the Server env lifecycle from a push
failure.

## Acceptance Criteria

- [ ] `docs/server-installation.md` explains that Capsules with
  `.env.sporades.server` must run `sporades env import --file
  .env.sporades.server --json` before `sporades host push`.
- [ ] `docs/agents/host-provisioning.md` includes the same step in the optional
  deploy script or clearly documents it immediately before the script.
- [ ] The docs mention `sporades auth set google --client-json ...` before
  `env import` for templates that use Google OAuth credentials.
- [ ] The deploy smoke instructions avoid implying that legacy Server env files
  are pushed directly.
- [ ] A docs test or Host CLI test guards the expected hint/workflow so this
  step does not drift again.

## Notes

Discovered during the Hetzner photobook smoke test on
`photobook-172547.87.99.149.97.sslip.io`. After importing and resealing the
Server env, `host push --restart --verify` succeeded and the release included
`.sporades/sealed-server-env/server-env.sealed.json` without including legacy
Server env directly.
