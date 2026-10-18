/** Opt-in Host profile `backups` policy and encrypted Capsule snapshot manifest.
 * Paths refer to the Host server. Secret file contents are never CLI parameters.
 * Restore requires a stopped destination, full snapshot ID and destination confirmation.
 */
export type { HostBackupPolicy, HostBackupManifest } from "../../dist/cli/host-backups.js";
