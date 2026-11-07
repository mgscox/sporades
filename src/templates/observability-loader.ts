import { exceptionFrames } from "../exception-stack.js";
import { expectedDiagnosticErrorCodes } from "../runtime-errors.js";

/** First-party browser source. Provider identities and Server env never enter this script. */
export function collectionLoaderSource(errors: boolean, analytics: boolean) {
  return `(${collectionLoader.toString()})(${JSON.stringify({ errors, analytics, expectedErrorCodes: expectedDiagnosticErrorCodes })}, ${exceptionFrames.toString()});`;
}

// This function is serialized, never called in Node. Keep it self-contained.
function collectionLoader(options: { errors: boolean; analytics: boolean; expectedErrorCodes: string[] }, parseFrames: typeof exceptionFrames) {
  // DOM types are deliberately local: the server runtime graph is checked without DOM globals.
  const browser = (globalThis as any).window;
  if (!browser || browser.__sporadesCollectionInstalled) return;
  browser.__sporadesCollectionInstalled = true;
  const clean = (value: string) => { try { if (!value) return ""; const url = new browser.URL(value, browser.location.origin); return ["http:", "https:", "file:"].includes(url.protocol) ? (url.protocol === "file:" ? "file://" : url.origin) + url.pathname : ""; } catch { return ""; } };
  const send = (event: any) => { try { browser.fetch("/__sporades/collect", { method: "POST", credentials: "omit", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify(event) }).catch(() => {}); } catch {} };
  let count = 0, start = Date.now();
  const error = (value: any, location?: any) => {
    try {
      if ((value?.name === undefined && typeof value?.stack !== "string" && typeof value?.eventId === "string" && /^[a-f0-9]{32}$/.test(value.eventId)) || value?.sporadesSource === "server" || options.expectedErrorCodes.includes(value?.code)) return;
      if (Date.now() - start > 60000) { start = Date.now(); count = 0; }
      if (++count > 20) return;
      let stackBudget = 8192, messageBudget = 2048;
      const reduce = (item: any) => {
        // Parse before transport reduction so embedded source never enters the request.
        const lines = parseFrames(item?.stack).reverse().map(frame => `    at ${frame.function} (${frame.filename}:${frame.lineno}:${frame.colno})`);
        let stack = "";
        for (const line of lines) {
          if (line.length + 1 > stackBudget) break;
          stack += line + "\n"; stackBudget -= line.length + 1;
        }
        const message = String(item?.message ?? (item !== null && typeof item === "object" ? "Non-Error exception" : item ?? "Client error")).slice(0, messageBudget).replace(/data:[^\s)]+/gi, "[embedded source]");
        messageBudget -= message.length;
        return { name: typeof item?.name === "string" ? item.name.slice(0, 64) : typeof item === "object" ? "Error" : "NonError", message, stack: stack || undefined };
      };
      const result = reduce(value), causes = [], seen = new Set([value]);
      let current = value;
      for (let depth = 0; depth < 3 && current?.cause !== undefined && !seen.has(current.cause); depth++) {
        current = current.cause; seen.add(current); causes.push(reduce(current));
      }
      send({ type: "error", ...result, causes, ...(!result.stack && location ? { location } : {}) });
    } catch {}
  };
  if (options.errors) {
    browser.addEventListener("error", (event: any) => error(event.error ?? event.message, {
      filename: clean(event.filename), lineno: event.lineno, colno: event.colno,
    }));
    browser.addEventListener("unhandledrejection", (event: any) => error(event.reason));
    browser.addEventListener("sporades:error", (event: any) => error(event.detail));
  }
  if (options.analytics) {
    let last = "";
    const pageview = () => {
      if (last === browser.location.href) return;
      last = browser.location.href;
      send({ type: "pageview", url: clean(browser.location.href), referrer: clean(browser.document.referrer) });
    };
    for (const name of ["pushState", "replaceState"]) {
      const original = browser.history[name];
      browser.history[name] = function (...args: any[]) { const result = original.apply(this, args); pageview(); return result; };
    }
    browser.addEventListener("popstate", pageview);
    browser.addEventListener("hashchange", pageview);
    pageview();
  }
}
