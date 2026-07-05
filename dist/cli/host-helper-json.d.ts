export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = {
    [key: string]: unknown;
};
//# sourceMappingURL=host-helper-json.d.ts.map