# Add job queue

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Design a durable job queue for background work, using something like Bull only if it fits Sporades' local-first architecture.

## Acceptance criteria

- [ ] A future PRD defines the app-facing job API.
- [ ] The design records whether the queue is local SQLite-backed, Redis-backed, or adapter-based.
- [ ] The design covers dev session and container session behavior.
- [ ] The design defines failure, retry, and visibility semantics.
- [ ] v2 does not add job queues unless maintainers explicitly promote this marker.

## Notes

Queue planning should avoid forcing a remote service into the default local developer loop.
