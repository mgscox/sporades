import { baseImageLabels, baseImageMetadata, baseImageRuntimeUser } from "../base-image.js";
const DEFAULT_HOST_TLS_MODE = "automatic";
const HOST_TLS_MODES = new Set(["automatic", "cloudflare-origin"]);
const CAPSULE_RUNTIME_HEALTH_PATH = "/__sporades/health/runtime";
export function createHostReleaseRequest(options) {
    const registration = createHostRegistrationRequest(options.alias, options.profile, options.subname);
    const releaseDirectory = posixJoin(registration.directories.releases, options.releaseId);
    const files = ["server.mjs", "client.js", "index.html", "sporades.json"];
    if (options.bundle.containerMounts.serverEnv) {
        files.push(".env.sporades.server");
    }
    if (options.sealedServerEnv) {
        files.push(".sporades/sealed-server-env/server-env.sealed.json");
    }
    return {
        id: options.releaseId,
        domain: options.profile.domain,
        subname: options.subname,
        hostedUrl: options.binding.hostedUrl,
        remoteCapsuleId: options.binding.remoteCapsuleId,
        remoteArchive: options.remoteArchive,
        restart: options.restart,
        serverEnvIncluded: Boolean(options.bundle.containerMounts.serverEnv),
        sealedServerEnvIncluded: Boolean(options.sealedServerEnv),
        sealedServerEnv: options.sealedServerEnv
            ? {
                publicKeyFingerprint: options.sealedServerEnv.publicKeyFingerprint,
                publicKeyPath: options.sealedServerEnv.publicKeyPath,
            }
            : null,
        baseImage: baseImageMetadata(options.updatePolicyMode),
        files,
        directories: {
            capsule: registration.directories.capsule,
            releases: registration.directories.releases,
            release: releaseDirectory,
            data: registration.directories.data,
        },
        currentLink: posixJoin(registration.directories.capsule, "current"),
    };
}
export function createHostLifecycleRequest(alias, profile, subname, options = {}) {
    const registration = createHostRegistrationRequest(alias, profile, subname);
    const currentLink = posixJoin(registration.directories.capsule, "current");
    const containerName = createHostedContainerName(profile.domain, subname);
    const remoteCapsuleId = `${profile.domain}/${subname}`;
    const baseImage = baseImageMetadata(options.updatePolicyMode);
    return {
        domain: profile.domain,
        subname,
        hostedUrl: `${profile.scheme}://${subname}.${profile.domain}`,
        remoteCapsuleId,
        currentLink,
        directories: registration.directories,
        mounts: {
            files: [
                { host: posixJoin(currentLink, "server.mjs"), container: "/app/server.mjs", mode: "ro" },
                { host: posixJoin(currentLink, "client.js"), container: "/app/client.js", mode: "ro" },
                { host: posixJoin(currentLink, "index.html"), container: "/app/index.html", mode: "ro" },
                { host: posixJoin(currentLink, "sporades.json"), container: "/app/sporades.json", mode: "ro" },
                { host: posixJoin(currentLink, ".env.sporades.server"), container: "/app/.env.sporades.server", mode: "ro", optional: true },
                {
                    host: posixJoin(currentLink, ".sporades/sealed-server-env/server-env.sealed.json"),
                    container: "/app/.sporades/sealed-server-env/server-env.sealed.json",
                    mode: "ro",
                    optional: true,
                },
                {
                    host: posixJoin(registration.directories.data, "sealed-server-env/server-env.private.pem"),
                    container: "/app/.sporades/sealed-server-env/server-env.private.pem",
                    mode: "ro",
                    optional: true,
                },
            ],
            data: {
                host: registration.directories.data,
                container: "/app/data",
                mode: "rw",
            },
        },
        container: {
            name: containerName,
            image: baseImage.image,
            user: baseImageRuntimeUser(),
            baseImage,
            labels: {
                "com.sporades.managed": "true",
                "com.sporades.hosted-domain": profile.domain,
                "com.sporades.capsule-subname": subname,
                "com.sporades.capsule-id": remoteCapsuleId,
                ...baseImageLabels(baseImage.updatePolicy.mode),
            },
        },
        routes: {
            running: {
                hostname: `${subname}.${profile.domain}`,
                target: "container",
                containerName,
                port: 4000,
                routeFile: registration.route.routeFile,
                tls: registration.route.tls,
            },
            unavailable: registration.route,
        },
    };
}
export function createHostStatsRequest(profile, subname) {
    return {
        domain: profile.domain,
        subname,
        hostedUrl: `${profile.scheme}://${subname}.${profile.domain}`,
        remoteCapsuleId: `${profile.domain}/${subname}`,
        container: {
            name: createHostedContainerName(profile.domain, subname),
        },
    };
}
export function createHostRuntimeHealthRequest(profile, subname) {
    const hostedUrl = `${profile.scheme}://${subname}.${profile.domain}`;
    return {
        domain: profile.domain,
        subname,
        hostedUrl,
        remoteCapsuleId: `${profile.domain}/${subname}`,
        runtimeHealthUrl: `${hostedUrl}${CAPSULE_RUNTIME_HEALTH_PATH}`,
        container: {
            name: createHostedContainerName(profile.domain, subname),
        },
    };
}
export function createHostBootstrapRequest(profile) {
    const caddyDirectory = posixJoin(profile.remoteRoot, "caddy");
    const hostsDirectory = posixJoin(profile.remoteRoot, "hosts");
    const domainDirectory = posixJoin(profile.remoteRoot, "hosts", profile.domain);
    const tlsDirectory = posixJoin(domainDirectory, "tls");
    const tlsMode = normaliseHostTls(profile.tls).mode;
    return {
        substrate: {
            packages: ["docker", "caddy"],
            services: ["docker", "caddy"],
        },
        directories: {
            remoteRoot: profile.remoteRoot,
            bin: posixJoin(profile.remoteRoot, "bin"),
            incoming: posixJoin(profile.remoteRoot, "incoming"),
            caddy: caddyDirectory,
            caddyHosts: posixJoin(caddyDirectory, "hosts"),
            hosts: hostsDirectory,
            domain: domainDirectory,
            tls: tlsDirectory,
            registry: posixJoin(domainDirectory, "registry"),
            capsules: posixJoin(domainDirectory, "capsules"),
        },
        domainDirectory,
        tls: {
            mode: tlsMode,
            directory: tlsDirectory,
            certificate: tlsMode === "cloudflare-origin" ? posixJoin(tlsDirectory, "origin.crt") : null,
            key: tlsMode === "cloudflare-origin" ? posixJoin(tlsDirectory, "origin.key") : null,
        },
        caddy: {
            managedInclude: posixJoin(caddyDirectory, "sporades-hosted-domains.caddy"),
            domainInclude: posixJoin(caddyDirectory, "hosts", `${profile.domain}.caddy`),
        },
    };
}
export function createHostRegistrationRequest(alias, profile, subname) {
    const bootstrap = createHostBootstrapRequest(profile);
    const capsuleDirectory = posixJoin(bootstrap.directories.capsules, subname);
    const capsuleLog = posixJoin(capsuleDirectory, "logs", "http.log");
    return {
        subname,
        domain: profile.domain,
        hostedUrl: `${profile.scheme}://${subname}.${profile.domain}`,
        remoteCapsuleId: `${profile.domain}/${subname}`,
        registryRecord: posixJoin(bootstrap.directories.registry, "capsules", `${subname}.json`),
        directories: {
            capsule: capsuleDirectory,
            releases: posixJoin(capsuleDirectory, "releases"),
            data: posixJoin(capsuleDirectory, "data"),
            logs: posixJoin(capsuleDirectory, "logs"),
        },
        route: {
            hostname: `${subname}.${profile.domain}`,
            target: "hosted-capsule-unavailable",
            statusCode: 503,
            routeFile: posixJoin(bootstrap.directories.caddyHosts, profile.domain, `${subname}.caddy`),
            tls: bootstrap.tls,
            log: { file: capsuleLog },
        },
        baseImage: baseImageMetadata(),
        bootstrap: {
            command: `sporades host bootstrap --host ${alias}`,
            tls: bootstrap.tls,
        },
    };
}
export function createHostUnregisterRequest(profile, subname) {
    const bootstrap = createHostBootstrapRequest(profile);
    const capsuleDirectory = posixJoin(bootstrap.directories.capsules, subname);
    return {
        subname,
        domain: profile.domain,
        hostedUrl: `${profile.scheme}://${subname}.${profile.domain}`,
        remoteCapsuleId: `${profile.domain}/${subname}`,
        registryRecord: posixJoin(bootstrap.directories.registry, "capsules", `${subname}.json`),
        directories: {
            capsule: capsuleDirectory,
            releases: posixJoin(capsuleDirectory, "releases"),
            data: posixJoin(capsuleDirectory, "data"),
        },
        container: {
            name: createHostedContainerName(profile.domain, subname),
        },
        routes: {
            removed: {
                hostname: `${subname}.${profile.domain}`,
                target: "removed",
                routeFile: posixJoin(bootstrap.directories.caddyHosts, profile.domain, `${subname}.caddy`),
            },
        },
    };
}
export function createHostDeleteRequest(profile, subname) {
    const bootstrap = createHostBootstrapRequest(profile);
    const capsuleDirectory = posixJoin(bootstrap.directories.capsules, subname);
    return {
        subname,
        domain: profile.domain,
        hostedUrl: `${profile.scheme}://${subname}.${profile.domain}`,
        remoteCapsuleId: `${profile.domain}/${subname}`,
        registryRecord: posixJoin(bootstrap.directories.registry, "capsules", `${subname}.json`),
        directories: {
            capsule: capsuleDirectory,
            releases: posixJoin(capsuleDirectory, "releases"),
            data: posixJoin(capsuleDirectory, "data"),
        },
        routes: {
            removed: {
                hostname: `${subname}.${profile.domain}`,
                target: "removed",
                routeFile: posixJoin(bootstrap.directories.caddyHosts, profile.domain, `${subname}.caddy`),
            },
        },
    };
}
function createHostedContainerName(domain, subname) {
    return `sporades-${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${subname}`;
}
function normaliseHostTls(value = {}) {
    const mode = typeof value?.mode === "string" && HOST_TLS_MODES.has(value.mode) ? value.mode : DEFAULT_HOST_TLS_MODE;
    return { mode };
}
function posixJoin(...segments) {
    return segments
        .map((segment, index) => {
        const value = String(segment);
        if (index === 0) {
            return value.replace(/\/+$/g, "");
        }
        return value.replace(/^\/+|\/+$/g, "");
    })
        .filter(Boolean)
        .join("/");
}
//# sourceMappingURL=host-request-builders.js.map