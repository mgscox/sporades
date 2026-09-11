# Log payload cap floor

Status: complete

## Source Planning

- Original tracker PR: https://github.com/mgscox/sporades/pull/30
- User authorized implementation on 2026-09-11 using the actual configured identity.
- `docs/guide/configuration.md` is the canonical shipped contract.

## Problem and decision

A 256-byte cap can discard the structured data in normal platform events.
The original PR proposed a global floor based on 64-byte identities, but those
identity limits do not exist. Use actual configured identity and release overhead
instead, with the bounded event allowances below. This supersedes the global
floor and the unratified identity limits in the original proposal.

## Contract

`logs.payloadMaxBytes` caps the serialized JSON log envelope, including metadata
and the truncation flag; it is not a data-only budget. `logging.payloadMaxBytes`
is an alias. When both are present, `logs` takes precedence, and both explicitly
supplied values must validate as safe integers.

The minimum is computed from the same envelope constructor as the runtime writer.
It includes the actual configured Capsule name and ID (`capsule.id`, then `id`,
then name; absent name is `unknown`) and configured `release` value, including
JSON escaping and UTF-8 encoding. It reserves these additional allowances:

| Field | Protected allowance |
| --- | --- |
| `event` | 64 bytes of JSON-escaped UTF-8 content, excluding surrounding quotes |
| `message` | 128 bytes of JSON-escaped UTF-8 content, excluding surrounding quotes |
| `category`, `level` | 16 bytes each, measured the same way |
| `timestamp` | 24-byte UTC ISO timestamp, such as `2026-09-11T00:00:00.000Z` |
| `request`, `correlation` | `null` |
| `data` | 256 bytes of serialized JSON after redaction |
| `truncated` | `false`, including the field and value in the byte budget |

An event within all these allowances retains its structured data at the minimum.
These are protected allowances, not restrictions on the events a Capsule may log.
Longer messages, additional request/correlation metadata, per-event release
metadata exceeding the configured release, or larger data can still truncate.
Redaction continues to apply before budgeting.

Configuration loading and runtime startup reject values below the calculated
minimum with `INVALID_LOG_CONFIG` and a hint containing the required byte count.
There is no universal numeric floor and no new identity-length limit. The default
is still 4096 bytes; if even the default is too small for the configured identity
and release, set an explicit sufficient cap. Values are never silently raised.
Existing very small caps, numeric strings, and other non-integer values must be
replaced with valid numeric caps. Changing Capsule identity or release can change
the required minimum.

## Non-goals

Do not change the truncation fallback or shedding order, restrict Capsule names,
or claim that arbitrary events cannot truncate. Do not change the completed
Dev reload work from PR #29.

## Completion evidence

Implemented in `bfb6bce1` on `codex/log-payload-cap-floor` in the isolated
`/Users/mattcox/.codex/worktrees/dd0a/sporades` worktree. See the child issue for
verification results. GitHub publication is pending explicit authorization;
PR #30 itself remains unchanged.
