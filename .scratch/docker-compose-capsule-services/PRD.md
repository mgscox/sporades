# Docker Compose Capsule Services

Status: ready-for-agent

## Overview

Add repeatable local provisioning for Capsule services through Sporades-owned generated Docker Compose files. The first implementation focuses on database Capsule services for Dev sessions and local Container sessions, establishing the service orchestration substrate needed by future service-backed Database adapters.

## Source Planning

- `docs/ROADMAP.md`
- `docs/adr/0020-capsule-services-declared-in-sporades-config.md`
- `CONTEXT.md`

## Scope

- Declare Capsule service intent in `sporades.json`.
- Generate Docker Compose files under the Runtime directory; users do not hand-edit Compose YAML by default.
- Support database Capsule services only in the first slice.
- Start declared services for `sporades dev`.
- Run local Container sessions on the same generated Compose network as declared services.
- Share local Capsule service data between Dev sessions and local Container sessions.
- Add local lifecycle/status/reset behavior on existing `dev` and `deploy` surfaces rather than introducing a `sporades services` command group.
- Produce a Hosted Capsule service orchestration design contract without implementing Host orchestration yet.

## Non-Goals

- Do not implement Hosted Capsule service orchestration in this feature.
- Do not add arbitrary Compose escape hatches in the first slice.
- Do not remove shared third-party service images during reset.
- Do not solve broad database dialect portability here.

## Product Decisions

- Capsule services are runtime companions owned by the Capsule execution environment.
- `sporades.json` declares service intent; generated Compose files live under `.sporades/`.
- Dev sessions and local Container sessions share service data by default.
- Reset should be explicit and should clean generated Compose data, networks, volumes, and orphans.
- Reset may remove Sporades-owned Capsule images by Sporades-generated labels or tags, but must not remove shared third-party database images.
- The CLI should trend toward common `status`, `start`, `stop`, and `reset` verbs across `dev`, `deploy`, and `host`, but this feature implements only the local pieces it needs.

## User Stories

- As a developer, I can declare a local database Capsule service once and have `sporades dev` start it for me.
- As an agent, I can inspect whether local Capsule services are running without parsing Docker output.
- As a developer, I can verify a local Container session against the same database service state used during development.
- As an operator, I can reset generated local service state without deleting unrelated Runtime state or shared third-party images.

## Implementation Issues

- `issues/01-declare-database-capsule-services.md`
- `issues/02-start-capsule-services-for-dev-sessions.md`
- `issues/03-run-container-sessions-with-capsule-services.md`
- `issues/04-add-local-service-status-stop-reset.md`
- `issues/05-document-hosted-service-contract.md`

