// @ts-nocheck
export const SPORADES_BASE_IMAGE = {
    name: "sporades-base",
    image: "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
    version: "0.1.0-node22-alpine",
    runtimeUser: "sporades",
    runtimeUid: 10001,
    runtimeGid: 10001,
    updatePolicy: {
        defaultMode: "host-managed",
        modes: ["host-managed", "auto-patch", "manual"],
        autoPatchSupported: false,
        autoPatchUnsupportedReason: "Base image updates are applied by replacing containers, not mutating them in place.",
    },
};
export function baseImageRuntimeUser() {
    return `${SPORADES_BASE_IMAGE.runtimeUid}:${SPORADES_BASE_IMAGE.runtimeGid}`;
}
export function normaliseBaseImageUpdatePolicy(value) {
    const mode = typeof value === "string"
        ? value
        : typeof value?.mode === "string"
            ? value.mode
            : SPORADES_BASE_IMAGE.updatePolicy.defaultMode;
    if (!SPORADES_BASE_IMAGE.updatePolicy.modes.includes(mode)) {
        return SPORADES_BASE_IMAGE.updatePolicy.defaultMode;
    }
    return mode;
}
export function baseImageUpdatePolicy(mode = SPORADES_BASE_IMAGE.updatePolicy.defaultMode) {
    return {
        mode: normaliseBaseImageUpdatePolicy(mode),
        autoPatch: {
            supported: SPORADES_BASE_IMAGE.updatePolicy.autoPatchSupported,
            reason: SPORADES_BASE_IMAGE.updatePolicy.autoPatchUnsupportedReason,
        },
    };
}
export function baseImageMetadata(updatePolicyMode = SPORADES_BASE_IMAGE.updatePolicy.defaultMode) {
    return {
        name: SPORADES_BASE_IMAGE.name,
        image: SPORADES_BASE_IMAGE.image,
        version: SPORADES_BASE_IMAGE.version,
        updatePolicy: baseImageUpdatePolicy(updatePolicyMode),
    };
}
export function baseImageLabels(updatePolicyMode = SPORADES_BASE_IMAGE.updatePolicy.defaultMode) {
    return {
        "com.sporades.base-image.name": SPORADES_BASE_IMAGE.name,
        "com.sporades.base-image.version": SPORADES_BASE_IMAGE.version,
        "com.sporades.base-image.update-policy": normaliseBaseImageUpdatePolicy(updatePolicyMode),
    };
}
//# sourceMappingURL=base-image.js.map