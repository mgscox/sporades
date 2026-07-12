# Hosting Capsules

Hosting has two separate jobs: provision a Host server once, then publish and
operate Capsules on it repeatedly.

For provisioning, follow [Host server installation](../server-installation.md).
For normal Capsule lifecycle commands, use the [Hosted Capsules reference](./reference.md#hosted-capsules).

The normal publishing sequence is register once, import or seal Server env,
push a release, then verify health and logs. Use structured Host commands so the
same workflow remains operable by people and agents; SSH is an opt-in emergency
compatibility path rather than the management interface.

Validate locally before pushing a release. A Host server is an execution target,
not a substitute for the Dev feedback loop.
