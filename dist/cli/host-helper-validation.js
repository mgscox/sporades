import path from "node:path";
import { helperError } from "./cli-support.js";
import { expectedReleaseFiles, isExpectedClaimedReleaseFile } from "./host-helper-release-files.js";
export function missingCapsuleHint(request, purpose) {
    if (purpose === "push") {
        return `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before pushing a release.`;
    }
    if (purpose === "stats") {
        return `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before reading stats.`;
    }
    if (purpose === "unregister") {
        return `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before unregistering the Hosted Capsule.`;
    }
    return `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before managing the Hosted Capsule lifecycle.`;
}
export function hostRegistryRetryCommand(request) {
    return request.action === "host.stats" ? `sporades host stats --host ${request.host.alias}` : `sporades host list --host ${request.host.alias}`;
}
export function validateLifecycleRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
        request.capsule?.subname,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule lifecycle request.", "Update the Sporades CLI and retry the host lifecycle command.");
    }
}
export function validateSealedEnvRotationRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
        request.capsule?.subname,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule sealed-env key rotation request.", "Update the Sporades CLI and retry `sporades host rotate-key`.");
    }
}
export function validateStatsRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
        request.capsule?.subname,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule stats request.", "Update the Sporades CLI and retry the host stats command.");
    }
}
export function validateReleaseListRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
        request.capsule?.subname,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule releases request.", "Update the Sporades CLI and retry `sporades host releases`.");
    }
}
export function validateHealthRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
        request.capsule?.subname,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule health request.", "Update the Sporades CLI and retry the host health command.");
    }
}
export function validateScheduleInspectionRequest(request) {
    const requiredStrings = [request.host?.domain, request.host?.alias, request.host?.remoteRoot, request.capsule?.subname];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule Schedule inspection request.", "Update the Sporades CLI and retry `sporades host schedules`.");
    }
}
export function validateHostStatsRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Host stats request.", "Update the Sporades CLI and retry `sporades host stats`.");
    }
}
export function validateRollbackRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
        request.capsule?.subname,
        request.rollback?.releaseId,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule rollback request.", "Update the Sporades CLI and retry `sporades host rollback`.");
    }
    const releaseId = request.rollback?.releaseId;
    if (!releaseId || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(releaseId)) {
        throw helperError("Invalid Hosted Capsule release ID.", `Choose a recorded release ID from \`sporades host releases ${request.capsule.subname} --host ${request.host.alias} --json\`.`);
    }
}
export function validateHostLogsRequest(request, limits) {
    const requiredStrings = [
        request.host?.alias,
        request.host?.domain,
        request.host?.remoteRoot,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Host logs request.", "Update the Sporades CLI and retry `sporades host logs`.");
    }
    const source = request.logs?.source ?? "caddy-combined";
    if (!["http", "caddy-combined", "stdout", "stderr"].includes(source)) {
        throw helperError("Invalid Host log source.", "Use `http`, `stdout`, or `stderr` for `sporades host logs`.");
    }
    if ((source === "stdout" || source === "stderr") && (typeof request.capsule?.subname !== "string" || request.capsule.subname.length === 0)) {
        throw helperError("Missing Capsule subname for container logs.", "Pass `--subname <capsule-subname>` or run the command from a project with a Hosted Capsule binding.");
    }
    const lines = request.logs?.lines ?? limits.defaultLines;
    if (!Number.isInteger(lines) || lines < 1 || lines > limits.maxLines) {
        throw helperError("Invalid Host log line count.", `Pass \`--lines <n>\` with a whole number between 1 and ${limits.maxLines}.`);
    }
}
export function validateListRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule list request.", "Update the Sporades CLI and retry `sporades host list`.");
    }
}
export function validateListRegistryRecord(request, record, recordPath) {
    const capsuleRecord = record;
    const expectedSubname = path.basename(recordPath, ".json");
    const expectedRemoteCapsuleId = `${request.host.domain}/${typeof capsuleRecord?.subname === "string" ? capsuleRecord.subname : expectedSubname}`;
    const valid = capsuleRecord &&
        typeof capsuleRecord.subname === "string" &&
        capsuleRecord.subname.length > 0 &&
        capsuleRecord.subname === expectedSubname &&
        capsuleRecord.domain === request.host.domain &&
        (capsuleRecord.remoteCapsuleId ?? expectedRemoteCapsuleId) === expectedRemoteCapsuleId;
    if (!valid) {
        throw helperError("Hosted Capsule registry record is invalid.", `Repair the Host server registry record at ${recordPath}, then retry \`${hostRegistryRetryCommand(request)}\`.`);
    }
}
export function validateBootstrapRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Host bootstrap request.", "Update the Sporades CLI and retry `sporades host bootstrap`.");
    }
    const tlsMode = request.bootstrap?.tls?.mode ?? "automatic";
    if (tlsMode !== "automatic" && tlsMode !== "cloudflare-origin") {
        throw helperError("Invalid Host TLS mode.", "Use `--tls automatic` for Caddy-managed certificates or `--tls cloudflare-origin` for preinstalled Cloudflare origin certificates.");
    }
}
export function validateRegisterRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
        request.capsule?.subname,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule registration request.", "Update the Sporades CLI and retry `sporades host register`.");
    }
    const registration = request.registration ?? {};
    const mismatchedIdentity = (registration.subname && registration.subname !== request.capsule.subname) ||
        (registration.domain && registration.domain !== request.host.domain) ||
        (registration.remoteCapsuleId && registration.remoteCapsuleId !== `${request.host.domain}/${request.capsule.subname}`);
    if (mismatchedIdentity) {
        throw helperError("Hosted Capsule registration request does not match the Host profile.", "Rebind the local project or pass the correct Host profile and Capsule subname.");
    }
    const tlsMode = request.registration?.bootstrap?.tls?.mode ?? request.bootstrap?.tls?.mode ?? "automatic";
    if (tlsMode !== "automatic" && tlsMode !== "cloudflare-origin") {
        throw helperError("Invalid Host TLS mode.", "Use `--tls automatic` for Caddy-managed certificates or `--tls cloudflare-origin` for preinstalled Cloudflare origin certificates.");
    }
}
export function validateUnregisterRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
        request.capsule?.subname,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule unregister request.", "Update the Sporades CLI and retry `sporades host unregister`.");
    }
    const unregister = request.unregister ?? {};
    const mismatchedIdentity = (unregister.subname && unregister.subname !== request.capsule.subname) ||
        (unregister.domain && unregister.domain !== request.host.domain) ||
        (unregister.remoteCapsuleId && unregister.remoteCapsuleId !== `${request.host.domain}/${request.capsule.subname}`);
    if (mismatchedIdentity) {
        throw helperError("Hosted Capsule unregister request does not match the Host profile.", "Rebind the local project or pass the correct Host profile and Capsule subname.");
    }
}
export function validateDeleteRequest(request) {
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
        request.capsule?.subname,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid Hosted Capsule delete request.", "Update the Sporades CLI and retry `sporades host delete`.");
    }
    const deletion = request.delete ?? {};
    const mismatchedIdentity = (deletion.subname && deletion.subname !== request.capsule.subname) ||
        (deletion.domain && deletion.domain !== request.host.domain) ||
        (deletion.remoteCapsuleId && deletion.remoteCapsuleId !== `${request.host.domain}/${request.capsule.subname}`);
    if (mismatchedIdentity) {
        throw helperError("Hosted Capsule delete request does not match the Host profile.", "Rebind the local project or pass the correct Host profile and Capsule subname.");
    }
}
export function validateInstallRequest(request) {
    const release = request.release;
    const requiredStrings = [
        request.host?.domain,
        request.host?.alias,
        request.host?.remoteRoot,
        request.capsule?.subname,
        release?.id,
        release?.remoteArchive,
        release?.hostedUrl,
        release?.directories?.releases,
        release?.directories?.release,
        release?.directories?.data,
        release?.currentLink,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
        throw helperError("Invalid release install request.", "Update the Sporades CLI and retry `sporades host push`.");
    }
    if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(release.id)) {
        throw helperError("Invalid Hosted Capsule release ID.", "Push again to generate a fresh UTC-sortable release ID.");
    }
    if (!Array.isArray(release.files) || release.files.some((file) => !isExpectedClaimedReleaseFile(file))) {
        throw helperError("Invalid Hosted Capsule release file list.", "Update the Sporades CLI and retry `sporades host push`.");
    }
    const expectedFiles = expectedReleaseFiles(release);
    const claimedFiles = [...release.files].sort();
    const sortedExpectedFiles = [...expectedFiles].sort();
    if (claimedFiles.length !== sortedExpectedFiles.length || claimedFiles.some((file, index) => file !== sortedExpectedFiles[index])) {
        throw helperError("Invalid Hosted Capsule release file list.", "Update the Sporades CLI and retry `sporades host push`.");
    }
    const directories = release.directories;
    if (!directories?.releases || !directories.release) {
        throw helperError("Invalid Hosted Capsule release directory.", "Update the Sporades CLI and retry `sporades host push`.");
    }
    const expectedReleaseDirectory = path.join(directories.releases, release.id);
    if (path.resolve(directories.release) !== path.resolve(expectedReleaseDirectory)) {
        throw helperError("Invalid Hosted Capsule release directory.", "Update the Sporades CLI and retry `sporades host push`.");
    }
}
//# sourceMappingURL=host-helper-validation.js.map