import { readSqlQuotedIdentifier, skipSqlTrivia } from "./inspection-sql.js";
// The internal log-index guard: what keeps `sporades db query` from reading or describing
// `sporades_log_events`, the table the runtime's own log index lives in.
//
// **Why this is a module beside `inspection-sql` rather than part of it.** Both run on the
// `runReadOnlyInspectionQuery` path, one immediately after the other, and this file lexes SQL with
// that module's tokenizer — so merging the two would collapse the last cross-module call on this
// path and would have been the smaller change. It is deliberately not taken, because ADR-0038 is a
// document about what the read-only inspection gate is a boundary *by*, and this is not one of
// those things:
//
//   - The gate answers *may this statement run at all*, from three rules over statement shape,
//     statement count and lexing agreement. Its refusals are a security boundary and its ADR spends
//     most of its length on why the obvious fourth rule cannot be one.
//   - This guard answers *is this statement about a table an operator has a better tool for*, and
//     its refusal hands the operator `sporades logs --json`. Nothing about a Capsule's security
//     rests on it: the log index holds the Capsule's own log events, already redacted, and every
//     statement that reaches this guard has already been admitted by the gate.
//
// Putting the second inside the first would invite the next reader to take it for a fourth rule of
// the gate — the exact mistake ADR-0038 was written to stop — and `isInternalLogIndexMetadataRow`
// below does not lex SQL at all; it filters result rows, which is not a thing a module named
// `inspection-sql` should be holding. The seam the two share is narrow, named, and in the direction
// a seam should run: a policy guard borrowing a lexer, never the reverse.
//
// What the split *did* resolve is the seam ADR-0041 flagged. Before this file existed,
// `server-runtime-source.ts` — 13,700 lines of unrelated domains — imported `skipSqlTrivia` and
// `readSqlQuotedIdentifier` out of the inspection gate, so the gate's tokenizer was reachable from
// anywhere in the monolith. Those two names now have exactly one consumer, and it is this file.
// What `server-runtime-source.ts` still imports from `inspection-sql` is the gate's actual
// interface: `validateReadOnlyInspectionSql` and `sqlWithoutTrailingTerminator`.
//
// **How this file reaches a deployed Capsule.** It is imported, and esbuild carries it whole with
// everything it references (ADR-0041). A name that fails to travel out of this file is a compile
// error, not a `ReferenceError` in a deployed Capsule.
//
// This file was the reason the deleted emitted-list builder had to change how it carried a migrated
// module, and the finding is worth keeping even though that builder is gone: `transformSync`
// converts one already-compiled file and resolves nothing, so given a module with an import of its
// own it emits a `require(…)`, and a Capsule spliced together from that dies at boot with "Cannot
// determine intended module format". Anything that assembles ES module text has the same problem.
// Whether an admitted inspection statement names the runtime's internal log-index table.
//
// The scan is deliberately loose: every keyword that can precede a table reference, then a table
// reference read at each of them, and a hit anywhere is a refusal. It is a concealment rule rather
// than a security boundary, so over-refusing an operator's query costs a hint pointing at
// `sporades logs` and under-refusing costs nothing a `SELECT` could not already do.
export function targetsInternalLogIndexTable(sql) {
    const text = String(sql);
    const targetKeywords = /\b(?:from|join|update|into|table)\b/gi;
    let match;
    while ((match = targetKeywords.exec(text))) {
        const reference = readSqlTableReference(text, match.index + match[0].length);
        if (reference.some((part) => part.toLowerCase() === "sporades_log_events")) {
            return true;
        }
    }
    return false;
}
// A dotted table reference — `schema.table`, `"main"."sporades_log_events"` — read from `startIndex`
// with the inspection gate's trivia skipper, so that a comment or a quoted run between the keyword
// and the name is stepped over the same way every other walk on this path steps over it.
//
// Exported with no caller outside this file, for the reason `inspection-sql`'s header gives for the
// same shape: `scripts/inspection-lexing-differential.mjs` compares this walk against the pre-work
// base build and reaches it as a value. Private, that comparison would report "absent from one
// build — not comparable" and keep running, which is a silent loss of the coverage the differential
// exists for.
export function readSqlTableReference(sql, startIndex) {
    let index = skipSqlTrivia(sql, startIndex, true);
    while (sql[index] === "(") {
        index += 1;
        index = skipSqlTrivia(sql, index, true);
    }
    const parts = [];
    while (index < sql.length) {
        const identifier = readSqlIdentifier(sql, index);
        if (!identifier) {
            break;
        }
        parts.push(identifier.value);
        index = skipSqlTrivia(sql, identifier.nextIndex, true);
        if (sql[index] !== ".") {
            break;
        }
        index = skipSqlTrivia(sql, index + 1, true);
    }
    return parts;
}
// The table-reference reader's identifier reader. It recognises `'` as well, because SQLite accepts
// a single-quoted string where a table name is expected and `targetsInternalLogIndexTable` has to
// see through that spelling too.
//
// Private, and it is the one name here that could be: nothing calls it as a value from outside, and
// the walker census in `test/database-adapter-engine-seam.test.js` still covers it, because that
// census reads the functions this module *declares* out of its compiled source text rather than the
// names it exports. Privacy is not a way out of that guard, which is the property ADR-0041 records
// being measured rather than assumed.
function readSqlIdentifier(sql, index) {
    return readSqlQuotedIdentifier(sql, index, "'\"`[");
}
// The other half of the guard, and the half that is not SQL lexing: an admitted statement can reach
// the log-index table's *name* without naming the table — `SELECT name FROM sqlite_schema` — so the
// rows an admitted statement returns are filtered too.
export function isInternalLogIndexMetadataRow(row, sql = "") {
    const queriesSqliteSchema = /\bsqlite_(?:schema|master)\b/i.test(String(sql));
    return (["name", "tbl_name", "table", "tableName"].some((key) => row?.[key] === "sporades_log_events") ||
        Object.values(row ?? {}).some((value) => typeof value === "string" &&
            (/\bcreate\s+table\b[\s\S]*\bsporades_log_events\b/i.test(value) ||
                (queriesSqliteSchema && /\bsporades_log_events\b/i.test(value)))));
}
//# sourceMappingURL=log-index-guard.js.map