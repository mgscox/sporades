# Evaluate vector-storage extension

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Evaluate whether Sporades should add a vector-storage extension for AI tasks, including whether MySQL is an appropriate target for that extension.

## Acceptance criteria

- [ ] A future PRD or research note states whether vector storage belongs in Sporades core or an extension.
- [ ] The design reconciles MySQL with Sporades' current SQLite local-first data model.
- [ ] The design identifies app-facing APIs, if any, without coupling existing table APIs to vectors prematurely.
- [ ] The design records migration and hosting implications.
- [ ] v2 does not add vector storage unless maintainers explicitly promote this marker.

## Notes

This marker is the least aligned with the current local SQLite product shape and should probably start as research before implementation issues.
