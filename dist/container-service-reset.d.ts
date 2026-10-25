export declare const SERVICE_STATE_CLEANUP_IMAGE = "node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2";
/** Remove only one service's state, after the lifecycle fence revokes secrets. */
export declare function removeCapsuleServiceState(projectDir: string, name: string): Promise<void>;
//# sourceMappingURL=container-service-reset.d.ts.map