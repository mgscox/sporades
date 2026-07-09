Status: done

# Migrate Privileged Audit Outcomes

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Migrate the implemented Privileged audit event contract and existing SSH/platform emitters to the canonical lifecycle outcome vocabulary: `started`, `completed`, `errored`, and `finished`. Existing domain-specific event names may remain descriptive, but the `outcome` field must not use legacy success/failure or authorization-policy terms.

## Acceptance criteria

- [ ] Privileged audit outcome normalization accepts only `started`, `completed`, `errored`, and `finished`, with stable behavior for invalid or missing values.
- [ ] Existing SSH and platform audit emitters use the canonical `outcome` field vocabulary while preserving safe domain-specific event names where appropriate.
- [ ] Safe error code defaults and log levels align with the new lifecycle outcomes.
- [ ] Tests prove no canonical audit path emits legacy `requested`, `allowed`, `denied`, `succeeded`, `failed`, or `skipped` outcomes.
- [ ] Docs drift tests and canonical docs remain aligned with the new outcome vocabulary.

## Blocked by

None - can start immediately
