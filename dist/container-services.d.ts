type RecordValue = Record<string, any>;
export type ContainerServiceDeclaration = {
    kind: "container";
    image: string;
    command: string[];
    port: number;
    health: {
        http?: string;
        tcp?: true;
        startPeriodSeconds?: number;
        await?: boolean;
    };
    state?: {
        path: string;
    };
    user?: string;
    hardening?: {
        readOnlyRootFilesystem?: boolean;
    };
    network?: {
        egress?: boolean;
    };
    env?: Record<string, string | {
        sealed: string;
    } | {
        generated: string;
    }>;
    compose?: RecordValue;
    elevated?: string[];
};
export type ContainerSecretResolution = {
    environment: Record<string, string>;
    services: Record<string, {
        secrets: Record<string, string>;
    }>;
};
export declare function containerDeclarations(config: RecordValue): Array<[string, ContainerServiceDeclaration]>;
/** Safe addressing metadata for lifecycle inspection; no connection URLs or credentials. */
export declare function capsuleServiceNetwork(model: RecordValue, service: RecordValue): string;
/** Startup addressing policy; inspection and teardown must still accept Dev declarations. */
export declare function validateContainerServiceAddress(name: string, service: ContainerServiceDeclaration, connection: "local" | "container"): void;
export declare function classifyContainerCompose(key: string): "ordinary" | "owned" | "elevated" | "forbidden";
export declare function containerMount(name: string, mount: any, projectDir: string): RecordValue;
export declare function validateContainerDeclaration(name: string, value: unknown, all: RecordValue, projectDir?: string): asserts value is ContainerServiceDeclaration;
export declare function validateContainerDependencies(services: RecordValue): void;
/** Pin external inherited mounts to an inspected immutable container identity. */
export declare function pinContainerInheritedMounts(model: RecordValue, projectDir: string, inspectContainer: (name: string) => unknown, inspectVolume?: (name: string) => unknown): boolean;
export declare function serviceInterpolationName(name: string, key: string): string;
/** Values stay exclusively in memory and the protected credentials file. */
export declare function resolveContainerSecrets(projectDir: string, config: RecordValue, sealed?: Record<string, string>): Promise<ContainerSecretResolution>;
/** Discard removed services/secret names only after successful lifecycle admission. */
export declare function finalizeContainerSecrets(projectDir: string, config: RecordValue, expected?: ContainerSecretResolution): Promise<void>;
/** Shared by built-in and container credentials so concurrent writers cannot rotate keys. */
export declare function updateServiceCredentials<T>(projectDir: string, update: (saved: RecordValue) => {
    value: RecordValue;
    result: T;
}): Promise<T>;
export declare function renderContainerService(name: string, service: ContainerServiceDeclaration, generatedName: string, projectDir: string, model: RecordValue, volumes: RecordValue): RecordValue;
/** Examine the actual resolved service, never log either model (it has secrets). */
export declare function validateResolvedContainerServices(rendered: RecordValue, resolved: RecordValue, declarations: RecordValue, mapping: Record<string, string>, environment: Record<string, string>): void;
export {};
//# sourceMappingURL=container-services.d.ts.map