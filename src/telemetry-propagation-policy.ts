/** Operator policy is a bounded list of exact HTTP origins, never URL patterns. */
export function validateTracePropagationOrigins(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid trace propagation origins.");
  return [...new Set(value.map((entry) => {
    if (typeof entry !== "string" || entry.length > 2048 || !/^https?:\/\/[^/?#]+\/?$/i.test(entry) || /[\s\\*]/.test(entry)) throw new Error("Invalid trace propagation origins.");
    let url: URL;
    try { url = new URL(entry); } catch { throw new Error("Invalid trace propagation origins."); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.hostname.includes("*") || url.username || url.password || url.pathname !== "/" || url.search || url.hash || entry.includes("?") || entry.includes("#")) throw new Error("Invalid trace propagation origins.");
    return url.origin;
  }))];
}
