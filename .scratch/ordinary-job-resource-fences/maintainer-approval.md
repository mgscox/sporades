# Maintainer approval — M1 and uncertain-email retry

Date: 2026-09-18. Maintainer: Matt Cox. Status: **approved**.

Recorded by Codex from the maintainer's instructions in the conversation that
produced [PR #57](https://github.com/mgscox/sporades/pull/57). This is a transcript
record, not a claim that Matt posted a GitHub review or approved a merge.

Matt accepted the boundary where Grant changes and notification intent commit
together, with later email submission outside the resource fence. He stated:

> the risk or likelihood of an email being incorrectly sent is low.

The explanation then clarified that Jobs retain their initiating actor/credential
provenance, not a frozen database snapshot; current Grant authorization is checked
at acquisition. It separately contrasted duplicate risk on retry with omission
risk when an uncertain SMTP attempt is never retried. Matt replied:

> agreed with your correction.resend the email - it is always better to call 999 twice than never at all.  pls update the PR with this approach.

This approves M1's outbox boundary and explicitly replaces the earlier proposed
no-automatic-resend policy with automatic retry on uncertainty, accepting duplicate
and post-revocation email risk. It does not approve a frozen authorization snapshot,
exactly-once SMTP, a claim of guaranteed inbox delivery, or starting implementation
in this task. Backoff/reservation details are the implementable design recorded in
[ADR-0054](../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md),
not words attributed to the maintainer.

Ticket 01's amended-contract gate is cleared. Ticket 02 is the next eligible
implementation ticket; 03–07 retain their implementation dependencies. This update
neither merges the PR nor closes the parent issue.
