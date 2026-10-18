/** Preserve runtime-owned app identity even when a callback context stays mutable. */
export function bindAppContext<Context extends object, App>(context: Context, app: App): Context & { readonly app: App } {
  Object.defineProperty(context, "app", { value: app, enumerable: true, writable: false, configurable: false });
  return context as Context & { readonly app: App };
}

/** Public link authority comes only from launch/project configuration, never HTTP headers. */
export function normalizePublicOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\\\s]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || value.includes("?") || value.includes("#")) return null;
    return url.origin;
  } catch { return null; }
}

export function resolvePublicOrigin(config: any): string {
  const session = config?.__sporadesSession;
  const dev = session === "dev" || session === "public-dev";
  const configured = dev ? config?.__sporadesDevOrigin
    : session === "hosted" ? config?.__sporadesPublicOrigin
    : config?.deploy?.publicOrigin ?? config?.__sporadesPublicOrigin;
  const port = dev ? config?.dev?.port ?? config?.deploy?.port ?? 4000
    : config?.deploy?.port ?? (session ? 4000 : config?.dev?.port ?? 4000);
  return normalizePublicOrigin(configured) ?? `http://localhost:${port}`;
}

export function isLocalPublicOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname.toLowerCase();
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]"
    || hostname === "0.0.0.0" || /^127\./.test(hostname) || hostname === "[::]";
}
