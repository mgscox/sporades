// Two policy questions the runtime's logging asks and other domains ask too: **is this key's name
// one whose value must never be written down**, and **how many events does the log index keep**.
//
// **This is not a domain, and it is here for the reason `runtime-errors.ts` and `maybe-promise.ts`
// are.** These are things several parts of the runtime need and none owns. Closing the ACL and
// privileged-audit domain's reference graph (batch 7 of the migration ADR-0041 records) leaves five
// things outside it. Two are the composition core's and are ticket 05's. These two belong to no
// batch on that ticket's list at all — the logging subsystem is on nobody's list, so waiting for it
// is waiting for a batch that will never run, which is the third case batch 6 added to batch 4's
// rule:
//
//   isSensitiveLogKey   the log redactor, and `aclVisibleFieldNames` in the ACL denial record
//   logIndexLimit       the log sink, and the privileged-audit reindex after a rollback
//
// A migrated module may not import from the monolith, so what each held is what makes this a module
// rather than a shrug. `isSensitiveLogKey` held `aclVisibleFieldNames`, and through it
// `aclRowLogSnapshot`, `createAclDenialLogData`, `emitAclDeniedLog` and all three ACL enforcement
// entry points — `runTableWriteWithAcl`, `applyReadAcl` and `filterRowsByReadAcl`. `logIndexLimit`
// held `reindexPrivilegedAuditEventsAfterRollback` and the two functions under it, which is the
// path that puts a privileged audit event back into the log index when the transaction that emitted
// it rolled back. Left behind, the pair would have cut the domain in half for two leaf functions
// totalling nine lines.
//
// **What they have in common is the subject, not the mechanism.** Both answer a question about what
// the platform log is allowed to contain — one about a field, one about a depth — and both are read
// from outside the log sink as well as inside it. Named for that rather than folded into an
// existing shared module: `runtime-errors.ts` is named for errors, `maybe-promise.ts` for the
// sync/async bridge, and `log-index-guard.ts` for the rule that conceals `sporades_log_events` from
// `sporades db query`, which its own header is careful to distinguish from anything else about the
// log index. None of the three describes a log policy, and a file whose name stops describing its
// contents is a cost paid by every later reader.
//
// **Nothing is redesigned.** Both bodies are byte-identical to the declarations that stood at
// `server-runtime-source.ts:2980` and `:3638`, and every call site in the repository is untouched:
// `createRuntimeLogSink` and `redactLogData` are still in the monolith and import them back.
//
// Both are exported, because the monolith resolves both, so this module has no private function and
// its census sentinel in `test/database-adapter-engine-seam.test.js` is `isSensitiveLogKey` — an
// exported one, as `mail-config.js`'s and `maybe-promise.js`'s are. It is the right choice for the
// reason those are: it is the only thing in this runtime that decides which field names are
// sensitive, so no honest edit to this file removes it.
export function logIndexLimit(config = {}) {
    const configured = Number(config.logs?.indexLimit ?? config.logging?.indexLimit);
    return Number.isInteger(configured) && configured > 0 ? configured : 500;
}
export function isSensitiveLogKey(key) {
    return (/(^|[-_])(?:password|passwd|token|secret|authorization|cookie|client[-_]?secret|api[-_]?token|private[-_]?key|authorized[-_]?keys?|request[-_]?body|raw[-_]?body|stack(?:trace)?)([-_]|$)/i.test(String(key)) ||
        /(?:password|passwd|token|secret|authorization|cookie|clientSecret|apiToken|privateKey|authorizedKeys|requestBody|rawRequestBody|stackTrace)/i.test(String(key)));
}
// Structured credentials are one private value, including nested containers and
// quoted delimiters. A malformed or truncated container conceals the remainder.
function structuredCredentialEnd(text, start) {
    const closers = [];
    let quote = "", quoteSlashes = 0;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (char === "\\") {
            let end = index;
            while (text[end] === "\\")
                end++;
            const slashes = end - index;
            // A container can itself be serialized inside a JSON diagnostic string.
            // Match that quotation layer exactly; its escaped data quotes are deeper.
            if (quoteSlashes) {
                if (slashes % (2 * (quoteSlashes + 1)) === quoteSlashes && text[end] === quote) {
                    quote = "";
                    quoteSlashes = 0;
                }
            }
            else if (!quote && /["'`]/.test(text[end] ?? "")) {
                quote = text[end];
                quoteSlashes = slashes;
            }
            index = quote && !quoteSlashes && slashes % 2 === 0 ? end - 1 : end;
            continue;
        }
        if (quote) {
            if (!quoteSlashes && char === quote)
                quote = "";
        }
        else if (char === '"' || char === "'" || char === "`")
            quote = char;
        else if (char === "[")
            closers.push("]");
        else if (char === "{")
            closers.push("}");
        else if (char === "]" || char === "}") {
            if (closers.pop() !== char)
                return text.length;
            if (!closers.length)
                return index + 1;
        }
    }
    return text.length;
}
const diagnosticUrlClosers = { "[": "]", "(": ")", "{": "}", "<": ">" };
// Resolve value quotation before considering URL-looking text as another field.
// Return the position after the closing delimiter; missing/ambiguous closure
// leaves the entire candidate private. Word apostrophes are never closers.
function diagnosticValueEnd(text, start, limit, escaped, outerQuote = "", wrappers = 0) {
    const quote = text[start + (escaped ? 1 : 0)];
    const width = escaped ? 2 : 1;
    let closing = -1, previous = -1;
    for (let index = start + width; index < limit; index++) {
        if (text[index] === "\\") {
            if (escaped && text[index + 1] === quote) {
                previous = closing;
                closing = index;
                index++;
            }
            else
                index++;
        }
        else if (!escaped && text[index] === quote) {
            previous = closing;
            closing = index;
        }
    }
    if (closing < 0)
        return undefined;
    // Reserve the last matching quote for the enclosing string. This also
    // prevents an unterminated value from borrowing its wrapper as a closer.
    if (!escaped && quote === outerQuote) {
        closing = previous;
        if (closing < 0)
            return undefined;
        while (wrappers-- > 1 && closing > start && text[closing - 1] === quote)
            closing--;
    }
    const after = text.slice(closing + width, limit);
    if (!/^[ \t]*(?:[&#=]|%(?:26|23|3[fd])|$)/i.test(after)
        && !(outerQuote && after.startsWith(outerQuote)))
        return undefined;
    return closing + width;
}
// An undefined end means quotation/container state is still open or ambiguous.
// Such a prefix cannot establish a boundary merely because another URL follows.
function diagnosticUrlContainerEnd(text, start, suffix, limit, boundary = true) {
    const opener = text[start - 1];
    const closer = diagnosticUrlClosers[opener] ?? opener;
    const wrapped = !!closer && "\"'`])}>".includes(closer);
    if (wrapped) {
        let closing = -1, valueStart = true, wrappers = 1;
        while (text[start - wrappers - 1] === opener)
            wrappers++;
        for (let index = suffix; index < limit; index++) {
            const char = text[index];
            // Inner containers own their quotes, delimiters, and URL-looking text.
            // Resolve the complete container before accepting any enclosing boundary.
            if (char === "[" || char === "{") {
                const end = structuredCredentialEnd(text, index);
                if (end > limit)
                    return undefined;
                index = end - 1;
                valueStart = false;
                continue;
            }
            if (char === "\\") {
                index++;
                continue;
            }
            if (valueStart && /["'`]/.test(char)) {
                const end = diagnosticValueEnd(text, index, limit, false, closer, wrappers);
                if (end === undefined)
                    return undefined;
                // A same-quote value cannot borrow its enclosing string's only
                // closer to establish a separate field. Both layers must be closed.
                index = end - 1;
                valueStart = false;
                continue;
            }
            if (!/\s/.test(char))
                valueStart = /[=?#&]/.test(char);
            if (char !== closer)
                continue;
            const after = text.slice(index + 1, limit);
            // A real following JSON field is outside the enclosing URL string.
            if (closer === '"' && /^[ \t]*(?:[}\]]|,[ \t]*"(?:\\.|[^"\\])*"[ \t]*:)/.test(after))
                return index;
            closing = /^["'`]*[),.;:!?\]}]*?(?:\s|$)/.test(after) ? index : -1;
        }
        if (closing < 0 || /["'`&#=]|%(?:26|23|3[fd])/i.test(text.slice(closing + 1, limit)))
            return undefined;
        while (wrappers-- > 1 && closing > suffix && text[closing - 1] === closer)
            closing--;
        return closing;
    }
    let valueStart = true, proseBoundary = -1;
    for (let index = suffix; index < limit; index++) {
        const char = text[index];
        const escaped = char === "\\" && /["'`]/.test(text[index + 1] ?? "");
        if (escaped || /["'`]/.test(char)) {
            if (!valueStart)
                return undefined;
            const end = diagnosticValueEnd(text, index, limit, escaped);
            if (end === undefined || (boundary && !text.slice(end, limit).trim()))
                return undefined;
            index = end - 1;
            valueStart = false;
        }
        else if (char === "[" || char === "{") {
            const end = structuredCredentialEnd(text, index);
            if (end > limit)
                return undefined;
            index = end - 1;
            valueStart = false;
        }
        else if (/\s/.test(char)) {
            if (!valueStart && proseBoundary < 0)
                proseBoundary = index;
        }
        else {
            if (/[<>]/.test(char))
                return undefined;
            if (/[=?#&]/.test(char))
                proseBoundary = -1;
            valueStart = /[=?#&]/.test(char);
        }
    }
    if (valueStart)
        return undefined;
    return proseBoundary < 0 ? limit : proseBoundary;
}
// A URL's private suffix belongs to its lexical container. Candidate URL fields
// are accepted only after the quotation/container scan proves the prefix closed.
// Nested URLs in open values remain private, including escaped JSON quotation.
function diagnosticUrlEnd(text, start, suffix) {
    const newline = text.slice(suffix).search(/[\r\n]/);
    const lineEnd = newline < 0 ? text.length : suffix + newline;
    const line = text.slice(suffix, lineEnd);
    for (const match of line.matchAll(/[ \t]+\S*?(?:[a-z][a-z\d+.-]*:\/\/|(?<![\p{L}\p{M}\p{N}])(?:\/{1,2}|\.\.?\/))/giu)) {
        const end = diagnosticUrlContainerEnd(text, start, suffix, suffix + match.index);
        if (end !== undefined)
            return end;
    }
    // With no proven separate field, inspect the complete line for the outer
    // container's end. Nested URL syntax never bounds this final extent.
    return diagnosticUrlContainerEnd(text, start, suffix, lineEnd, false) ?? lineEnd;
}
function stripDiagnosticUrlSuffixes(text) {
    let redacted = "", cursor = 0;
    // Identify URL syntax on the original diagnostic before any substitutions.
    // Scheme URLs and all explicit relative forms work beside quotes/punctuation.
    for (const match of text.matchAll(/((?:[a-z][a-z\d+.-]*:\/\/|(?<![\p{L}\p{M}\p{N}])(?:\/{1,2}|\.\.?\/))[^\s?#<>"`]*?)([?#]|%3f|%23)/giu)) {
        if (match.index < cursor)
            continue;
        const suffix = match.index + match[1].length;
        const end = diagnosticUrlEnd(text, match.index, suffix + match[2].length);
        // Retain ordinary trailing punctuation only for unambiguous bare tokens.
        const punctuation = (end === text.length || /\s/.test(text[end]))
            && !/["'`]/.test(text.slice(suffix, end))
            ? text.slice(suffix, end).match(/[),.;:!?\]}]+$/)?.[0] ?? "" : "";
        redacted += text.slice(cursor, suffix) + punctuation;
        cursor = end;
    }
    return redacted + text.slice(cursor);
}
/** Shared diagnostic text policy. Stack frames are admitted separately by error collection. */
export function redactDiagnosticText(value, serverEnv = {}) {
    // URL syntax must survive until suffix stripping. In particular, an env
    // value such as https://example.test/ must not hide the start of a URL.
    let safe = stripDiagnosticUrlSuffixes(value)
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
    for (const secret of Object.values(serverEnv)) {
        if (typeof secret !== "string" || !secret.length)
            continue;
        safe = safe.split(secret).join("[REDACTED]");
        // A complete URL-valued secret may itself have lost a private suffix.
        // Conceal its surviving form as well as its original bytes.
        const stripped = stripDiagnosticUrlSuffixes(secret)
            .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
        if (stripped && stripped !== secret)
            safe = safe.split(stripped).join("[REDACTED]");
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-[^\s]+)\s+[A-Za-z0-9+/=]{32,}/.test(safe))
        return "[REDACTED]";
    // Unquoted headers can contain spaces and several cookies. Conceal the entire line.
    // Quoted headers are handled below, where their closing quote bounds the value.
    safe = safe.replace(/\b(?:authorization|cookie)\s*[:=](?![ \t]*["'])[^\r\n]*/gi, "[REDACTED]");
    // Scan keys separately so an outer non-sensitive field cannot hide a nested credential.
    let redacted = "", cursor = 0;
    for (const match of safe.matchAll(/(["']?)([\w-]+)\1\s*[:=]\s*/g)) {
        if (match.index < cursor || !(isSensitiveLogKey(match[2]) || /^(?:api[_-]?key|request)$/i.test(match[2])))
            continue;
        const start = match.index + match[0].length;
        // Admit escaped quotes and spaces, and conceal an unterminated value to the line end.
        const value = safe.slice(start).match(/^(?:"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|(?=\r?$))|'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|(?=\r?$))|[^\s,;]+)/m);
        redacted += safe.slice(cursor, match.index) + "[REDACTED]";
        cursor = safe[start] === "[" || safe[start] === "{"
            ? structuredCredentialEnd(safe, start)
            : start + (value?.[0].length ?? 0);
    }
    safe = (redacted + safe.slice(cursor)).replace(/\b(?:Basic|Bearer)\s+[^\s,;"']+/gi, "[REDACTED]");
    return safe;
}
//# sourceMappingURL=runtime-log-policy.js.map