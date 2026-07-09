# List And Inspect Jobs Across Runtime Sessions

Status: ready-for-agent

## Parent

.scratch/job-queue/PRD.md

## What to build

Complete the Job inspection surface for Capsule server code, operators, and AFK
agents. Harden actor-scoped server listing with pagination and filters, and add
deterministic CLI JSON and concise human output across Dev, Container, and
Hosted Capsule runtime paths.

## Acceptance criteria

- [ ] Normal server context can cursor-list only Jobs whose execution actor is the current captured user, and Privileged server role context can cursor-list all Jobs in the Capsule.
- [ ] Server list supports bounded pagination plus status, handler, and creation-time filters with deterministic ordering.
- [ ] List summaries omit payloads, results, and detailed failure metadata by default; explicit get remains subject to the same user or privileged visibility boundary.
- [ ] `enqueuedBy` provenance never grants list or get visibility, and unauthorized IDs remain indistinguishable from unknown IDs.
- [ ] Privileged server list/get operations execute through `ctx.privileged.run(...)` with mandatory bounded audit metadata.
- [ ] CLI inspection returns deterministic JSON for queue summaries, paginated Job lists, and individual Job state in Dev, local Container, and Hosted Capsule contexts.
- [ ] Human CLI output stays concise and points to Job IDs, statuses, and follow-up commands.
- [ ] Inspection exposes no raw runtime tables, payload secrets, Server env values, tokens, cookies, browser credentials, or raw stack traces.
- [ ] Tests cover user isolation, privileged enumeration, pagination and filters, redaction, audit evidence, deterministic JSON, human output, and generated Dev/Container/Hosted runtime parity.

## Blocked by

- .scratch/job-queue/issues/04-recover-jobs-with-at-least-once-delivery.md
