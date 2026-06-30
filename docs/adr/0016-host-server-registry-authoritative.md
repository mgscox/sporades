# Host server registry is authoritative for Hosted Capsules

Hosted Capsule existence and lifecycle state are owned by the Host server registry, not by project-local binding files. Local bindings are convenience pointers for commands such as `push`, while commands such as `list`, `start`, `stop`, `restart`, and `stats` must be able to operate from any machine with the relevant Host profile because the Host server is the shared source of truth.
