# Auto-prepare Hosted Capsule base image on Host start

Status: done

## Problem

Fresh Host servers may not have `ghcr.io/sporades/sporades-base:0.1.0-node22-alpine` installed locally, and the registry pull can fail with `denied`. In that state, `sporades host push --verify` can install the release but fail at container start because Docker cannot resolve the configured base image.

Local `sporades deploy` already prepares the base image by inspecting, pulling, and then building from `Dockerfile.base` when needed. Hosted Capsule lifecycle should have the same no-workaround behavior.

## Acceptance Criteria

- [x] Hosted Capsule start/restart/rollback paths inspect for the configured Sporades base image before `docker run`.
- [x] If the image is missing, the Host helper tries `docker pull`.
- [x] If pull fails, the Host helper builds the image from Host-installed `Dockerfile.base`.
- [x] If neither pull nor build can work, the Host helper returns a structured error that explains which Host asset or Docker operation is missing.
- [x] Tests cover the inspect-hit path and pull-fail/build-success path.

## Notes

Discovered during live disposable Capsule verification on `live` while deploying `wild-162907-7212`.
