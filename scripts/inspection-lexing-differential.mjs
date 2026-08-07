// Differential for the read-only inspection gate, alongside `scripts/inspection-lexing-sweep.mjs`.
//
// The sweep executes what the gate admits against live engines and answers "does anything admitted
// do something a SELECT cannot". This answers the two questions that sit either side of it and that
// a live sweep is the wrong instrument for:
//
//   1. **Is a refactor behaviour-preserving?** Not "does it still refuse the attacks" — that is the
//      sweep — but "does any input anywhere get a different verdict, a different refusal reason, or
//      a different statement handed to the engine". Compared against a second build.
//   2. **Is a realistic query newly refused?** The sweep's corpus is attack-shaped by construction
//      and structurally cannot answer this.
//
// It is committed for the reason ADR-0038 gives for the sweep being committed: the figures quoted
// in that ADR and in commit messages have to be reproducible by someone who does not trust them.
// Both baselines below are the *pre-work base*, never the previous revision — four consecutive
// rounds of this work compared each round against the one before it, correctly reported "0 newly
// admitted" every time, and were all wrong about the thing that mattered.
//
// Usage, where the baseline is a built tree at another commit:
//
//   git worktree add /tmp/base <base-sha> && (cd /tmp/base && npm ci && npm run build)
//   SPORADES_DIFFERENTIAL_BASELINE=/tmp/base/dist/server-runtime-source.js \
//     node scripts/inspection-lexing-differential.mjs
//
// SPORADES_DIFFERENTIAL_DEPTH lowers the corpus depth for a faster run. The adequacy assertions
// below will refuse a depth too small to express the shapes this gate has actually shipped, which
// is deliberate: a corpus that cannot emit the shape reports clean for the wrong reason, and that
// has happened to this work six times.

import { pathToFileURL } from "node:url";

const HERE = new URL(".", import.meta.url);
const current = await import(new URL("../dist/server-runtime-source.js", HERE).href);
const baselinePath = process.env.SPORADES_DIFFERENTIAL_BASELINE;
if (!baselinePath) {
  console.error("SPORADES_DIFFERENTIAL_BASELINE must point at a built dist/server-runtime-source.js to compare against.");
  process.exit(2);
}
const baseline = await import(pathToFileURL(baselinePath).href);

const MAX_DEPTH = Number(process.env.SPORADES_DIFFERENTIAL_DEPTH ?? 5);

// Two alphabets. The comment alphabet carries the shapes that defeated the block- and line-comment
// rules; the quoting alphabet carries every quoting form plus a backslash and a separator, because
// the collapse folded two token readers into one and those are the characters they disagree over.
const COMMENT_PIECES = ["/*", "*/", "/*/", "**/", "--", "\r", "\n", " ", " SELECT 1 "];
const QUOTING_PIECES = ["/*", "*/", "--", "\r", "\n", " ", "$$", "'", '"', "E'", "`", "[", "]", "\\", ";"];

// The verb appended, and the verb *surrounded*. A corpus that only appends cannot express a defect
// that is hidden by wrapping, which is how a regression stayed invisible to five corpora including
// a reviewer's.
const APPENDED = [
  (acc) => `${acc} TRUNCATE TABLE sporades_canary`,
  (acc) => `${acc} CREATE TABLE sporades_probe (id int)`,
  (acc) => `${acc}; DROP TABLE sporades_canary`,
  (acc) => `SELECT 1 AS s ${acc}`,
  (acc) => `PRAGMA table_info(t) ${acc}`,
];
const SURROUNDED = [
  (acc) => `SELECT $$a${acc}DROP TABLE sporades_canary;$$ AS s`,
  (acc) => `SELECT 'a${acc}DROP TABLE sporades_canary;' AS s`,
  (acc) => `SELECT $tag$a${acc}DROP TABLE sporades_canary;$tag$ AS s`,
  (acc) => `SELECT "a${acc}drop" AS s`,
  (acc) => `SELECT [a${acc}drop] AS s`,
  (acc) => `SELECT \`a${acc}drop\` AS s`,
  (acc) => `SELECT E'a${acc}DROP TABLE t;' AS s`,
  (acc) => `SELECT * FROM sporades_log_events ${acc}`,
];

