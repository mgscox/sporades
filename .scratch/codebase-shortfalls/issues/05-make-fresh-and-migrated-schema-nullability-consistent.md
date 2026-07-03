# Make fresh and migrated schema nullability consistent

Status: done

## What to build

Ensure the same Capsule schema has the same SQLite constraints and table API behavior whether the database is created fresh or reached through additive migrations. Required fields, fields with defaults, and fields without defaults should not behave differently just because a user added the field after data already existed.

This slice should make nullability and default semantics explicit enough that future field types do not inherit the current fresh-versus-migrated mismatch.

## Acceptance criteria

- [ ] Freshly created tables and additively migrated tables expose equivalent constraints for the same schema.
- [ ] Adding a field without a default to a table with existing rows has documented and tested behavior.
- [ ] Adding a field with a default backfills or constrains rows consistently with fresh table creation.
- [ ] The table API returns consistent values for missing, defaulted, and explicitly supplied fields.
- [ ] Database inspection tests cover both fresh and migrated versions of the same schema.

## Blocked by

- .scratch/codebase-shortfalls/issues/03-build-schema-from-actual-capsule-definition.md
