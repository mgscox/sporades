/** Escape text for HTML text nodes and quoted attribute values. Nullish values are empty. */
export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
}
// Capsule handlers and the runtime are bundled separately. A symbol-keyed data
// property survives that boundary, while JSON/user input cannot supply it.
const fragmentKey = Symbol.for("sporades.html.fragment");
/** Internal recognition never executes a caller-supplied getter or toString method. */
export function htmlString(value) {
    if (value === null || typeof value !== "object")
        return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, fragmentKey);
    return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}
function fragment(value) {
    const result = Object.freeze(Object.defineProperty({ toString: () => value }, fragmentKey, { value }));
    return result;
}
function interpolation(value) {
    if (Array.isArray(value))
        return value.map(interpolation).join("");
    return htmlString(value) ?? escapeHtml(value);
}
/** Escape every interpolation; nested fragments and arrays compose without double escaping. */
export function html(strings, ...values) {
    return fragment(strings.reduce((result, part, index) => result + part +
        (index < values.length ? interpolation(values[index]) : ""), ""));
}
(function (html) {
    /** Explicitly trust HTML supplied by Capsule code. Never pass untrusted input. */
    function raw(trusted) {
        return fragment(String(trusted));
    }
    html.raw = raw;
})(html || (html = {}));
//# sourceMappingURL=html.js.map