const corpus = [];
const build = (pieces, maxDepth, shapes) => {
  const walk = (depth, acc) => {
    if (depth === 0) {
      for (const shape of shapes) corpus.push(shape(acc));
      return;
    }
    for (const piece of pieces) walk(depth - 1, acc + piece);
  };
  for (let depth = 1; depth <= maxDepth; depth += 1) walk(depth, "");
};
build(COMMENT_PIECES, MAX_DEPTH, APPENDED);
build(QUOTING_PIECES, Math.max(1, MAX_DEPTH - 1), SURROUNDED);

// Adequacy, before any result is believed. Each entry is a shape this gate has actually shipped a
// defect in, or a form the collapse touched.
//
// These pin *shapes*, not alphabets, and the difference is a real limit on them. Several shapes are
// supplied by the templates above rather than by the piece alphabets, so removing `\r` from
// `COMMENT_PIECES`, or `[` and `]` from `QUOTING_PIECES`, still reports all classes emitted while
// the corpus has become materially weaker. What they do catch is a depth too small to compose a
// shape — which is how three rounds of this work reported clean for the wrong reason. Widening an
// alphabet is not protected by them; check it by hand.
const MUST_EMIT = [
  ["a nesting block comment", (sql) => sql.startsWith("/*/* SELECT 1 */*/")],
  ["a `/*/` straddle", (sql) => sql.startsWith("/*/*/ SELECT 1 */*/")],
  ["a line comment closed by a bare CR", (sql) => /--[^\n]*\r/.test(sql)],
  ["a line comment composed with a block comment", (sql) => sql.includes("--") && sql.includes("\r") && sql.includes("/*")],
  ["a verb wrapped in a dollar quote", (sql) => /\$\$a.*DROP/s.test(sql)],
  ["a verb wrapped in a tagged dollar quote", (sql) => /\$tag\$a.*DROP/s.test(sql)],
  ["a verb wrapped in a dollar quote behind a CR-ended line comment", (sql) => /\$\$[^$]*--[^\n]*\r[^$]*\/\*/s.test(sql)],
  ["a verb inside a double-quoted identifier", (sql) => /"a.*drop"/s.test(sql)],
  ["a verb inside a bracket-quoted identifier", (sql) => /\[a.*drop\]/s.test(sql)],
  ["a verb inside a backtick-quoted identifier", (sql) => /`a.*drop`/s.test(sql)],
  ["an odd number of double quotes, so a run really is unterminated", (sql) => (sql.match(/"/g) ?? []).length % 2 === 1],
  ["a doubled quote inside an identifier", (sql) => /"a.*""/s.test(sql)],
  ["a backslash inside an E-string", (sql) => /E'a[^']*\\/s.test(sql)],
  ["a PRAGMA with trailing trivia", (sql) => sql.startsWith("PRAGMA table_info(t) ")],
  ["a log-index table reference", (sql) => sql.includes("sporades_log_events")],
];
for (const [description, matches] of MUST_EMIT) {
  const found = corpus.find(matches);
  if (!found) {
    throw new Error(`corpus cannot emit ${description} — this differential would be clean for the wrong reason`);
  }
}
console.log(`corpus: ${corpus.length} candidates, all ${MUST_EMIT.length} shape classes emitted`);

// 1. Behaviour preservation. The verdict is not enough on its own: a refusal reason that changed
// means a different limb refused, and a terminator strip that changed means different text reached
// the engine even where the verdict agreed.
let verdictDiffs = 0;
let reasonDiffs = 0;
let stripDiffs = 0;
let newlyAdmitted = 0;
let newlyRefused = 0;
const examples = [];
for (const sql of corpus) {
  const now = current.validateReadOnlyInspectionSql(sql);
  const then = baseline.validateReadOnlyInspectionSql(sql);
  if (now.ok !== then.ok) {
    verdictDiffs += 1;
    if (now.ok) newlyAdmitted += 1;
    else newlyRefused += 1;
    if (examples.length < 10) examples.push(["VERDICT", sql, then.ok, now.ok]);
  } else if (!now.ok && now.error.message !== then.error.message) {
    reasonDiffs += 1;
    if (examples.length < 10) examples.push(["REASON", sql, then.error.message, now.error.message]);
  }
  const nowStrip = current.sqlWithoutTrailingTerminator(sql);
  const thenStrip = baseline.sqlWithoutTrailingTerminator(sql);
  if (nowStrip !== thenStrip) {
    stripDiffs += 1;
    if (examples.length < 10) examples.push(["STRIP", sql, thenStrip, nowStrip]);
  }
}

console.log(`\nagainst the baseline build:`);
console.log(`  verdict differences:    ${verdictDiffs}  (newly admitted ${newlyAdmitted}, newly refused ${newlyRefused})`);
console.log(`  refusal-reason diffs:   ${reasonDiffs}`);
console.log(`  terminator-strip diffs: ${stripDiffs}`);
for (const [kind, sql, was, now] of examples) {
  console.log(`  ${kind}: ${JSON.stringify(sql)}\n    was=${JSON.stringify(was)}\n    now=${JSON.stringify(now)}`);
}

// 2. The internal walks. A verdict can agree while one of these disagrees, because several of them
// feed limbs that answer with the same message.
const pick = (mod, name) => mod.SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === name);
const INTERNAL = [
  ["targetsInternalLogIndexTable", (fn, sql) => String(fn(sql))],
  ["containsSideEffectSqlToken", (fn, sql) => String(fn(sql))],
  ["hasMultipleSqlStatements", (fn, sql) => String(fn(sql))],
  ["readFirstSqlToken", (fn, sql) => String(fn(sql))],
  ["readSqlTableReference", (fn, sql) => JSON.stringify(fn(sql, 0))],
  ["skipSqlTrivia", (fn, sql) => [fn(sql, 0, true), fn(sql, 0, false), fn(sql, 1, true)].join("|")],
  // Both readings, passed explicitly. This argument is required, and calling it with one would
  // compare the CR reading against the LF one and report a difference belonging to this script.
  ["readSqlTokens", (fn, sql) => JSON.stringify([true, false].map((cr) => fn(sql, cr).map((t) => [t.value, t.nextIndex])))],
];

console.log(`\ninternal walks the collapse touched:`);
let internalDiffs = 0;
for (const [name, call] of INTERNAL) {
  const a = pick(current, name);
  const b = pick(baseline, name);
  if (!a || !b) {
    console.log(`  ${name.padEnd(30)} absent from one build — not comparable`);
    continue;
  }
  let diffs = 0;
  let shown = 0;
  for (const sql of corpus) {
    let x;
    let y;
    try {
      x = call(a, sql);
    } catch (error) {
      x = `THREW ${error.message}`;
    }
    try {
      y = call(b, sql);
    } catch (error) {
      y = `THREW ${error.message}`;
    }
    if (x !== y) {
      diffs += 1;
      if (shown < 2) {
        shown += 1;
        console.log(`    ${JSON.stringify(sql)}\n      was=${String(y).slice(0, 120)}\n      now=${String(x).slice(0, 120)}`);
      }
    }
  }
  internalDiffs += diffs;
  console.log(`  ${name.padEnd(30)} ${diffs} differences`);
}

// 3. Realistic queries. Not attack shapes: what a person types at `sporades db query`. Every
// admitted statement shape, every comment and line-ending style, every quoting form, and the
// identifier and trivia spellings the collapse touched.
const REALISTIC = [
  "SELECT 1",
  "SELECT 1 AS s",
  "SELECT * FROM posts",
  "SELECT * FROM posts;",
  "SELECT * FROM posts ;  ",
  "select id, title from posts where id = 3",
  "SELECT COUNT(*) AS n FROM users",
  "SELECT id FROM users ORDER BY created_at DESC LIMIT 10",
  "SELECT u.id, p.title FROM users u JOIN posts p ON p.author_id = u.id",
  "SELECT id FROM posts WHERE title LIKE '%hello%'",
  "SELECT id FROM posts WHERE title = 'it''s fine'",
  "SELECT id FROM posts WHERE body LIKE '%-- not a comment%'",
  "SELECT id FROM posts WHERE body LIKE '%/* nor this */%'",
  'SELECT id FROM posts WHERE meta = \'{"a": 1}\'',
  "WITH recent AS (SELECT * FROM posts ORDER BY id DESC LIMIT 5) SELECT * FROM recent",
  "with t as (select 1 as n) select n from t",
  "PRAGMA table_info(posts)",
  "PRAGMA table_list",
  "pragma main.table_info(users)",
  "PRAGMA index_list(posts);",
  "SELECT 1 -- why\n",
  "SELECT 1 -- why",
  "SELECT 1 -- why\r\n",
  "-- a leading note\nSELECT 1 AS s",
  "-- a leading note\r\nSELECT 1 AS s",
  "SELECT 1 /* inline */ AS s",
  "/* leading */ SELECT 1 AS s",
  "SELECT\n  id, -- the key\n  title -- the label\nFROM posts",
  "SELECT\r\n  id, -- the key\r\n  title\r\nFROM posts",
  "SELECT 1 AS s /* a * b / c */",
  'SELECT "id" FROM "posts"',
  'SELECT "select" FROM "from"',
  'SELECT "a""b" AS s FROM posts',
  "SELECT `id` FROM `posts`",
  "SELECT [id] FROM [posts]",
  'SELECT "public"."posts"."id" FROM "public"."posts"',
  "SELECT comment FROM posts",
  "SELECT copy, call, truncate FROM audit",
  "SELECT $$plain$$ AS s",
  "SELECT $tag$plain$tag$ AS s",
  "SELECT E'line\\nbreak' AS s",
  "SELECT $$a;b$$ AS s",
  "SELECT $$a--b$$ AS s",
  "SELECT\t1\tAS\ts",
  "SELECT\f1 AS s",
  "  \n\t SELECT 1 AS s \n ",
  "SELECT id::text FROM posts",
  "SELECT 4/2 AS n",
  "SELECT 4 / 2 AS n",
  "SELECT -1 AS n",
  "SELECT a - -b AS n FROM t",
  "SELECT '$' AS s",
  "SELECT 'E' AS s",
  "SELECT e FROM t",
  "SELECT t1$$ FROM t",
];

let realisticNewlyRefused = 0;
let realisticNewlyAdmitted = 0;
for (const sql of REALISTIC) {
  const now = current.validateReadOnlyInspectionSql(sql).ok;
  const then = baseline.validateReadOnlyInspectionSql(sql).ok;
  if (then && !now) {
    realisticNewlyRefused += 1;
    console.log(`  NEWLY REFUSED: ${JSON.stringify(sql)}`);
  }
  if (!then && now) {
    realisticNewlyAdmitted += 1;
    console.log(`  NEWLY ADMITTED: ${JSON.stringify(sql)}`);
  }
}
console.log(`\nrealistic queries: ${REALISTIC.length}`);
console.log(`  newly refused vs baseline:  ${realisticNewlyRefused}`);
console.log(`  newly admitted vs baseline: ${realisticNewlyAdmitted}`);

// Newly *admitted* is the failing condition. Newly refused is not: the gate is allowed to get
// stricter on attack shapes, and the realistic set above is the check on whether that stricture has
// reached anything a person would type.
process.exitCode = newlyAdmitted === 0 && realisticNewlyRefused === 0 ? 0 : 1;
