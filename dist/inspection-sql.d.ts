export declare function validateReadOnlyInspectionSql(sql: any): {
    ok: false;
    data: any;
    error: {
        message: string;
        hint: string;
    };
} | {
    ok: true;
};
export declare function readOnlyInspectionSqlError(): {
    ok: false;
    data: any;
    error: {
        message: string;
        hint: string;
    };
};
export declare function unrepresentableInspectionSqlError(): {
    ok: false;
    data: any;
    error: {
        message: string;
        hint: string;
    };
};
export declare function ambiguousInspectionSqlError(hint: string): {
    ok: false;
    data: any;
    error: {
        message: string;
        hint: string;
    };
};
export declare function sqlTheEnginesLexDifferently(sql: string): "Remove the carriage return from inside the `-- ...` comment in the `sporades db query` SQL — SQLite ends a line comment at a line feed and Postgres ends one at either." | "Remove the nested `/* ... */` comment from the `sporades db query` SQL — Postgres and SQLite disagree about where it ends." | "Replace the invisible character outside quotes — a non-breaking space, a vertical tab, or another character the engines do not treat as whitespace — with an ordinary space." | null;
export declare function sqlContentFingerprint(sql: string, lineCommentEndsAtCarriageReturn: boolean): string;
export declare function readFirstSqlToken(sql: string): string | null;
export declare function hasMultipleSqlStatements(sql: string): boolean;
export declare function isSafeInspectionPragma(sql: string, pragmaTokenLength: number): boolean;
export declare const SAFE_INSPECTION_PRAGMAS: Set<string>;
export declare function containsSideEffectSqlToken(sql: string): boolean;
export declare function containsSideEffectSqlTokenUnder(sql: string, lineCommentEndsAtCarriageReturn: boolean): boolean;
export declare const SIDE_EFFECT_SQL_KEYWORDS: Set<string>;
export declare const SIDE_EFFECT_SQL_FUNCTIONS: Set<string>;
export declare function readSqlTokens(sql: string, lineCommentEndsAtCarriageReturn: boolean): {
    value: string;
    nextIndex: number;
}[];
export declare function readBareSqlIdentifier(sql: string, index: number): {
    value: string;
    nextIndex: number;
} | null;
export declare function readSqlTokenIdentifier(sql: string, index: number): {
    value: string;
    nextIndex: number;
} | null;
export declare function readSqlQuotedIdentifier(sql: string, index: number, quotes: string): {
    value: string;
    nextIndex: number;
} | null;
export declare function sqlDialectEveryEngineQuotes(lineCommentEndsAtCarriageReturn: boolean): {
    comments: boolean;
    lineCommentEndsAtCarriageReturn: boolean;
    dollarQuoting: boolean;
    escapeStrings: boolean;
    quotes: string;
    unterminatedQuotedRunReachesEndOfInput: boolean;
};
export declare function sqlDialectWithoutPostgresStringForms(lineCommentEndsAtCarriageReturn: boolean): {
    comments: boolean;
    lineCommentEndsAtCarriageReturn: boolean;
    dollarQuoting: boolean;
    escapeStrings: boolean;
    quotes: string;
    unterminatedQuotedRunReachesEndOfInput: boolean;
};
export declare function sqlDialectCommentsOnly(lineCommentEndsAtCarriageReturn: boolean): {
    comments: boolean;
    lineCommentEndsAtCarriageReturn: boolean;
    dollarQuoting: boolean;
    escapeStrings: boolean;
    quotes: string;
    unterminatedQuotedRunReachesEndOfInput: boolean;
};
export declare function sqlDialectQuotedRunsOnly(): {
    comments: boolean;
    lineCommentEndsAtCarriageReturn: boolean;
    dollarQuoting: boolean;
    escapeStrings: boolean;
    quotes: string;
    unterminatedQuotedRunReachesEndOfInput: boolean;
};
export declare function sqlDialectQuotedIdentifiersOnly(quotes: string): {
    comments: boolean;
    lineCommentEndsAtCarriageReturn: boolean;
    dollarQuoting: boolean;
    escapeStrings: boolean;
    quotes: string;
    unterminatedQuotedRunReachesEndOfInput: boolean;
};
export declare function skipSqlQuotedOrCommented(sql: string, index: number, dialect: any): number;
export declare function sqlWithoutTrailingTerminator(sql: any): string;
export declare function skipSqlTrivia(sql: string, startIndex: any, lineCommentEndsAtCarriageReturn: boolean): any;
//# sourceMappingURL=inspection-sql.d.ts.map