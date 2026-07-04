# Database And Storage ACL Rules

Status: ready-for-agent

## Overview

Add ACL rules declared in Capsule definition code and evaluated as invisible runtime policy around the Sporades DB API and file APIs. App code keeps using normal `ctx.db` and file operations; ACL rules accept or reject operations using operation data and a constrained read-only ACL context.

## Source Planning

- `docs/ROADMAP.md`
- `docs/adr/0022-acl-rules-are-runtime-policy-functions.md`
- `CONTEXT.md`

## Scope

- Add app-table ACL declarations in Capsule definition code.
- Apply ACL rules invisibly around the Sporades DB API.
- Provide scoped read-only ACL helpers under `ctx.acl.db` and `ctx.acl.storage`.
- Support `write` as a fallback for insert, update, and delete.
- Keep ACLs allow-by-default when no matching rule is specified.
- Filter read results after fetch in the first implementation.
- Evaluate write ACLs with previous/next row state in the mutation transaction where possible.
- Return opaque public denials and detailed internal structured logs.
- Reserve storage ACL shape while implementing app-table ACL first.

## Non-Goals

- Do not compile ACL policy into database-specific SQL in the first implementation.
- Do not expose normal `ctx.db` inside ACL rules.
- Do not implement storage ACL enforcement in the first slice.
- Do not implement Root server role.
- Do not implement `sporades doctor` warnings in this feature.
- Do not make missing ACLs deny by default.

## Product Decisions

- ACL rules are authorization policy only: may the current actor see or change this row/file metadata record?
- File validation, upload affordances, and client-facing file checks are not ACL concerns.
- `ctx.acl.db` sees app tables only during normal ACL evaluation.
- `ctx.acl.storage` sees stable storage metadata resources, not raw runtime table names.
- Runtime-owned non-app tables are reserved for a future Root server role.
- Public denials should use a broad code such as `DENIED`.

## User Stories

- As a Capsule author, I can declare row-level read/write policy next to my table definition.
- As a Capsule author, I can use a single `write` policy for insert, update, and delete when the same rule applies.
- As an app user, I cannot read or mutate rows rejected by Capsule ACL rules.
- As an agent/developer, I can diagnose ACL denials from structured logs without leaking policy details to clients.

## Implementation Issues

- `issues/01-declare-app-table-acl-rules.md`
- `issues/02-apply-read-acl-filtering.md`
- `issues/03-apply-write-acl-transactions.md`
- `issues/04-add-scoped-acl-context-helpers.md`
- `issues/05-add-acl-denial-logging-and-docs.md`

