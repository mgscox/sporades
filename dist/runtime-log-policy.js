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
//# sourceMappingURL=runtime-log-policy.js.map