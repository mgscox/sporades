import type { HostHelperRelease, HostLifecycleOptions } from "./host-helper-contract.js";
import type { LooseRecord } from "./cli-support.js";
export declare function createHostReleaseRequest(options: LooseRecord): HostHelperRelease;
export declare function createHostLifecycleRequest(alias: string, profile: LooseRecord, subname: string, options?: LooseRecord): HostLifecycleOptions;
export declare function createHostStatsRequest(profile: LooseRecord, subname: string): {
    domain: any;
    subname: string;
    hostedUrl: string;
    remoteCapsuleId: string;
    container: {
        name: string;
    };
};
export declare function createHostRuntimeHealthRequest(profile: LooseRecord, subname: string): {
    domain: any;
    subname: string;
    hostedUrl: string;
    remoteCapsuleId: string;
    runtimeHealthUrl: string;
    container: {
        name: string;
    };
};
export declare function createHostBootstrapRequest(profile: LooseRecord): {
    substrate: {
        packages: string[];
        services: string[];
    };
    directories: {
        remoteRoot: any;
        bin: string;
        incoming: string;
        caddy: string;
        caddyHosts: string;
        hosts: string;
        domain: string;
        tls: string;
        registry: string;
        capsules: string;
    };
    domainDirectory: string;
    tls: {
        mode: string;
        directory: string;
        certificate: string | null;
        key: string | null;
    };
    caddy: {
        managedInclude: string;
        domainInclude: string;
    };
};
export declare function createHostRegistrationRequest(alias: string, profile: LooseRecord, subname: string): {
    subname: string;
    domain: any;
    hostedUrl: string;
    remoteCapsuleId: string;
    registryRecord: string;
    directories: {
        capsule: string;
        releases: string;
        data: string;
        logs: string;
    };
    route: {
        hostname: string;
        target: string;
        statusCode: number;
        routeFile: string;
        tls: {
            mode: string;
            directory: string;
            certificate: string | null;
            key: string | null;
        };
        log: {
            file: string;
        };
    };
    baseImage: {
        name: string;
        image: string;
        version: string;
        updatePolicy: {
            mode: string;
            autoPatch: {
                supported: boolean;
                reason: string;
            };
        };
    };
    bootstrap: {
        command: string;
        tls: {
            mode: string;
            directory: string;
            certificate: string | null;
            key: string | null;
        };
    };
};
export declare function createHostUnregisterRequest(profile: LooseRecord, subname: string): {
    subname: string;
    domain: any;
    hostedUrl: string;
    remoteCapsuleId: string;
    registryRecord: string;
    directories: {
        capsule: string;
        releases: string;
        data: string;
    };
    container: {
        name: string;
    };
    routes: {
        removed: {
            hostname: string;
            target: string;
            routeFile: string;
        };
    };
};
export declare function createHostDeleteRequest(profile: LooseRecord, subname: string): {
    subname: string;
    domain: any;
    hostedUrl: string;
    remoteCapsuleId: string;
    registryRecord: string;
    directories: {
        capsule: string;
        releases: string;
        data: string;
    };
    routes: {
        removed: {
            hostname: string;
            target: string;
            routeFile: string;
        };
    };
};
//# sourceMappingURL=host-request-builders.d.ts.map