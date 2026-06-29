# Support template selection and blank default for `sporades create`

Status: needs-triage

## What to build

Update project creation so `sporades create` accepts an optional `--template <name>` flag. When the flag is omitted, create a simple blank Sporades app rather than the todo app.

## Acceptance criteria

- [ ] `sporades create <name>` creates a runnable blank app by default.
- [ ] `sporades create <name> --template blank` creates the same blank app.
- [ ] `sporades create <name> --template todo` creates the existing todo app template.
- [ ] Unsupported template names fail with `{ ok: false, data: null, error: { message, hint } }`.
- [ ] `--json` output reports the selected template in the success payload.
- [ ] Existing framework, install, and git flags continue to work across templates.
- [ ] Generated `AGENTS.md`, `README.md`, and `sporades.json` reflect the selected template accurately.
- [ ] The blank template is minimal and does not include auth, file, or app-message examples.

## Blocked by

None - can start immediately.
