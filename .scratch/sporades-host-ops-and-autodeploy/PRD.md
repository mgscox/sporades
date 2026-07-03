# Host Ops and Autodeploy

## Overview

This planning area covers the next layer of Hosted Capsule operations that make
Sporades more attractive for developers and agents without turning it into a
dashboard-first hosting platform.

The goal is to make Hosted Capsules safer to operate from deterministic CLI
commands: health checks, status surfaces, release history, rollback, release
verification, and GitHub Actions autodeploy generation.

## Scope

- Add a safe Host server health route for DNS, TLS, Caddy, and route-layer
  verification.
- Add Hosted Capsule runtime health checks for route, container, SQLite, and
  storage readiness.
- Add protected status surfaces for Host server and Hosted Capsule resource
  stats.
- Record Hosted Capsule release history and expose it through CLI inspection.
- Add rollback to a previously recorded Hosted Capsule release.
- Add release verification around Host pushes.
- Generate inspectable GitHub Actions workflows for branch-based autodeploy.
- Report autodeploy outcomes back to GitHub commits or pull requests.

## Non-Goals

- Do not build a dashboard.
- Do not make GitHub the only supported release path.
- Do not add preview environments, team management, billing, analytics, or edge
  runtime concepts as part of this feature set.
- Do not expose sensitive Host server or container status through public routes.

## Product Principles

- CLI remains the primary interface.
- Host server state remains authoritative.
- Public health responses are intentionally boring and safe.
- Status and resource details are protected and structured for agents.
- GitHub automation is an inspectable bridge over the existing release path, not
  a second deployment system.

