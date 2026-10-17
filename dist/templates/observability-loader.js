import { expectedDiagnosticErrorCodes } from "../runtime-errors.js";
/** First-party browser source. Provider identities and Server env never enter this script. */
export function collectionLoaderSource(errors, analytics) {
    return `(${collectionLoader.toString()})(${JSON.stringify({ errors, analytics, expectedErrorCodes: expectedDiagnosticErrorCodes })});`;
}
// This function is serialized, never called in Node. Keep it self-contained.
function collectionLoader(options) {
    // DOM types are deliberately local: the server runtime graph is checked without DOM globals.
    const browser = globalThis.window;
    if (!browser || browser.__sporadesCollectionInstalled)
        return;
    browser.__sporadesCollectionInstalled = true;
    const clean = (value) => { try {
        if (!value)
            return "";
        const url = new browser.URL(value, browser.location.origin);
        return url.origin + url.pathname;
    }
    catch {
        return "";
    } };
    const send = (event) => { try {
        browser.fetch("/__sporades/collect", { method: "POST", credentials: "omit", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify(event) }).catch(() => { });
    }
    catch { } };
    let count = 0, start = Date.now();
    const error = (value) => {
        try {
            if (options.expectedErrorCodes.includes(value?.code))
                return;
            if (Date.now() - start > 60000) {
                start = Date.now();
                count = 0;
            }
            if (++count > 20)
                return;
            send({ type: "error", message: String(value?.message ?? value ?? "Client error").slice(0, 2048), stack: typeof value?.stack === "string" ? value.stack.slice(0, 8192) : undefined });
        }
        catch { }
    };
    if (options.errors) {
        browser.addEventListener("error", (event) => error(event.error ?? event.message));
        browser.addEventListener("unhandledrejection", (event) => error(event.reason));
        browser.addEventListener("sporades:error", (event) => error(event.detail));
    }
    if (options.analytics) {
        let last = "";
        const pageview = () => {
            if (last === browser.location.href)
                return;
            last = browser.location.href;
            send({ type: "pageview", url: clean(browser.location.href), referrer: clean(browser.document.referrer) });
        };
        for (const name of ["pushState", "replaceState"]) {
            const original = browser.history[name];
            browser.history[name] = function (...args) { const result = original.apply(this, args); pageview(); return result; };
        }
        browser.addEventListener("popstate", pageview);
        browser.addEventListener("hashchange", pageview);
        pageview();
    }
}
//# sourceMappingURL=observability-loader.js.map