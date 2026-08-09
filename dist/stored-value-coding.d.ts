type LooseRecord = Record<string, any>;
export declare function deserializeFieldValue(field: LooseRecord, value: any): any;
export declare function deserializeRow(table: LooseRecord, row: LooseRecord): {
    [x: string]: any;
};
export declare function serializeFieldValue(field: LooseRecord, value: any): string | number | null;
export declare function normalizeDateValue(value: string | number | Date, fieldName: string): string;
export {};
//# sourceMappingURL=stored-value-coding.d.ts.map