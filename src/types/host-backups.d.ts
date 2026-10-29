/** Opt-in Host profile `backups` policy and encrypted Capsule snapshot manifest.
 * Paths refer to the Host server. Secret file contents are never CLI parameters.
 * Restore requires a stopped destination, full snapshot ID and destination confirmation.
 * Create resumes through readiness, current loopback routing and an authenticated routed
 * probe. Resume failure retains its protected journal and returns ok:false, even when
 * error.diagnostics.snapshotCompleted is true. Snapshot freshness is independent of resume.
 */
export type { HostBackupPolicy, HostBackupManifest, HostBackupResumeDiagnostics } from "../../dist/cli/host-backups.js";
