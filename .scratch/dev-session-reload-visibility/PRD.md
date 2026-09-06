# Dev session reload visibility

Status: complete

## Source Planning

- `docs/guide/local-operations.md`
- `CONTEXT.md`
- `docs/PRD.md`

## Problem Statement

A Dev session reloads the Capsule in place when a change lands under `server/`
or `shared/`. The process is never replaced, so nothing outside the session
records that a server change took effect: the pid is the same before and after,
and so is the uptime. The only trace a reload leaves is stdout, which a
developer working through a build has usually scrolled past.

This makes one question unanswerable after the fact: did my change land? An
empty `sporades logs` is indistinguishable between "the server never reloaded"
and "it reloaded cleanly", and the two call for opposite next steps. A
developer who has just added a table, mutation, or Job has no durable way to
confirm the running Capsule now serves it.

Every other Sporades runtime event of consequence is a structured log entry.
An in-place Capsule reload should be one too.

## Goals

- Record each Dev-session Capsule reload as a structured `platform` log entry
  that `sporades logs` reads back.
- Describe what the reloaded Capsule now serves, so the entry answers "did my
  change land?" and not merely "something reloaded".
- Keep the entry free of Capsule data and of anything a developer would have to
  redact before sharing a log.

## Non-Goals

- Do not change reload triggering, sequencing, or failure handling; this is an
  observability slice over the existing reload path.
- Do not log client-only rebuilds, which do not reload the Capsule.
- Do not add a reload counter, a dashboard, or a long-running monitor.

## Approach

`startDevSession` already knows when a rebuild reloaded the Capsule rather than
only the client bundle. Emit the log entry at that point, through the runtime's
own logger, so the entry reaches `sporades logs` by the same route as every
other platform event.

The payload names the tables, mutations, and Jobs the reloaded Capsule serves.
Names rather than counts: a count only answers the developer's question if they
memorised the previous one, whereas a sorted list of names can be read directly
for the thing they just added.
