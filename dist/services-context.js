import { inspect } from "node:util";
const hidden = { toJSON: { value: () => undefined }, [inspect.custom]: { value: () => "[Capsule services]" } };
function opaqueFreeze(value) { Object.defineProperties(value, hidden); return Object.freeze(value); }
/** Launch plumbing only: declarations cannot supply URLs or credential values. */
export function createTrustedServices(config, serviceEnv = {}) {
    const declarations = Object.entries(config.services ?? {}).filter(([, s]) => s?.kind === "container");
    const result = Object.create(null);
    if (!declarations.length)
        return opaqueFreeze(result);
    const fail = () => { throw new Error("Capsule service connections are unavailable or invalid."); };
    const raw = serviceEnv.SPORADES_CONTAINER_SERVICES;
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 131072)
        return fail();
    let values;
    try {
        values = JSON.parse(raw);
    }
    catch {
        return fail();
    }
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length !== declarations.length)
        return fail();
    for (const [name, declaration] of declarations) {
        if (!/^[a-z][a-z0-9-]{0,30}$/.test(name) || !Object.hasOwn(values, name))
            return fail();
        const value = values[name];
        if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "secrets,url" || typeof value.url !== "string" || !value.secrets || typeof value.secrets !== "object" || Array.isArray(value.secrets))
            return fail();
        let url;
        try {
            url = new URL(value.url);
        }
        catch {
            return fail();
        }
        const session = config.__sporadesSession;
        const local = session === "dev" || session === "public-dev" || session === undefined;
        const generatedName = `sporades-${String(config.name ?? "capsule").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "capsule"}-${name}`;
        const hostNetwork = declaration.compose?.network_mode === "host";
        const addressAllowed = local ? url.hostname === "127.0.0.1" && (!hostNetwork || Number(url.port || 80) === declaration.port)
            : url.hostname === (hostNetwork ? "host.docker.internal" : generatedName) && Number(url.port || 80) === declaration.port;
        if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !addressAllowed || (local && Number(url.port || 80) < 1))
            return fail();
        const expected = [...new Set(Object.values(declaration.env ?? {}).filter(v => v && typeof v === "object" && typeof v.generated === "string").map(v => v.generated))].sort();
        if (Object.keys(value.secrets).sort().join(",") !== expected.join(","))
            return fail();
        const secrets = Object.create(null);
        for (const key of expected) {
            if (typeof value.secrets[key] !== "string" || !/^[a-f0-9]{64}$/.test(value.secrets[key]))
                return fail();
            secrets[key] = value.secrets[key];
        }
        result[name] = opaqueFreeze({ url: url.origin, secrets: opaqueFreeze(secrets) });
    }
    return opaqueFreeze(result);
}
export function bindServicesContext(context, services) {
    Object.defineProperty(context, "services", { value: services, writable: false, configurable: false, enumerable: false });
    return context;
}
/** Redaction values are a separate sink input, never a ctx.env addition. */
export function serviceRedactionValues(services) {
    return Object.fromEntries(Object.entries(services).flatMap(([name, service]) => service ? [[`service.${name}.url`, service.url], ...Object.entries(service.secrets).map(([key, value]) => [`service.${name}.${key}`, value])] : []));
}
//# sourceMappingURL=services-context.js.map