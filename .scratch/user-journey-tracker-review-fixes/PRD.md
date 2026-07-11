# User Journey Tracker Review Fixes

Status: ready-for-agent

## Problem

The implementation review after User Journey Tracker issues 01 through 04 found
two mismatches between the published issue contract and the current runtime:

1. Journey records omit `metadata` when a publisher does not supply it even
   though issue 02 promises one stable complete public record shape.
2. Automatic navigation capture observes attributes on every `meta` element
   even though issue 04 promises a narrowly targeted Journey metadata observer.

## Outcome

Bring source, generated artifacts, public types, and focused behavior tests back
into agreement with the accepted User Journey Tracker contract before issue 05
continues lifecycle work.

