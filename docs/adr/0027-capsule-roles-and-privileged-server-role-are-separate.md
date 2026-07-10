# Capsule roles and Privileged server role are separate actor concepts

Sporades separates Capsule-scoped user authorization from userless system-owned
execution. Capsule admin behavior belongs in Capsule roles checked through
normal ACL rules. Privileged server role is a server-only actor for trusted
system-owned execution that intentionally runs without a Sporades user identity,
such as scheduled Jobs or platform-owned maintenance inside a Capsule.

Sporades will not add a global `admin` role to runtime-owned auth users for this
feature. A runtime auth-user role would make ACL checks easy, but it would also
turn app-specific authorization into platform identity state and create unclear
scope across Capsules. Capsule roles keep app authority scoped to one Capsule's
DB, files, and storage resources, while the Privileged server role remains the
explicit actor for work that has no live or captured user.

ACL gates normal DB and storage access. Privileged server role does not change
the underlying Database adapter, Storage adapter, or Capsule service contract;
it uses an explicit audited runtime route to reach the same Capsule resources
without normal user ACL filtering.

The main risk trade-off is different for each model. Runtime-owned global admin
state lowers the chance that app code accidentally lets users self-promote, but
it increases platform blast radius and creates a new high-impact role mutation
surface. Capsule-owned roles preserve Capsule isolation and fit the existing ACL
model, but app authors must still design safe role-granting flows. Sporades
should document and test those ACL patterns rather than collapse them into the
Privileged server role.
