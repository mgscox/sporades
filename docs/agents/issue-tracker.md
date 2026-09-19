# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a body file for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

External pull requests are not feature requests and do not enter the issue-triage state machine. GitHub shares one number space across issues and PRs, so resolve a bare `#42` with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments` and inspect its labels.

## Parent, child, and blocking relationships

- Use GitHub sub-issues for parent/child work. Prefer `gh issue create --parent <number>` or `gh issue edit <parent> --add-sub-issue <child>`.
- Use GitHub native issue dependencies as the canonical, UI-visible blocking graph. Prefer `gh issue create --blocked-by <numbers>` or `gh issue edit <child> --add-blocked-by <number>`.
- If native dependencies are unavailable, fall back to a `Blocked by: #<n>, #<n>` line in the child body.
- A ticket is unblocked when every blocking issue is closed.
- The frontier is the first open, unassigned sub-issue with no open blockers.

## Wayfinding operations

Used by `/wayfinder`. The map is one GitHub issue and its tickets are ordered sub-issues.

- **Map**: create one issue labelled `wayfinder:map` containing Notes, Decisions-so-far, and Fog.
- **Child ticket**: create an issue under the map and apply the appropriate `wayfinder:<type>` label.
- **Blocking**: record every edge with native issue dependencies.
- **Claim**: assign the frontier ticket to the driving developer.
- **Resolve**: record the answer or completion evidence, close the ticket, and update the map's decisions.
