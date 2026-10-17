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

// The monolith's own alias, redeclared rather than imported: it is a type, so it is erased before
// either bundle is built and there is no binding to collide with.
type LooseRecord = Record<string, any>;

export function logIndexLimit(config: LooseRecord = {}) {
  const configured = Number(config.logs?.indexLimit ?? config.logging?.indexLimit);
  return Number.isInteger(configured) && configured > 0 ? configured : 500;
}

export function isSensitiveLogKey(key: string) {
  return (
    /(^|[-_])(?:password|passwd|token|secret|authorization|cookie|client[-_]?secret|api[-_]?token|private[-_]?key|authorized[-_]?keys?|request[-_]?body|raw[-_]?body|stack(?:trace)?)([-_]|$)/i.test(String(key)) ||
    /(?:password|passwd|token|secret|authorization|cookie|clientSecret|apiToken|privateKey|authorizedKeys|requestBody|rawRequestBody|stackTrace)/i.test(String(key))
  );
}

// Structured credentials are one private value, including nested containers and
// quoted delimiters. A malformed or truncated container conceals the remainder.
function structuredCredentialEnd(text: string, start: number) {
  const closers: string[] = [];
  let quote = "";
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[") closers.push("]");
    else if (char === "{") closers.push("}");
    else if (char === "]" || char === "}") {
      if (closers.pop() !== char) return text.length;
      if (!closers.length) return index + 1;
    }
  }
  return text.length;
}

/** Shared diagnostic text policy. Stack frames are admitted separately by error collection. */
export function redactDiagnosticText(value: string, serverEnv: LooseRecord = {}) {
  let safe = value;
  for (const secret of Object.values(serverEnv)) {
    if (typeof secret === "string" && secret.length > 0) safe = safe.split(secret).join("[REDACTED]");
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-[^\s]+)\s+[A-Za-z0-9+/=]{32,}/.test(safe)) return "[REDACTED]";
  // Unquoted headers can contain spaces and several cookies. Conceal the entire line.
  // Quoted headers are handled below, where their closing quote bounds the value.
  safe = safe.replace(/\b(?:authorization|cookie)\s*[:=](?![ \t]*["'])[^\r\n]*/gi, "[REDACTED]");
  // Scan keys separately so an outer non-sensitive field cannot hide a nested credential.
  let redacted = "", cursor = 0;
  for (const match of safe.matchAll(/(["']?)([\w-]+)\1\s*[:=]\s*/g)) {
    if (match.index < cursor || !(isSensitiveLogKey(match[2]) || /^(?:api[_-]?key|request)$/i.test(match[2]))) continue;
    const start = match.index + match[0].length;
    // Admit escaped quotes and spaces, and conceal an unterminated value to the line end.
    const value = safe.slice(start).match(/^(?:"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|(?=\r?$))|'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|(?=\r?$))|[^\s,;]+)/m);
    redacted += safe.slice(cursor, match.index) + "[REDACTED]";
    cursor = safe[start] === "[" || safe[start] === "{"
      ? structuredCredentialEnd(safe, start)
      : start + (value?.[0].length ?? 0);
  }
  safe = (redacted + safe.slice(cursor)).replace(/\b(?:Basic|Bearer)\s+[^\s,;"']+/gi, "[REDACTED]");
  // Only URL suffixes are private. A question or issue number in ordinary prose is data.
  // Quoted query values travel with the URL, so their contents cannot survive stripping.
  return safe.replace(/((?:https?:\/\/|file:\/\/\/|(?:^|[\s("'])(?:\/{1,2}|\.\.?\/))[^\s?#<>"']*)([?#](?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s<>"'])*)/gi,
    (_match, path: string, suffix: string) => path + (suffix.slice(1).replaceAll("[REDACTED]", "").match(/[),.;:!?\]}]+$/)?.[0] ?? ""))
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
