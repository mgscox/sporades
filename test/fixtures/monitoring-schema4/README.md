# Pipeline-only monitoring generation

`assets.json.gz` contains the unmodified UTF-8 public monitoring assets from
Sporades commit `6542368d`, with its package version and schema version 4.
`.gitignore` is the shipped `gitignore.template`. The JSON is gzip-compressed
with timestamp zero. It contains no generated credentials or operator files.

This fixture avoids requiring Git history in installed-package tests and proves
that filling missing assets with current `stack init` preserves an older
pipeline-only Compose generation for upgrade and rollback.
