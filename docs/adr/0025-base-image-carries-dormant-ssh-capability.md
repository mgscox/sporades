# Base image carries dormant SSH capability

Sporades uses one Base image for local Container sessions and Hosted Capsules, so Container SSH access will add the minimal OpenSSH server capability to that Base image rather than introducing a separate SSH-enabled image. The capability stays dormant unless `ssh.authorizedKeys` is configured, preserving the default no-SSH runtime posture while avoiding a second image selection path for deploy, host lifecycle, documentation, and tests.

SSH sessions log in as the Base image `sporades` user with no sudoers privileges. When SSH is enabled for a local Container session, the container also runs as the Base image runtime user `10001:10001` instead of the invoking host UID/GID so the SSH login user and process user stay aligned; non-SSH local Container sessions keep the existing host UID/GID ergonomics.

Container SSH access remains an opt-in compatibility and emergency access path. It does not replace structured Sporades CLI and Host helper operations as the primary management interface.
