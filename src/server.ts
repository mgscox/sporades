export function capsule(definition: any) {
  return {
    kind: "capsule",
    ...definition,
  };
}

export function endpoint(options: any, handler: any) {
  return {
    kind: "endpoint",
    options,
    handler,
  };
}

export function query(handler: any) {
  return {
    kind: "query",
    handler,
  };
}

export function mutation(handler: any) {
  return {
    kind: "mutation",
    handler,
  };
}

export function message(handler: any) {
  return {
    kind: "message",
    handler,
  };
}

export function table(fields: any) {
  return tableDefinition(fields);
}

function tableDefinition(fields: any, aclRules?: any) {
  return {
    kind: "table",
    fields,
    acl(rules: any) {
      return tableDefinition(fields, rules);
    },
    ...(aclRules === undefined ? {} : { aclRules }),
  };
}

export function String() {
  return field("String");
}

export function Boolean() {
  return field("Boolean");
}

export function Number() {
  return field("Number");
}

export function Date() {
  return field("Date");
}

export function Json() {
  return field("Json");
}

export function Reference(targetTable: any) {
  return {
    kind: "Reference",
    targetTable,
    default(defaultValue: any) {
      return {
        kind: "Reference",
        targetTable,
        defaultValue,
      };
    },
  };
}

function field(kind: any) {
  return {
    kind,
    default(defaultValue: any) {
      return {
        kind,
        defaultValue,
      };
    },
  };
}

export function serverRuntimeModuleSource() {
  return `export function capsule(definition) {
  return {
    kind: "capsule",
    ...definition,
  };
}

export function endpoint(options, handler) {
  return {
    kind: "endpoint",
    options,
    handler,
  };
}

export function query(handler) {
  return {
    kind: "query",
    handler,
  };
}

export function mutation(handler) {
  return {
    kind: "mutation",
    handler,
  };
}

export function message(handler) {
  return {
    kind: "message",
    handler,
  };
}

export function table(fields) {
  return tableDefinition(fields);
}

function tableDefinition(fields, aclRules) {
  return {
    kind: "table",
    fields,
    acl(rules) {
      return tableDefinition(fields, rules);
    },
    ...(aclRules === undefined ? {} : { aclRules }),
  };
}

export function String() {
  return field("String");
}

export function Boolean() {
  return field("Boolean");
}

export function Number() {
  return field("Number");
}

export function Date() {
  return field("Date");
}

export function Json() {
  return field("Json");
}

export function Reference(targetTable) {
  return {
    kind: "Reference",
    targetTable,
    default(defaultValue) {
      return {
        kind: "Reference",
        targetTable,
        defaultValue,
      };
    },
  };
}

function field(kind) {
  return {
    kind,
    default(defaultValue) {
      return {
        kind,
        defaultValue,
      };
    },
  };
}
`;
}
