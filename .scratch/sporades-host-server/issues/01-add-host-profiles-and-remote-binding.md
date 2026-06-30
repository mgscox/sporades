# Add Host profiles and remote binding

Status: done

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Add the local Host profile and project remote binding path for the hosted Capsule MVP. Developers should be able to add a Host profile, select the current Host profile, override the target Host profile per command, and have project-level remote binding metadata available as a convenience pointer without treating it as authoritative Hosted Capsule state.

## Acceptance criteria

- [ ] `sporades host add <alias> --server <ssh-target> --domain <hosted-domain>` stores a Host profile with server, Hosted domain, default `https` scheme, and default remote root.
- [ ] `sporades host use <alias>` records the current Host profile and subsequent host commands can resolve it.
- [ ] Host commands can explicitly select a Host profile instead of relying on the current profile.
- [ ] Host profile data is stored outside projects, while project remote binding data is stored under the project's Sporades runtime directory.
- [ ] Host profile validation rejects missing aliases, invalid Hosted domains, and invalid remote roots with standard Sporades JSON errors under `--json`.
- [ ] Tests cover current profile resolution, explicit profile overrides, arbitrary domains, arbitrary SSH targets, and absence of hard-coded `mattgscox.co.uk`.

## Blocked by

None - can start immediately.
