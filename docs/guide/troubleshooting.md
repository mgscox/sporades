# Troubleshooting

Start with the smallest relevant inspection surface:

1. Read the failing command's structured output.
2. Run `sporades doctor` for the target session.
3. Inspect logs and runtime state without mutating it.
4. Reset only the owned state you intentionally want to discard.

Classify the failure before acting: build failures belong to source or client
toolchain setup; startup failures belong to runtime configuration or services;
route failures belong to the Container or Host lifecycle. Do not erase local
state merely because a release or route is unhealthy.

See [Troubleshooting](./reference.md#troubleshooting) for known symptoms and [local operations](./local-operations.md) for inspection commands. For filesystem ownership and mount questions, consult the [runtime layout](../runtime-layout.md).
