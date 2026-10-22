type LooseRecord = Record<string, any>;
export declare const DATABASE_INSPECTION_ACTIONS: readonly ["db.list", "db.dump", "db.query"];
export type DatabaseInspectionAction = (typeof DATABASE_INSPECTION_ACTIONS)[number];
export declare function encodeDatabaseInspectionInput(sql: string): string | null;
export declare const DATABASE_INSPECTION_MAX_BUFFER: number;
export declare function isDatabaseInspectionAction(action: unknown): action is DatabaseInspectionAction;
export declare function sanitizeDatabaseInspectionEnvelope(action: DatabaseInspectionAction, envelope: LooseRecord, invalid: () => never): LooseRecord;
export {};
//# sourceMappingURL=database-inspection-envelope.d.ts.map