type LooseRecord = Record<string, any>;
export declare const ACCESS_KEY_OPERATOR_ACTIONS: readonly ["access-keys.list", "access-keys.inspect", "access-keys.revoke", "access-keys.revoke-all", "access-keys.delete"];
export declare function confirmAccessKeyOperatorAction(options: LooseRecord, io?: LooseRecord): Promise<void>;
export declare function validateAccessKeyOperatorActionInput(action: unknown, value: unknown, invalid: () => never): LooseRecord;
export declare function sanitizeAccessKeyOperatorEnvelope(value: unknown, action: unknown, input: unknown, invalid: () => never): LooseRecord;
export {};
//# sourceMappingURL=access-key-operator-envelope.d.ts.map