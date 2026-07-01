# Add real Host push routing smoke test

Status: ready-for-agent

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Add opt-in smoke coverage that verifies a real Host server can serve a pushed Hosted Capsule through the public Hosted domain. The smoke test should create a disposable Capsule from either the `todo` or `guestbook` template, register or reuse the configured Capsule subname, push it with restart, and verify the public URL returns the template app through Cloudflare or the configured HTTP route.

The test must be driven by environment variables so it can run against any disposable Host server without hard-coded IP addresses, domains, subnames, or remote roots.

## Acceptance criteria

- [ ] The smoke test is skipped unless the required environment variables for SSH target, Hosted domain, remote root, Capsule subname, and public URL/routing expectation are present.
- [ ] The smoke test creates a temporary `todo` or `guestbook` template Capsule, installs dependencies as needed, and does not depend on files left behind by previous local runs.
- [ ] The smoke test registers the configured Capsule subname when absent, or safely reuses it when already registered for the same Hosted domain.
- [ ] The smoke test pushes with restart and verifies the public HTTP(S) URL returns `200` and the expected template HTML or client asset.
- [ ] The smoke test does not hard-code `168.119.161.21`, `mattgscox.co.uk`, `verify-181948`, or any other specific environment value.
- [ ] Test documentation names the required environment variables and notes that the Host server should be disposable because the test creates or mutates a real Hosted Capsule.

## Blocked by

- .scratch/sporades-host-server/issues/17-route-hosted-capsules-through-loopback-published-ports.md
