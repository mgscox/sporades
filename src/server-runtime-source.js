import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

export const SERVER_RUNTIME_SOURCE_FUNCTIONS = [
  readJsonRequest,
  openDevDatabase,
  extractSchema,
  extractEndpoints,
  extractQueryHandlers,
  extractMutationHandlers,
  extractMessageHandlers,
  extractContextMiddleware,
  extractMutationHooks,
  extractHookList,
  extractFields,
  parseFieldDefault,
  parseJsonFieldDefault,
  extractObjectPropertySource,
  findMatchingDelimiter,
  splitTopLevelList,
  migrateAppSchema,
  normalizeSchema,
  hashSchema,
  assertValidReferenceTargets,
  assertAdditiveSchemaMigration,
  applyAdditiveFieldMigrations,
  addedFieldsForTable,
  createAppTable,
  commandError,
  toSqlLiteral,
  findMatchingParen,
  createEndpointContext,
  applyContextMiddleware,
  runContextMiddleware,
  readEndpointSessionToken,
  createEndpointDatabaseApi,
  createEndpointTableApi,
  fieldValueForWrite,
  invalidReferenceError,
  referenceExists,
  serializeFieldValue,
  normalizeDateValue,
  dateValueError,
  assertJsonCompatible,
  invalidJsonFieldValueError,
  deserializeRow,
  readEndpointBody,
  createEndpointLogger,
  authStatus,
  normalizeAuthConfig,
  readProviderConfig,
  createFileStorageTables,
  handleFileHttpRoute,
  readRequestBytes,
  writeJsonHttpResponse,
  writeNotFound,
  sendFileHttpResponse,
  createPendingFileUpload,
  completePendingFileUpload,
  getPrivateFileUrl,
  createPublicFileUrl,
  revokePublicFileUrl,
  deletePrivateFile,
  fileMetadataFromRow,
  createStructuredFileError,
  validatePublicUrlExpiry,
  fileRowForOwner,
  fileStoragePath,
  fileVersionPath,
  removeFileVersionBestEffort,
  contentTypeForFile,
  createAnonymousAuthTables,
  resolveAnonymousSession,
  sessionFromRow,
  authProvidersForClient,
  routeSporadesAuth,
  signUpWithEmail,
  signInWithEmail,
  normalizeEmailCredentials,
  hashEmailPassword,
  verifyEmailPassword,
  emailAuthDisabledError,
  beginGoogleSignIn,
  normalizeReturnTo,
  exchangeGoogleCode,
  readGoogleOAuthError,
  oauthErrorHint,
  fetchGoogleProfile,
  linkGoogleAccount,
  writeRedirect,
  createWebSocketAccept,
  createWebSocketHub,
  drainWebSocketFrames,
  sendJson,
  routeEndpoint,
  runEndpoint,
  writeEndpointResult,
  writeEndpointError,
  endpointResponseError,
  runQuery,
  runCustomQuery,
  runMutation,
  runCustomMutation,
  runAppMessage,
  validateAppMessageType,
  isAllAppMessageScope,
  runMutationHook,
  createMutationContext,
  createMessageContext,
  createHookErrorResult,
  runInsertMutation,
  runUpdateMutation,
  formatMutationResult,
  resolveTableForQuery,
  resolveTableForAddMutation,
  resolveTableForUpdateMutation,
  tableNameForSingular,
  rowToApiValue,
  toSqlNumber,
  quoteIdentifier,
];

export async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export async function openDevDatabase(databasePath, serverSource, serverEnv = {}, config = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await import("node:path");
  const sqlite = new DatabaseSync(databasePath);
  const schema = extractSchema(serverSource);
  const endpoints = extractEndpoints(serverSource);
  const queries = extractQueryHandlers(serverSource);
  const mutations = extractMutationHandlers(serverSource);
  const messages = extractMessageHandlers(serverSource);
  const contextMiddleware = extractContextMiddleware(serverSource);
  const mutationHooks = extractMutationHooks(serverSource);
  const rowCache = new Map();
  const database = {
    sqlite,
    schema,
    endpoints,
    queries,
    mutations,
    messages,
    contextMiddleware,
    mutationHooks,
    rowCache,
    serverEnv,
    authConfig: authStatus(config, serverEnv),
    fileStoragePath: config.files?.storagePath ?? path.join(path.dirname(databasePath), "files"),
    fileMaxSizeBytes: config.files?.maxSizeBytes ?? 10 * 1024 * 1024,
    close: () => sqlite.close(),
  };
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("CREATE TABLE IF NOT EXISTS sporades (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  createAnonymousAuthTables(sqlite, database.authConfig);
  createFileStorageTables(sqlite);
  assertValidReferenceTargets(schema);
  migrateAppSchema(sqlite, schema);

  return database;
}

function migrateAppSchema(sqlite, schema) {
  const nextSchema = normalizeSchema(schema);
  const nextSchemaJson = JSON.stringify(nextSchema);
  const nextSchemaHash = hashSchema(nextSchemaJson);
  const existingSchemaRow = sqlite.prepare("SELECT value FROM sporades WHERE key = ?").get("schema");
  let existingSchema = null;

  if (existingSchemaRow) {
    try {
      existingSchema = JSON.parse(existingSchemaRow.value);
    } catch {
      throw commandError(
        "Invalid Sporades schema metadata.",
        "Delete the Runtime directory only if you can lose local data, then restart the Capsule.",
      );
    }

    if (hashSchema(JSON.stringify(existingSchema)) !== nextSchemaHash) {
      assertAdditiveSchemaMigration(existingSchema, nextSchema);
    }
  }

  for (const table of schema.tables) {
    createAppTable(sqlite, table);
  }
  if (existingSchema) {
    applyAdditiveFieldMigrations(sqlite, existingSchema, nextSchema);
  }

  const upsert = sqlite.prepare("INSERT OR REPLACE INTO sporades (key, value) VALUES (?, ?)");
  upsert.run("schemaVersion", "v1:additive-fields");
  upsert.run("schemaHash", nextSchemaHash);
  upsert.run("schema", nextSchemaJson);
}

function normalizeSchema(schema) {
  return {
    tables: schema.tables
      .map((table) => ({
        name: table.name,
        fields: table.fields.map((field) => ({
          name: field.name,
          kind: field.kind,
          sqliteType: field.sqliteType,
          targetTable: field.targetTable,
          defaultValue: field.defaultValue,
        })),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function hashSchema(schemaJson) {
  return createHash("sha256").update(schemaJson).digest("hex");
}

function assertValidReferenceTargets(schema) {
  const tableNames = new Set(schema.tables.map((table) => table.name));
  for (const table of schema.tables) {
    for (const field of table.fields) {
      if (field.kind === "Reference" && !tableNames.has(field.targetTable)) {
        throw commandError(
          `Unknown reference target: ${field.targetTable}`,
          "Reference fields must point at another table in the Capsule schema.",
        );
      }
    }
  }
}

function assertAdditiveSchemaMigration(existingSchema, nextSchema) {
  const nextTables = new Map(nextSchema.tables.map((table) => [table.name, table]));

  for (const existingTable of existingSchema.tables ?? []) {
    const nextTable = nextTables.get(existingTable.name);
    if (!nextTable) {
      throw commandError(
        "Unsupported Capsule schema change.",
        "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.",
      );
    }

    const nextFields = new Map(nextTable.fields.map((field) => [field.name, field]));
    for (const existingField of existingTable.fields ?? []) {
      const nextField = nextFields.get(existingField.name);
      if (!nextField || JSON.stringify(existingField) !== JSON.stringify(nextField)) {
        throw commandError(
          "Unsupported Capsule schema change.",
          "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.",
        );
      }
    }
  }
}

function applyAdditiveFieldMigrations(sqlite, existingSchema, nextSchema) {
  const existingTables = new Map((existingSchema.tables ?? []).map((table) => [table.name, table]));

  for (const nextTable of nextSchema.tables ?? []) {
    const existingTable = existingTables.get(nextTable.name);
    if (!existingTable) {
      continue;
    }

    for (const field of addedFieldsForTable(existingTable, nextTable)) {
      const defaultSql = field.defaultValue === undefined ? "" : ` NOT NULL DEFAULT ${toSqlLiteral(field.defaultValue, field)}`;
      if (field.kind === "Reference" && field.defaultValue !== undefined && !referenceExists({ sqlite }, field, field.defaultValue)) {
        throw invalidReferenceError(field);
      }
      sqlite.exec(
        `ALTER TABLE ${quoteIdentifier(nextTable.name)} ADD COLUMN ${quoteIdentifier(field.name)} ${field.sqliteType}${defaultSql}`,
      );
    }
  }
}

function addedFieldsForTable(existingTable, nextTable) {
  const existingFields = new Set((existingTable.fields ?? []).map((field) => field.name));
  return (nextTable.fields ?? []).filter((field) => !existingFields.has(field.name));
}

function createAppTable(sqlite, table) {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (` +
      [
        "id TEXT PRIMARY KEY",
        "createdAt TEXT NOT NULL",
        "updatedAt TEXT NOT NULL",
        ...table.fields.map((field) => {
          const defaultSql = field.defaultValue === undefined ? "" : ` DEFAULT ${toSqlLiteral(field.defaultValue, field)}`;
          return `${quoteIdentifier(field.name)} ${field.sqliteType} NOT NULL${defaultSql}`;
        }),
      ].join(", ") +
      ")",
  );
}

function commandError(message, hint) {
  const error = new Error(message);
  error.hint = hint;
  return error;
}

function extractSchema(serverSource) {
  const tables = [];
  const tablePattern = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*table\s*\(/g;
  let match;

  while ((match = tablePattern.exec(serverSource))) {
    const argsEnd = findMatchingParen(serverSource, tablePattern.lastIndex - 1);
    if (argsEnd === -1) {
      continue;
    }
    const argsSource = serverSource.slice(tablePattern.lastIndex, argsEnd).trim();
    const fieldsSource = argsSource.startsWith("{") && argsSource.endsWith("}") ? argsSource.slice(1, -1) : argsSource;
    tables.push({
      name: match[1],
      fields: extractFields(fieldsSource),
    });
    tablePattern.lastIndex = argsEnd + 1;
  }

  return { tables };
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function extractEndpoints(serverSource) {
  const endpoints = [];
  const endpointPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*endpoint\s*\(/g;
  let match;

  while ((match = endpointPattern.exec(serverSource))) {
    const argsEnd = findMatchingParen(serverSource, endpointPattern.lastIndex - 1);
    if (argsEnd === -1) {
      continue;
    }

    const argsSource = serverSource.slice(endpointPattern.lastIndex, argsEnd);
    const descriptor = argsSource.match(
      /^\s*\{\s*method\s*:\s*["']([A-Za-z]+)["']\s*,\s*path\s*:\s*["']([^"']+)["']\s*\}\s*,/,
    );
    if (!descriptor) {
      endpointPattern.lastIndex = argsEnd + 1;
      continue;
    }

    endpoints.push({
      name: match[1],
      method: descriptor[1].toUpperCase(),
      path: descriptor[2],
      handlerSource: argsSource.slice(descriptor[0].length).trim(),
    });
    endpointPattern.lastIndex = argsEnd + 1;
  }

  return endpoints;
}

function extractQueryHandlers(serverSource) {
  const queriesSource = extractObjectPropertySource(serverSource, "queries");
  if (!queriesSource) {
    return [];
  }

  const source = queriesSource.trim();
  if (!source.startsWith("{")) {
    return [];
  }
  const closeIndex = findMatchingDelimiter(source, 0, "{", "}");
  if (closeIndex === -1) {
    return [];
  }

  const handlers = [];
  const entriesSource = source.slice(1, closeIndex);
  for (const entry of splitTopLevelList(entriesSource)) {
    const match = entry.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*query\s*\(/);
    if (!match) {
      continue;
    }

    const queryCallIndex = entry.indexOf("query");
    const openIndex = entry.indexOf("(", queryCallIndex);
    const argsEnd = findMatchingParen(entry, openIndex);
    if (argsEnd === -1) {
      continue;
    }

    handlers.push({
      name: match[1],
      handlerSource: entry.slice(openIndex + 1, argsEnd).trim().replace(/,\s*$/, ""),
    });
  }
  return handlers;
}

function extractMutationHandlers(serverSource) {
  const mutationsSource = extractObjectPropertySource(serverSource, "mutations");
  if (!mutationsSource) {
    return [];
  }

  const source = mutationsSource.trim();
  if (!source.startsWith("{")) {
    return [];
  }
  const closeIndex = findMatchingDelimiter(source, 0, "{", "}");
  if (closeIndex === -1) {
    return [];
  }

  const handlers = [];
  const entriesSource = source.slice(1, closeIndex);
  for (const entry of splitTopLevelList(entriesSource)) {
    const match = entry.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*mutation\s*\(/);
    if (!match) {
      continue;
    }
    if (match[1].startsWith("add") || match[1].startsWith("update")) {
      continue;
    }

    const mutationCallIndex = entry.indexOf("mutation");
    const openIndex = entry.indexOf("(", mutationCallIndex);
    const argsEnd = findMatchingParen(entry, openIndex);
    if (argsEnd === -1) {
      continue;
    }

    handlers.push({
      name: match[1],
      handlerSource: entry.slice(openIndex + 1, argsEnd).trim().replace(/,\s*$/, ""),
    });
  }
  return handlers;
}

function extractMessageHandlers(serverSource) {
  const messagesSource = extractObjectPropertySource(serverSource, "messages");
  if (!messagesSource) {
    return [];
  }

  const source = messagesSource.trim();
  if (!source.startsWith("{")) {
    return [];
  }
  const closeIndex = findMatchingDelimiter(source, 0, "{", "}");
  if (closeIndex === -1) {
    return [];
  }

  const handlers = [];
  const entriesSource = source.slice(1, closeIndex);
  for (const entry of splitTopLevelList(entriesSource)) {
    const match = entry.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*message\s*\(/);
    if (!match) {
      continue;
    }

    const messageCallIndex = entry.indexOf("message");
    const openIndex = entry.indexOf("(", messageCallIndex);
    const argsEnd = findMatchingParen(entry, openIndex);
    if (argsEnd === -1) {
      continue;
    }

    handlers.push({
      name: match[1],
      handlerSource: entry.slice(openIndex + 1, argsEnd).trim(),
    });
  }
  return handlers;
}

function extractContextMiddleware(serverSource) {
  const middlewareSource = extractObjectPropertySource(serverSource, "middleware");
  if (!middlewareSource) {
    return [];
  }
  return extractHookList(`middleware: ${middlewareSource}`, "middleware");
}

function extractMutationHooks(serverSource) {
  const hooksSource = extractObjectPropertySource(serverSource, "hooks");
  if (!hooksSource) {
    return {
      beforeMutation: [],
      afterMutation: [],
    };
  }

  return {
    beforeMutation: extractHookList(hooksSource, "beforeMutation"),
    afterMutation: extractHookList(hooksSource, "afterMutation"),
  };
}

function extractHookList(hooksSource, propertyName) {
  const valueSource = extractObjectPropertySource(hooksSource, propertyName);
  if (!valueSource) {
    return [];
  }
  const trimmed = valueSource.trim();
  if (trimmed.startsWith("[")) {
    const closeIndex = findMatchingDelimiter(trimmed, 0, "[", "]");
    if (closeIndex === -1) {
      return [];
    }
    return splitTopLevelList(trimmed.slice(1, closeIndex)).map((source) => source.trim()).filter(Boolean);
  }
  return [trimmed.replace(/,\s*$/, "")];
}

function extractObjectPropertySource(source, propertyName) {
  const pattern = new RegExp(`\\b${propertyName}\\s*:`, "g");
  const match = pattern.exec(source);
  if (!match) {
    return null;
  }
  const valueStart = match.index + match[0].length;
  let index = valueStart;
  while (/\s/.test(source[index] ?? "")) {
    index += 1;
  }

  const firstChar = source[index];
  if (firstChar === "{") {
    const endIndex = findMatchingDelimiter(source, index, "{", "}");
    return endIndex === -1 ? null : source.slice(index, endIndex + 1);
  }
  if (firstChar === "[") {
    const endIndex = findMatchingDelimiter(source, index, "[", "]");
    return endIndex === -1 ? null : source.slice(index, endIndex + 1);
  }

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      if (depth === 0) {
        return source.slice(index, cursor);
      }
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      return source.slice(index, cursor);
    }
  }
  return source.slice(index);
}

function findMatchingDelimiter(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitTopLevelList(source) {
  const items = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      items.push(source.slice(start, index));
      start = index + 1;
    }
  }

  items.push(source.slice(start));
  return items;
}

function extractFields(tableSource) {
  return [
    ...tableSource.matchAll(
      /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:(String|Boolean|Number|Date|Json)\(\)|Reference\(\s*["']([^"']+)["']\s*\))(?:\.default\(([^)]*)\))?/g,
    ),
  ].map(
    (match) => {
      const kind = match[3] ? "Reference" : match[2];
      return {
        name: match[1],
        kind,
        sqliteType: kind === "Boolean" ? "INTEGER" : kind === "Number" ? "REAL" : "TEXT",
        targetTable: match[3],
        defaultValue: parseFieldDefault(kind, match[4]),
      };
    },
  );
}

export async function routeEndpoint(database, request, response) {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const endpoint = database.endpoints.find(
    (candidate) => candidate.method === request.method && candidate.path === requestUrl.pathname,
  );
  if (!endpoint) {
    return false;
  }

  try {
    writeEndpointResult(response, await runEndpoint(database, endpoint, requestUrl, request));
  } catch (error) {
    writeEndpointError(response, error);
  }
  return true;
}

export async function handleFileHttpRoute(database, request, response, websocketHub = null) {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const uploadMatch = requestUrl.pathname.match(/^\/__sporades\/uploads\/([^/]+)$/);
  if (uploadMatch && request.method === "PUT") {
    const result = await completePendingFileUpload(database, uploadMatch[1], request, websocketHub);
    writeJsonHttpResponse(response, result.ok ? 200 : 400, result);
    return true;
  }

  const privateMatch = requestUrl.pathname.match(/^\/__sporades\/files\/private\/([^/]+)$/);
  if (privateMatch && request.method === "GET") {
    const token = request.headers["x-sporades-session-token"] ?? requestUrl.searchParams.get("sessionToken");
    const session = resolveAnonymousSession(database, token);
    const row = fileRowForOwner(database, privateMatch[1], session.auth.userId);
    if (!row || row.version !== requestUrl.searchParams.get("v")) {
      writeNotFound(response);
      return true;
    }
    await sendFileHttpResponse(database, response, row);
    return true;
  }

  const publicMatch = requestUrl.pathname.match(/^\/__sporades\/files\/public\/([^/]+)$/);
  if (publicMatch && request.method === "GET") {
    const publicRow = database.sqlite
      .prepare(
        "SELECT p.id AS publicUrlId, p.fileId, p.version AS publicVersion, p.expiresAt, p.revokedAt, " +
          "f.id, f.ownerId, f.bucketId, f.bucketName, f.name, f.type, f.size, f.version, f.status, f.createdAt, f.updatedAt, f.deletedAt " +
          "FROM sporades_file_public_urls p JOIN sporades_files f ON f.id = p.fileId " +
          "WHERE p.id = ?",
      )
      .get(publicMatch[1]);
    if (
      !publicRow ||
      publicRow.revokedAt ||
      publicRow.deletedAt ||
      (publicRow.expiresAt && Date.parse(publicRow.expiresAt) <= Date.now()) ||
      publicRow.publicVersion !== requestUrl.searchParams.get("v") ||
      publicRow.publicVersion !== publicRow.version
    ) {
      writeNotFound(response);
      return true;
    }
    await sendFileHttpResponse(database, response, publicRow);
    return true;
  }

  return false;
}

function createFileStorageTables(sqlite) {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_file_buckets (" +
      "id TEXT PRIMARY KEY, " +
      "ownerId TEXT NOT NULL, " +
      "name TEXT NOT NULL, " +
      "createdAt TEXT NOT NULL, " +
      "UNIQUE(ownerId, name)" +
      ")",
  );
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_files (" +
      "id TEXT PRIMARY KEY, " +
      "ownerId TEXT NOT NULL, " +
      "bucketId TEXT NOT NULL, " +
      "bucketName TEXT NOT NULL, " +
      "name TEXT NOT NULL, " +
      "type TEXT NOT NULL, " +
      "size INTEGER NOT NULL, " +
      "version TEXT NOT NULL, " +
      "status TEXT NOT NULL, " +
      "createdAt TEXT NOT NULL, " +
      "updatedAt TEXT NOT NULL, " +
      "deletedAt TEXT" +
      ")",
  );
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_file_uploads (" +
      "id TEXT PRIMARY KEY, " +
      "fileId TEXT NOT NULL, " +
      "ownerId TEXT NOT NULL, " +
      "version TEXT NOT NULL, " +
      "expectedSize INTEGER NOT NULL, " +
      "createdAt TEXT NOT NULL" +
      ")",
  );
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_file_public_urls (" +
      "id TEXT PRIMARY KEY, " +
      "fileId TEXT NOT NULL, " +
      "ownerId TEXT NOT NULL, " +
      "version TEXT NOT NULL, " +
      "expiresAt TEXT, " +
      "createdAt TEXT NOT NULL, " +
      "revokedAt TEXT" +
      ")",
  );
}

async function readRequestBytes(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw createStructuredFileError(
        "File is too large.",
        `Choose a file at or below ${maxBytes} bytes, or raise files.maxSizeBytes in sporades.json.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeJsonHttpResponse(response, status, result) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(result)}\n`);
}

function writeNotFound(response) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

async function sendFileHttpResponse(database, response, row) {
  const { readFile } = await import("node:fs/promises");
  try {
    const bytes = await readFile(fileVersionPath(database, row.id, row.version));
    response.writeHead(200, {
      "content-type": contentTypeForFile(row.type),
      "cache-control": "private, max-age=31536000, immutable",
    });
    response.end(bytes);
  } catch {
    writeNotFound(response);
  }
}

function contentTypeForFile(type) {
  return type || "application/octet-stream";
}

function createPendingFileUpload(database, auth, message) {
  const input = message.file ?? {};
  const size = Number(input.size ?? 0);
  if (!Number.isFinite(size) || size < 0) {
    return {
      ok: false,
      error: createStructuredFileError("Invalid file size.", "Pass a browser File or Blob with a finite size."),
    };
  }
  if (size > database.fileMaxSizeBytes) {
    return {
      ok: false,
      error: createStructuredFileError(
        "File is too large.",
        `Choose a file at or below ${database.fileMaxSizeBytes} bytes, or raise files.maxSizeBytes in sporades.json.`,
      ),
    };
  }

  const now = new Date().toISOString();
  const bucket =
    database.sqlite.prepare("SELECT * FROM sporades_file_buckets WHERE ownerId = ? AND name = ?").get(auth.userId, "default") ??
    (() => {
      const bucketId = randomUUID();
      database.sqlite
        .prepare("INSERT INTO sporades_file_buckets (id, ownerId, name, createdAt) VALUES (?, ?, ?, ?)")
        .run(bucketId, auth.userId, "default", now);
      return { id: bucketId, ownerId: auth.userId, name: "default", createdAt: now };
    })();

  const replacing = message.replace === true;
  const fileId = replacing ? String(message.fileId ?? "") : randomUUID();
  const existing = replacing ? fileRowForOwner(database, fileId, auth.userId) : null;
  if (replacing && !existing) {
    return {
      ok: false,
      error: createStructuredFileError("File not found.", "Pass the id of a private file owned by the current user."),
    };
  }

  const uploadId = randomUUID();
  const version = randomUUID();
  const name = String(input.name ?? "upload");
  const type = String(input.type ?? "application/octet-stream");
  if (existing) {
    database.sqlite
      .prepare(
        "UPDATE sporades_files SET name = ?, type = ?, size = ?, version = ?, status = ?, updatedAt = ?, deletedAt = NULL WHERE id = ?",
      )
      .run(name, type, size, version, "pending", now, fileId);
    database.sqlite
      .prepare("UPDATE sporades_file_public_urls SET revokedAt = ? WHERE fileId = ? AND revokedAt IS NULL")
      .run(now, fileId);
  } else {
    database.sqlite
      .prepare(
        "INSERT INTO sporades_files " +
          "(id, ownerId, bucketId, bucketName, name, type, size, version, status, createdAt, updatedAt, deletedAt) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(fileId, auth.userId, bucket.id, bucket.name, name, type, size, version, "pending", now, now);
  }
  database.sqlite
    .prepare("INSERT INTO sporades_file_uploads (id, fileId, ownerId, version, expectedSize, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(uploadId, fileId, auth.userId, version, size, now);

  return {
    ok: true,
    data: {
      uploadUrl: `/__sporades/uploads/${uploadId}`,
      method: "PUT",
      headers: {},
      file: fileMetadataFromRow(
        database.sqlite.prepare("SELECT * FROM sporades_files WHERE id = ?").get(fileId),
      ),
    },
    error: null,
  };
}

async function completePendingFileUpload(database, uploadId, request, websocketHub = null) {
  const upload = database.sqlite.prepare("SELECT * FROM sporades_file_uploads WHERE id = ?").get(uploadId);
  if (!upload) {
    return {
      ok: false,
      data: null,
      error: createStructuredFileError("Upload URL not found.", "Request a fresh upload URL from the Sporades client SDK."),
    };
  }

  try {
    websocketHub?.notifyFileEvent?.(upload.ownerId, {
      type: "file.upload.progress",
      fileId: upload.fileId,
      loaded: 0,
      total: upload.expectedSize,
    });
    const bytes = await readRequestBytes(request, database.fileMaxSizeBytes);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(fileStoragePath(database, upload.fileId), { recursive: true });
    await writeFile(fileVersionPath(database, upload.fileId, upload.version), bytes);
    const now = new Date().toISOString();
    database.sqlite
      .prepare("UPDATE sporades_files SET size = ?, status = ?, updatedAt = ? WHERE id = ? AND version = ?")
      .run(bytes.length, "uploaded", now, upload.fileId, upload.version);
    database.sqlite.prepare("DELETE FROM sporades_file_uploads WHERE id = ?").run(uploadId);
    const file = fileMetadataFromRow(database.sqlite.prepare("SELECT * FROM sporades_files WHERE id = ?").get(upload.fileId));
    websocketHub?.notifyFileEvent?.(upload.ownerId, {
      type: "file.upload.complete",
      file,
    });
    return { ok: true, data: { file }, error: null };
  } catch (error) {
    websocketHub?.notifyFileEvent?.(upload.ownerId, {
      type: "file.upload.failed",
      fileId: upload.fileId,
      error: {
        message: error.message,
        hint: error.hint ?? "Request a fresh upload URL and retry.",
      },
    });
    return {
      ok: false,
      data: null,
      error: {
        message: error.message,
        hint: error.hint ?? "Request a fresh upload URL and retry.",
      },
    };
  }
}

function getPrivateFileUrl(database, auth, fileId, sessionToken) {
  const row = fileRowForOwner(database, fileId, auth.userId);
  if (!row) {
    return {
      ok: false,
      error: createStructuredFileError("File not found.", "Pass the id of a private file owned by the current user."),
    };
  }
  return {
    ok: true,
    data: {
      url: `/__sporades/files/private/${row.id}?v=${encodeURIComponent(row.version)}&sessionToken=${encodeURIComponent(sessionToken)}`,
      file: fileMetadataFromRow(row),
    },
    error: null,
  };
}

function createPublicFileUrl(database, auth, fileId, options = {}) {
  const row = fileRowForOwner(database, fileId, auth.userId);
  if (!row) {
    return {
      ok: false,
      error: createStructuredFileError("File not found.", "Pass the id of a private file owned by the current user."),
    };
  }
  const expiry = validatePublicUrlExpiry(options);
  if (!expiry.ok) {
    return expiry;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  database.sqlite
    .prepare(
      "INSERT INTO sporades_file_public_urls (id, fileId, ownerId, version, expiresAt, createdAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    )
    .run(id, row.id, auth.userId, row.version, expiry.expiresAt, now);
  return {
    ok: true,
    data: {
      publicUrl: {
        id,
        fileId: row.id,
        url: `/__sporades/files/public/${id}?v=${encodeURIComponent(row.version)}`,
        expiresAt: expiry.expiresAt,
        revokedAt: null,
      },
    },
    error: null,
  };
}

function revokePublicFileUrl(database, auth, publicUrlId) {
  const now = new Date().toISOString();
  const result = database.sqlite
    .prepare("UPDATE sporades_file_public_urls SET revokedAt = ? WHERE id = ? AND ownerId = ? AND revokedAt IS NULL")
    .run(now, publicUrlId, auth.userId);
  if (result.changes === 0) {
    return {
      ok: false,
      error: createStructuredFileError("Public file URL not found.", "Pass a public URL id owned by the current user."),
    };
  }
  return {
    ok: true,
    data: { publicUrl: { id: publicUrlId, revokedAt: now } },
    error: null,
  };
}

async function deletePrivateFile(database, auth, fileId) {
  const row = fileRowForOwner(database, fileId, auth.userId);
  if (!row) {
    return {
      ok: false,
      error: createStructuredFileError("File not found.", "Pass the id of a private file owned by the current user."),
    };
  }
  const now = new Date().toISOString();
  database.sqlite.prepare("UPDATE sporades_files SET deletedAt = ?, updatedAt = ? WHERE id = ?").run(now, now, row.id);
  database.sqlite
    .prepare("UPDATE sporades_file_public_urls SET revokedAt = ? WHERE fileId = ? AND revokedAt IS NULL")
    .run(now, row.id);
  await removeFileVersionBestEffort(database, row.id, row.version);
  return {
    ok: true,
    data: { file: fileMetadataFromRow({ ...row, deletedAt: now }) },
    error: null,
  };
}

function validatePublicUrlExpiry(options) {
  const choices = [options.ttlSeconds !== undefined, options.expires !== undefined, options.noExpiry === true].filter(Boolean);
  if (choices.length !== 1) {
    return {
      ok: false,
      error: createStructuredFileError(
        "Public file URLs require exactly one expiry choice.",
        "Pass exactly one of ttlSeconds, expires, or noExpiry: true.",
      ),
    };
  }
  if (options.noExpiry === true) {
    return { ok: true, expiresAt: null };
  }
  if (options.ttlSeconds !== undefined) {
    const ttlSeconds = Number(options.ttlSeconds);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return {
        ok: false,
        error: createStructuredFileError("Invalid public file URL TTL.", "Pass a positive ttlSeconds number."),
      };
    }
    return { ok: true, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }
  const expiresAt = new Date(options.expires);
  if (Number.isNaN(expiresAt.getTime())) {
    return {
      ok: false,
      error: createStructuredFileError("Invalid public file URL expiry.", "Pass expires as a valid ISO date string."),
    };
  }
  return { ok: true, expiresAt: expiresAt.toISOString() };
}

function fileRowForOwner(database, fileId, ownerId) {
  return (
    database.sqlite
      .prepare("SELECT * FROM sporades_files WHERE id = ? AND ownerId = ? AND deletedAt IS NULL AND status = ?")
      .get(fileId, ownerId, "uploaded") ?? null
  );
}

function fileMetadataFromRow(row) {
  return {
    id: row.id,
    bucket: row.bucketName,
    size: Number(row.size),
    type: row.type,
    name: row.name,
    path: `/__sporades/files/private/${row.id}?v=${encodeURIComponent(row.version)}`,
    version: row.version,
  };
}

function createStructuredFileError(message, hint) {
  return { message, hint };
}

function fileStoragePath(database, fileId) {
  return `${database.fileStoragePath}/${fileId}`;
}

function fileVersionPath(database, fileId, version) {
  return `${fileStoragePath(database, fileId)}/${version}`;
}

async function removeFileVersionBestEffort(database, fileId, version) {
  const { rm } = await import("node:fs/promises");
  await rm(fileVersionPath(database, fileId, version), { force: true });
}

async function runEndpoint(database, endpoint, requestUrl, request) {
  const createHandler = new Function(`return (${endpoint.handlerSource});`);
  const handler = createHandler();
  const context = await applyContextMiddleware(
    database,
    await createEndpointContext(database, requestUrl, request),
    "endpoint",
  );
  return handler(context);
}

async function createEndpointContext(database, requestUrl, request) {
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value.join(", ") : value,
    ]),
  );
  const query = Object.fromEntries(requestUrl.searchParams.entries());
  const session = resolveAnonymousSession(database, readEndpointSessionToken(headers, query));

  return {
    db: createEndpointDatabaseApi(database),
    auth: session.auth,
    env: database.serverEnv,
    log: createEndpointLogger(),
    request: {
      method: request.method,
      path: requestUrl.pathname,
      headers,
      query,
      body: await readEndpointBody(request, headers),
    },
  };
}

function applyContextMiddleware(database, baseContext, kind) {
  let context = {
    ...baseContext,
    kind,
  };
  for (const middlewareSource of database.contextMiddleware) {
    const result = runContextMiddleware(middlewareSource, context);
    if (result && typeof result.then === "function") {
      throw commandError(
        "Async context middleware is not supported.",
        "Use synchronous context middleware for queries, mutations, and endpoints.",
      );
    }
    context = result ?? context;
  }
  return context;
}

function runContextMiddleware(middlewareSource, context) {
  const createMiddleware = new Function(`return (${middlewareSource});`);
  const middleware = createMiddleware();
  return middleware(context);
}

function readEndpointSessionToken(headers, query) {
  return headers["x-sporades-session-token"] ?? query.sessionToken;
}

function createEndpointDatabaseApi(database) {
  return Object.fromEntries(
    database.schema.tables.map((table) => [table.name, createEndpointTableApi(database, table)]),
  );
}

function createEndpointTableApi(database, table, query = {}) {
  return {
    insert(values) {
      const now = new Date().toISOString();
      const row = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...Object.fromEntries(
          table.fields.map((field) => [
            field.name,
            fieldValueForWrite(
              database,
              field,
              Object.hasOwn(values, field.name) ? values[field.name] : field.defaultValue,
            ),
          ]),
        ),
      };
      const columns = Object.keys(row);
      database.sqlite
        .prepare(
          `INSERT INTO ${quoteIdentifier(table.name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns
            .map(() => "?")
            .join(", ")})`,
        )
        .run(...columns.map((column) => row[column]));
      database.rowCache.clear();
      return deserializeRow(table, row);
    },
    where(fieldName, value) {
      return createEndpointTableApi(database, table, { ...query, where: { fieldName, value } });
    },
    orderBy(fieldName, direction = "asc") {
      return createEndpointTableApi(database, table, { ...query, orderBy: { fieldName, direction } });
    },
    limit(count) {
      return createEndpointTableApi(database, table, { ...query, limit: count });
    },
    all() {
      const whereSql = query.where ? ` WHERE ${quoteIdentifier(query.where.fieldName)} = ?` : "";
      const orderSql = query.orderBy
        ? ` ORDER BY ${quoteIdentifier(query.orderBy.fieldName)} ${
            String(query.orderBy.direction).toLowerCase() === "desc" ? "DESC" : "ASC"
          }`
        : "";
      const limit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : null;
      const limitSql = limit === null ? "" : " LIMIT ?";
      const params = query.where ? [serializeFieldValue(table.fields.find((field) => field.name === query.where.fieldName), query.where.value)] : [];
      return database.sqlite
        .prepare(`SELECT * FROM ${quoteIdentifier(table.name)}${whereSql}${orderSql}${limitSql}`)
        .all(...(limit === null ? params : [...params, limit]))
        .map((row) => deserializeRow(table, row));
    },
  };
}

function fieldValueForWrite(database, field, value) {
  if (field.kind === "Reference" && value !== undefined && value !== null && !referenceExists(database, field, value)) {
    throw invalidReferenceError(field);
  }
  return serializeFieldValue(field, value);
}

function invalidReferenceError(field) {
  return commandError(`Invalid reference for field: ${field.name}`, `Pass the id of an existing ${field.targetTable} row.`);
}

function referenceExists(database, field, value) {
  return Boolean(
    database.sqlite
      .prepare(`SELECT 1 FROM ${quoteIdentifier(field.targetTable)} WHERE id = ? LIMIT 1`)
      .get(String(value)),
  );
}

function serializeFieldValue(field, value) {
  if (field?.kind === "Boolean") {
    return value ? 1 : 0;
  }
  if (field?.kind === "Number") {
    return toSqlNumber(value, field.name);
  }
  if (field?.kind === "Date") {
    return normalizeDateValue(value, field.name);
  }
  if (field?.kind === "Json") {
    assertJsonCompatible(value);
    return JSON.stringify(value);
  }
  if (field?.kind === "Reference") {
    return value === undefined || value === null ? null : String(value);
  }
  return String(value ?? "");
}

function normalizeDateValue(value, fieldName) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw dateValueError(fieldName);
    }
    return value.toISOString();
  }
  if (typeof value !== "string") {
    throw dateValueError(fieldName);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw dateValueError(fieldName);
  }
  return parsed.toISOString();
}

function dateValueError(fieldName) {
  return commandError(
    `Invalid date value for field: ${fieldName}`,
    "Pass an ISO 8601 date string or JavaScript Date value.",
  );
}

function assertJsonCompatible(value) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw invalidJsonFieldValueError();
    }
    JSON.parse(serialized);
  } catch (error) {
    if (error?.hint) {
      throw error;
    }
    throw invalidJsonFieldValueError();
  }
}

function invalidJsonFieldValueError() {
  return commandError(
    "Invalid JSON field value.",
    "Use only JSON-compatible values: objects, arrays, strings, numbers, booleans, or null.",
  );
}

function deserializeRow(table, row) {
  const output = { ...row };
  for (const field of table.fields) {
    if (field.kind === "Boolean") {
      output[field.name] = Boolean(output[field.name]);
    } else if (field.kind === "Json") {
      output[field.name] = JSON.parse(output[field.name]);
    }
    if (field.kind === "Number") {
      output[field.name] = output[field.name] === null ? null : Number(output[field.name]);
    }
  }
  return output;
}

async function readEndpointBody(request, headers) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return null;
  }
  if ((headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
    return JSON.parse(raw);
  }
  return raw;
}

function createEndpointLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function writeEndpointResult(response, result) {
  if (result && typeof result === "object" && !Buffer.isBuffer(result) && "body" in result) {
    const status = result.status ?? 200;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw endpointResponseError();
    }
    if (
      result.headers !== undefined &&
      (result.headers === null || typeof result.headers !== "object" || Array.isArray(result.headers))
    ) {
      throw endpointResponseError();
    }
    const headers = { ...(result.headers ?? {}) };
    const body = result.body ?? null;
    if (body !== null && typeof body === "object" && !Buffer.isBuffer(body)) {
      headers["content-type"] ??= "application/json; charset=utf-8";
      let payload;
      try {
        payload = JSON.stringify(body);
      } catch {
        throw endpointResponseError();
      }
      response.writeHead(status, headers);
      response.end(payload);
      return;
    }
    headers["content-type"] ??= "text/plain; charset=utf-8";
    response.writeHead(status, headers);
    response.end(String(body ?? ""));
    return;
  }

  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end(String(result ?? ""));
}

function writeEndpointError(response, error) {
  response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  response.end(
    `${JSON.stringify({
      ok: false,
      data: null,
      error: {
        message: error?.hint
          ? error.message
          : error?.sporadesEndpointResponse
            ? "Invalid endpoint response."
            : "Endpoint handler failed.",
        hint: error?.sporadesEndpointResponse
          ? "Return { status, headers, body } with a numeric status, plain object headers, and a serializable body."
          : error?.hint
            ? error.hint
          : "Check the endpoint handler and retry the request.",
      },
    })}\n`,
  );
}

function endpointResponseError() {
  const error = new Error("Invalid endpoint response.");
  error.sporadesEndpointResponse = true;
  return error;
}

function parseFieldDefault(kind, rawDefault) {
  if (rawDefault === undefined) {
    return undefined;
  }
  if (kind === "Boolean") {
    return rawDefault.trim() === "true";
  }
  if (kind === "Number") {
    const value = Number(rawDefault.trim());
    if (!Number.isFinite(value)) {
      throw commandError("Invalid Number() default.", "Pass a finite JavaScript number to Number().default(...).");
    }
    return value;
  }
  const defaultValue = rawDefault.trim().replace(/^["']|["']$/g, "");
  if (kind === "Date") {
    return normalizeDateValue(defaultValue, "default");
  }
  if (kind === "Json") {
    return parseJsonFieldDefault(rawDefault);
  }
  return defaultValue;
}

function parseJsonFieldDefault(rawDefault) {
  try {
    const createDefault = new Function(`return (${rawDefault});`);
    const value = createDefault();
    assertJsonCompatible(value);
    return value;
  } catch {
    throw commandError(
      "Invalid JSON field default.",
      "Use a JSON-compatible default value for Json().default(...).",
    );
  }
}

function toSqlLiteral(value, field = null) {
  if (field?.kind === "Json") {
    assertJsonCompatible(value);
    return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function listDatabaseTables(database) {
  return database.sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

export function dumpDatabase(database) {
  return listDatabaseTables(database).map((tableName) => ({
    name: tableName,
    columns: database.sqlite
      .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
      .all()
      .map((column) => column.name),
    rows: database.sqlite.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all(),
  }));
}

export function runReadOnlyQuery(database, sql) {
  try {
    const statement = database.sqlite.prepare(sql);
    const columns = statement.columns().map((column) => column.name);
    const rows = statement.all();
    return {
      ok: true,
      data: {
        columns,
        rows,
      },
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: {
        message: error.message,
        hint: "Check the SQL syntax and table names, then retry the query.",
      },
    };
  }
}

export function simulateLocalIdentitySession(database, options = {}) {
  const provider = String(options.provider ?? "").trim().toLowerCase();
  if (!["email", "google"].includes(provider)) {
    return {
      ok: false,
      data: null,
      error: {
        message: `Unsupported simulated auth provider: ${provider || ""}`.trim(),
        hint: "Use `sporades auth as email` for local identity simulation. Google simulation is reserved for provider-shaped browser tests.",
      },
    };
  }

  const email = normalizeSimulatedEmail(options.email);
  if (!email) {
    return {
      ok: false,
      data: null,
      error: {
        message: "Simulated identity requires an email address.",
        hint: "Pass `--email <address>` to `sporades auth as email`.",
      },
    };
  }

  const displayName = normalizeSimulatedText(options.displayName) ?? email;
  const picture = normalizeSimulatedText(options.picture);
  const now = new Date().toISOString();
  const existing = database.sqlite
    .prepare("SELECT id FROM sporades_auth_users WHERE provider = ? AND email = ?")
    .get(provider, email);
  const userId = existing?.id ?? randomUUID();
  const token = randomBytes(32).toString("base64url");

  if (existing) {
    database.sqlite
      .prepare(
        "UPDATE sporades_auth_users SET displayName = ?, picture = ?, isAuthenticated = ?, isGuest = ? WHERE id = ?",
      )
      .run(displayName, picture, 1, 0, userId);
  } else {
    database.sqlite
      .prepare(
        "INSERT INTO sporades_auth_users " +
          "(id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(userId, now, displayName, email, picture, 1, 0, provider);
  }
  database.sqlite
    .prepare("INSERT INTO sporades_auth_sessions (token, userId, createdAt) VALUES (?, ?, ?)")
    .run(token, userId, now);

  const auth = {
    userId,
    displayName,
    email,
    picture,
    isAuthenticated: true,
    isGuest: false,
    provider,
  };
  return {
    ok: true,
    data: {
      localStorage: {
        key: "sporades.sessionToken",
        value: token,
      },
      auth,
    },
    error: null,
  };
}

function normalizeSimulatedEmail(value) {
  const email = normalizeSimulatedText(value)?.toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return null;
  }
  return email;
}

function normalizeSimulatedText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

export function createWebSocketHub(getDatabase) {
  const clients = new Set();
  let nextClientId = 1;

  return {
    accept(request, socket) {
      const key = request.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }

      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
          "",
          "",
        ].join("\r\n"),
      );

      const requestUrl = new URL(request.url, "http://127.0.0.1");
      const sessionToken = requestUrl.searchParams.get("sessionToken");
      const protocol = request.socket?.encrypted ? "https" : "http";
      const origin = `${protocol}://${request.headers.host}`;
      const database = getDatabase();
      const session = resolveAnonymousSession(database, sessionToken);
      const now = new Date().toISOString();
      const client = {
        id: `client-${(nextClientId++).toString(36)}`,
        socket,
        buffer: Buffer.alloc(0),
        subscriptions: new Map(),
        session,
        origin,
        connectedAt: now,
        lastSeenAt: now,
      };
      clients.add(client);
      socket.on("data", (chunk) => {
        client.lastSeenAt = new Date().toISOString();
        client.buffer = Buffer.concat([client.buffer, chunk]);
        drainWebSocketFrames(client, (message) => handleClientMessage(client, message));
      });
      socket.on("close", () => clients.delete(client));
      socket.on("error", () => clients.delete(client));
    },
    disconnectAll() {
      for (const client of clients) {
        client.socket.end();
      }
      clients.clear();
    },
    listAuthClients() {
      return [...clients].map((client) => ({
        id: client.id,
        connectedAt: client.connectedAt,
        lastSeenAt: client.lastSeenAt,
        auth: summarizeAuthForClientList(client.session.auth),
      }));
    },
    notifyFileEvent(userId, event) {
      for (const client of clients) {
        if (client.session.auth.userId !== userId) {
          continue;
        }
        sendJson(client, {
          id: null,
          type: "file.event",
          data: event,
          error: null,
        });
      }
    },
    deliverAuthSession(target, sessionData) {
      const recipients = authSessionRecipients(target);
      for (const client of recipients) {
        client.session = {
          token: sessionData.localStorage.value,
          auth: sessionData.auth,
        };
        sendJson(client, {
          id: null,
          type: "auth.session.replace",
          data: {
            sessionToken: sessionData.localStorage.value,
            auth: sessionData.auth,
          },
          error: null,
        });
      }
      return {
        target,
        delivered: recipients.length > 0,
        clients: recipients.length,
      };
    },
  };

  function authSessionRecipients(target) {
    if (target === "all") {
      return [...clients];
    }
    if (target === "current") {
      return [...clients].slice(-1);
    }
    return [...clients].filter((client) => client.id === target);
  }

  function summarizeAuthForClientList(auth) {
    return {
      userId: auth.userId,
      displayName: auth.displayName,
      email: auth.email,
      picture: auth.picture,
      isAuthenticated: auth.isAuthenticated,
      isGuest: auth.isGuest,
      provider: auth.provider,
    };
  }

  function handleClientMessage(client, rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      sendJson(client, {
        id: null,
        type: "error",
        error: {
          message: "Invalid WebSocket message.",
          hint: "Send a JSON object with a supported Sporades message type.",
        },
      });
      return;
    }

    const database = getDatabase();
    if (message.type === "auth.get") {
      sendAuthResult(client, message.id ?? null);
      return;
    }

    if (message.type === "auth.signOut") {
      const result = signOutSession(database, client);
      sendJson(client, {
        id: message.id ?? null,
        type: result.ok ? "auth.signOut.result" : "error",
        data: result.ok ? { ok: true } : null,
        error: result.error ?? null,
      });
      return;
    }

    if (message.type === "auth.signUp") {
      const result = signUpWithEmail(database, client.session, message.provider, message.credentials ?? {});
      if (result.ok) {
        client.session = {
          token: result.sessionToken,
          auth: result.auth,
        };
      }
      sendJson(client, {
        id: message.id ?? null,
        type: result.ok ? "auth.signUp.result" : "error",
        data: result.ok ? { ok: true, sessionToken: result.sessionToken, auth: result.auth } : null,
        error: result.error ?? null,
      });
      return;
    }

    if (message.type === "auth.signIn" || message.type === "auth.signInWithGoogle") {
      const provider = message.type === "auth.signInWithGoogle" ? "google" : message.provider;
      if (provider === "email") {
        const result = signInWithEmail(database, client.session, message.credentials ?? {});
        if (result.ok) {
          client.session = {
            token: result.sessionToken,
            auth: result.auth,
          };
        }
        sendJson(client, {
          id: message.id ?? null,
          type: result.ok ? "auth.signIn.result" : "error",
          data: result.ok ? { ok: true, sessionToken: result.sessionToken, auth: result.auth } : null,
          error: result.error ?? null,
        });
        return;
      }
      if (provider !== "google") {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          error: {
            message: `Unsupported auth provider: ${provider ?? ""}`.trim(),
            hint: "Use auth.signIn with a configured provider such as google.",
          },
        });
        return;
      }
      const result = beginGoogleSignIn(database, client.session, {
        origin: client.origin,
        returnTo: message.returnTo,
      });
      if (!result.ok) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          error: result.error,
        });
        return;
      }
      sendJson(client, {
        id: message.id ?? null,
        type: "auth.redirect",
        data: { url: result.url },
        error: null,
      });
      return;
    }

    if (message.type === "query.subscribe") {
      const queryName = message.query ?? message.name;
      client.subscriptions.set(message.id, { id: message.id, name: queryName, style: message.query ? "direct" : "rows" });
      sendQueryResult(client, client.subscriptions.get(message.id));
      return;
    }

    if (message.type === "mutation.run") {
      const mutationName = message.mutation ?? message.name;
      const result = runMutation(database, client.session.auth, mutationName, message.args ?? []);
      sendJson(client, formatMutationResult(message, mutationName, result));
      if (result.ok) {
        for (const subscribedClient of clients) {
          if (subscribedClient.session.auth.userId !== client.session.auth.userId) {
            continue;
          }
          for (const subscription of subscribedClient.subscriptions.values()) {
            sendQueryResult(subscribedClient, subscription);
          }
        }
      }
      return;
    }

    if (message.type === "app.send") {
      const messageName = message.message ?? message.name;
      const result = runAppMessage(database, client.session.auth, messageName, message.data, {
        sendAppMessage,
      });
      sendJson(client, {
        id: message.id ?? null,
        type: "app.result",
        message: messageName,
        data: result.data ?? null,
        error: result.error,
      });
      return;
    }

    if (message.type === "file.uploadUrl") {
      const result = createPendingFileUpload(database, client.session.auth, message);
      sendJson(client, {
        id: message.id ?? null,
        type: result.ok ? "file.uploadUrl.result" : "error",
        data: result.data ?? null,
        error: result.error,
      });
      return;
    }

    if (message.type === "file.url") {
      const result = getPrivateFileUrl(database, client.session.auth, message.fileId, client.session.token);
      sendJson(client, {
        id: message.id ?? null,
        type: result.ok ? "file.url.result" : "error",
        data: result.data ?? null,
        error: result.error,
      });
      return;
    }

    if (message.type === "file.publicUrl.create") {
      const result = createPublicFileUrl(database, client.session.auth, message.fileId, message.options ?? {});
      sendJson(client, {
        id: message.id ?? null,
        type: result.ok ? "file.publicUrl.result" : "error",
        data: result.data ?? null,
        error: result.error,
      });
      return;
    }

    if (message.type === "file.publicUrl.revoke") {
      const result = revokePublicFileUrl(database, client.session.auth, message.publicUrlId);
      sendJson(client, {
        id: message.id ?? null,
        type: result.ok ? "file.publicUrl.revoke.result" : "error",
        data: result.data ?? null,
        error: result.error,
      });
      return;
    }

    if (message.type === "file.delete") {
      deletePrivateFile(database, client.session.auth, message.fileId).then((result) => {
        sendJson(client, {
          id: message.id ?? null,
          type: result.ok ? "file.delete.result" : "error",
          data: result.data ?? null,
          error: result.error,
        });
      });
      return;
    }

    sendJson(client, {
      id: message.id ?? null,
      type: "error",
      error: {
        message: `Unsupported WebSocket message: ${message.type ?? ""}`.trim(),
        hint: "Use auth.get, auth.signIn, auth.signOut, query.subscribe, mutation.run, app messages, or files.* through the Sporades client SDK.",
      },
    });
  }

  function sendQueryResult(client, subscription) {
    const database = getDatabase();
    const result = runQuery(database, client.session.auth, subscription.name);
    const data =
      subscription.style === "direct"
        ? (result.data ?? result.rows)
        : { rows: result.data ?? result.rows };
    sendJson(client, {
      id: subscription.id,
      type: "query.result",
      query: subscription.name,
      data,
      error: result.error,
    });
  }

  function sendAuthResult(client, id) {
    const database = getDatabase();
    client.session = resolveAnonymousSession(database, client.session.token);
    sendJson(client, {
      id,
      type: "auth.result",
      data: {
        sessionToken: client.session.token,
        auth: client.session.auth,
        providers: authProvidersForClient(database.authConfig),
      },
      error: null,
    });
  }

  function signOutSession(database, client) {
    try {
      database.sqlite.prepare("DELETE FROM sporades_auth_sessions WHERE token = ?").run(client.session.token);
      client.session = resolveAnonymousSession(database, null);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: "Could not sign out.",
          hint: "Retry sign-out. If this keeps happening, restart the Sporades dev session.",
        },
      };
    }
  }

  function sendAppMessage(senderAuth, appMessage) {
    const scope = appMessage.scope ?? { scope: "user", userId: senderAuth.userId };
    const recipients = clientsForAppMessageScope(scope, senderAuth);
    for (const recipient of recipients) {
      sendJson(recipient, {
        type: "app.message",
        message: appMessage.type,
        data: appMessage.data ?? null,
      });
    }
    return recipients.length;
  }

  function clientsForAppMessageScope(scope, senderAuth) {
    if (scope === "all" || scope?.scope === "all") {
      return [...clients];
    }
    if (scope?.scope === "users") {
      const userIds = new Set((scope.userIds ?? []).map(String));
      return [...clients].filter((candidate) => userIds.has(candidate.session.auth.userId));
    }
    const userId = scope?.userId ?? senderAuth.userId;
    return [...clients].filter((candidate) => candidate.session.auth.userId === userId);
  }
}

export async function routeSporadesAuth(database, request, response) {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  if (request.method !== "GET" || requestUrl.pathname !== "/__sporades/auth/google/callback") {
    return false;
  }

  const state = requestUrl.searchParams.get("state");
  const code = requestUrl.searchParams.get("code");
  if (!state || !code) {
    writeEndpointError(response, commandError("Invalid Google OAuth callback.", "Retry Google sign-in from the app."));
    return true;
  }

  const stateRow = database.sqlite
    .prepare("SELECT state, sessionToken, returnTo, redirectUri FROM sporades_auth_oauth_states WHERE state = ?")
    .get(state);
  database.sqlite.prepare("DELETE FROM sporades_auth_oauth_states WHERE state = ?").run(state);
  if (!stateRow) {
    writeEndpointError(response, commandError("Invalid Google OAuth state.", "Retry Google sign-in from the app."));
    return true;
  }

  try {
    const profile = await exchangeGoogleCode(database, code, stateRow.redirectUri);
    const session = resolveAnonymousSession(database, stateRow.sessionToken);
    const result = linkGoogleAccount(database, session, profile);
    if (!result.ok) {
      throw commandError(result.error.message, result.error.hint);
    }
    writeRedirect(response, stateRow.returnTo);
  } catch (error) {
    writeEndpointError(response, error);
  }
  return true;
}

function beginGoogleSignIn(database, session, options) {
  if (!database.authConfig.providers.google.enabled || !database.authConfig.google.configured) {
    return {
      ok: false,
      error: {
        message: "Google OAuth is not configured.",
        hint: "Run `sporades auth set google --client-id <id> --client-secret <secret>` or `sporades auth set google --client-json <path>`.",
      },
    };
  }
  const origin = options.origin;
  const redirectUri = `${origin}/__sporades/auth/google/callback`;
  const returnTo = normalizeReturnTo(options.returnTo, origin);
  const state = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  database.sqlite
    .prepare(
      "INSERT INTO sporades_auth_oauth_states (state, sessionToken, returnTo, redirectUri, createdAt) VALUES (?, ?, ?, ?, ?)",
    )
    .run(state, session.token, returnTo, redirectUri, now);

  const clientId = database.serverEnv[database.authConfig.google.clientIdEnv];
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
  });
  return {
    ok: true,
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  };
}

function normalizeReturnTo(returnTo, origin) {
  if (!returnTo) {
    return origin;
  }
  try {
    const url = new URL(returnTo, origin);
    if (url.origin !== origin) {
      return origin;
    }
    return url.toString();
  } catch {
    return origin;
  }
}

async function exchangeGoogleCode(database, code, redirectUri) {
  const google = database.authConfig.google;
  const tokenUrl = process.env.SPORADES_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
  const clientId = database.serverEnv[google.clientIdEnv];
  const clientSecret = database.serverEnv[google.clientSecretEnv];
  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) {
    const details = await readGoogleOAuthError(tokenResponse);
    throw commandError(
      `Google OAuth code exchange failed${details.message ? `: ${details.message}` : "."}`,
      details.hint,
    );
  }
  const token = await tokenResponse.json();
  if (!token.access_token) {
    throw commandError("Google OAuth response did not include an access token.", "Check the Google OAuth client configuration and retry sign-in.");
  }
  return fetchGoogleProfile(token.access_token);
}

async function readGoogleOAuthError(response) {
  const fallback = {
    message: "",
    hint: "Check the Google OAuth client configuration and retry sign-in.",
  };
  let body;
  try {
    body = await response.text();
  } catch {
    return fallback;
  }
  if (!body) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(body);
    const code = parsed.error ? String(parsed.error) : "";
    const description = parsed.error_description ? String(parsed.error_description) : "";
    return {
      message: [code, description].filter(Boolean).join(": "),
      hint: oauthErrorHint(code, description),
    };
  } catch {
    return {
      message: body.slice(0, 240),
      hint: fallback.hint,
    };
  }
}

function oauthErrorHint(code, description) {
  const detail = `${code} ${description}`.toLowerCase();
  if (detail.includes("redirect_uri_mismatch") || detail.includes("redirect_uri")) {
    return "Make sure Google Console has the exact authorized redirect URI shown in the browser callback URL, including scheme, host, and port.";
  }
  if (detail.includes("invalid_client")) {
    return "Check that the Client ID and Client secret belong to the same Web application OAuth client.";
  }
  if (detail.includes("invalid_grant")) {
    return "Retry sign-in from the app. OAuth codes can only be used once and expire quickly; also check that the redirect URI has not changed.";
  }
  return "Check the Google OAuth client configuration and retry sign-in.";
}

async function fetchGoogleProfile(accessToken) {
  const userInfoUrl = process.env.SPORADES_GOOGLE_USERINFO_URL ?? "https://www.googleapis.com/oauth2/v3/userinfo";
  const profileResponse = await fetch(userInfoUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!profileResponse.ok) {
    throw commandError("Google profile lookup failed.", "Retry Google sign-in with an email-bearing account.");
  }
  const profile = await profileResponse.json();
  return {
    email: profile.email,
    displayName: profile.name ?? profile.email,
    picture: profile.picture ?? null,
  };
}

function linkGoogleAccount(database, session, profile) {
  if (!profile.email) {
    return {
      ok: false,
      error: {
        message: "Google profile is missing an email address.",
        hint: "Retry Google sign-in with an email-bearing account.",
      },
    };
  }

  const auth = {
    userId: session.auth.userId,
    displayName: profile.displayName ?? profile.email,
    email: profile.email,
    picture: profile.picture ?? null,
    isAuthenticated: true,
    isGuest: false,
    provider: "google",
  };
  database.sqlite
    .prepare(
      "UPDATE sporades_auth_users SET displayName = ?, email = ?, picture = ?, isAuthenticated = ?, isGuest = ?, provider = ? WHERE id = ?",
    )
    .run(auth.displayName, auth.email, auth.picture, 1, 0, "google", auth.userId);
  return { ok: true, auth };
}

function writeRedirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

function signUpWithEmail(database, session, provider, credentials) {
  if (provider !== "email") {
    return {
      ok: false,
      error: {
        message: `Unsupported auth provider: ${provider ?? ""}`.trim(),
        hint: "Use auth.signUp with the email provider.",
      },
    };
  }
  if (!database.authConfig.providers.email.enabled) {
    return { ok: false, error: emailAuthDisabledError() };
  }

  const normalized = normalizeEmailCredentials(credentials);
  if (!normalized.ok) {
    return normalized;
  }

  const existing = database.sqlite
    .prepare("SELECT email FROM sporades_auth_email_credentials WHERE email = ?")
    .get(normalized.email);
  if (existing) {
    return {
      ok: false,
      error: {
        message: "Email is already registered.",
        hint: "Use auth.signIn(\"email\", ...) with this email address.",
      },
    };
  }

  const password = hashEmailPassword(normalized.password);
  const displayName = normalized.name || normalized.email;
  const auth = {
    userId: session.auth.userId,
    displayName,
    email: normalized.email,
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  database.sqlite
    .prepare(
      "INSERT INTO sporades_auth_email_credentials (email, userId, passwordHash, passwordSalt, createdAt) VALUES (?, ?, ?, ?, ?)",
    )
    .run(normalized.email, auth.userId, password.hash, password.salt, new Date().toISOString());
  database.sqlite
    .prepare(
      "UPDATE sporades_auth_users SET displayName = ?, email = ?, picture = ?, isAuthenticated = ?, isGuest = ?, provider = ? WHERE id = ?",
    )
    .run(auth.displayName, auth.email, auth.picture, 1, 0, "email", auth.userId);
  return { ok: true, sessionToken: session.token, auth };
}

function signInWithEmail(database, session, credentials) {
  if (!database.authConfig.providers.email.enabled) {
    return { ok: false, error: emailAuthDisabledError() };
  }

  const normalized = normalizeEmailCredentials(credentials);
  if (!normalized.ok) {
    return normalized;
  }

  const row = database.sqlite
    .prepare(
      "SELECT c.email, c.userId, c.passwordHash, c.passwordSalt, u.displayName, u.picture, u.isAuthenticated, u.isGuest, u.provider " +
        "FROM sporades_auth_email_credentials c " +
        "JOIN sporades_auth_users u ON u.id = c.userId " +
        "WHERE c.email = ?",
    )
    .get(normalized.email);
  if (!row || !verifyEmailPassword(normalized.password, row.passwordSalt, row.passwordHash)) {
    return {
      ok: false,
      error: {
        message: "Email or password is incorrect.",
        hint: "Check the credentials and try email sign-in again.",
      },
    };
  }

  database.sqlite.prepare("UPDATE sporades_auth_sessions SET userId = ? WHERE token = ?").run(row.userId, session.token);
  const auth = {
    userId: row.userId,
    displayName: row.displayName,
    email: row.email,
    picture: row.picture,
    isAuthenticated: Boolean(row.isAuthenticated),
    isGuest: Boolean(row.isGuest),
    provider: row.provider,
  };
  return { ok: true, sessionToken: session.token, auth };
}

function normalizeEmailCredentials(credentials) {
  const email = String(credentials.email ?? "").trim().toLowerCase();
  const password = String(credentials.password ?? "");
  const name = credentials.name == null ? "" : String(credentials.name).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      ok: false,
      error: {
        message: "Email address is invalid.",
        hint: "Pass credentials with a valid email address.",
      },
    };
  }
  if (password.length < 8) {
    return {
      ok: false,
      error: {
        message: "Password is too short.",
        hint: "Use a password with at least 8 characters.",
      },
    };
  }
  return { ok: true, email, password, name };
}

function hashEmailPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return { hash, salt };
}

function verifyEmailPassword(password, salt, expectedHash) {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function emailAuthDisabledError() {
  return {
    message: "Email auth is not enabled.",
    hint: "Enable auth.providers.email in sporades.json.",
  };
}

function createAnonymousAuthTables(sqlite, authConfig = null) {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_auth_users (" +
      "id TEXT PRIMARY KEY, " +
      "createdAt TEXT NOT NULL, " +
      "displayName TEXT NOT NULL, " +
      "email TEXT, " +
      "picture TEXT, " +
      "isAuthenticated INTEGER NOT NULL, " +
      "isGuest INTEGER NOT NULL, " +
      "provider TEXT NOT NULL" +
      ")",
  );
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_auth_sessions (" +
      "token TEXT PRIMARY KEY, " +
      "userId TEXT NOT NULL, " +
      "createdAt TEXT NOT NULL" +
      ")",
  );
  if (authConfig?.providers?.email?.enabled) {
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS sporades_auth_email_credentials (" +
        "email TEXT PRIMARY KEY, " +
        "userId TEXT NOT NULL, " +
        "passwordHash TEXT NOT NULL, " +
        "passwordSalt TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL" +
        ")",
    );
  }
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_auth_oauth_states (" +
      "state TEXT PRIMARY KEY, " +
      "sessionToken TEXT NOT NULL, " +
      "returnTo TEXT NOT NULL, " +
      "redirectUri TEXT NOT NULL, " +
      "createdAt TEXT NOT NULL" +
      ")",
  );
}

function resolveAnonymousSession(database, sessionToken) {
  if (sessionToken) {
    const existing = database.sqlite
      .prepare(
        "SELECT s.token, u.id AS userId, u.displayName, u.email, u.picture, u.isAuthenticated, u.isGuest, u.provider " +
          "FROM sporades_auth_sessions s " +
          "JOIN sporades_auth_users u ON u.id = s.userId " +
          "WHERE s.token = ?",
      )
      .get(sessionToken);
    if (existing) {
      return sessionFromRow(existing);
    }
  }

  const now = new Date().toISOString();
  const userId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  database.sqlite
    .prepare(
      "INSERT INTO sporades_auth_users " +
        "(id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(userId, now, "Anonymous", null, null, 0, 1, "anonymous");
  database.sqlite
    .prepare("INSERT INTO sporades_auth_sessions (token, userId, createdAt) VALUES (?, ?, ?)")
    .run(token, userId, now);
  return {
    token,
    auth: {
      userId,
      displayName: "Anonymous",
      email: null,
      picture: null,
      isAuthenticated: false,
      isGuest: true,
      provider: "anonymous",
    },
  };
}

function sessionFromRow(row) {
  return {
    token: row.token,
    auth: {
      userId: row.userId,
      displayName: row.displayName,
      email: row.email,
      picture: row.picture,
      isAuthenticated: Boolean(row.isAuthenticated),
      isGuest: Boolean(row.isGuest),
      provider: row.provider,
    },
  };
}

function createWebSocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function drainWebSocketFrames(client, onMessage) {
  while (client.buffer.length >= 2) {
    const firstByte = client.buffer[0];
    const secondByte = client.buffer[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let length = secondByte & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      length = Number(client.buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + length) return;

    const mask = masked ? client.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = client.buffer.subarray(offset, offset + length);
    client.buffer = client.buffer.subarray(offset + length);

    if (opcode === 8) {
      client.socket.end();
      return;
    }
    if (opcode !== 1) {
      continue;
    }

    const decoded = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      decoded[index] = mask ? payload[index] ^ mask[index % 4] : payload[index];
    }
    onMessage(decoded.toString("utf8"));
  }
}

function sendJson(client, message) {
  const payload = Buffer.from(JSON.stringify(message));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  client.socket.write(Buffer.concat([header, payload]));
}

function runQuery(database, auth, queryName) {
  let context;
  try {
    context = applyContextMiddleware(database, createMutationContext(database, auth), "query");
  } catch (error) {
    return {
      rows: null,
      error: {
        message: error.message,
        hint: error.hint ?? "Check the Capsule context middleware and retry the query.",
      },
    };
  }

  if (queryName === "ctx.env") {
    return { data: context.env, error: null };
  }

  const customResult = runCustomQuery(database, context, queryName);
  if (customResult) {
    return customResult;
  }

  const table = resolveTableForQuery(database.schema, queryName);
  if (!table) {
    return {
      rows: null,
      error: {
        message: `Unknown query: ${queryName}`,
        hint: "Use a query defined by the capsule.",
      },
    };
  }

  const cacheKey = `${table.name}:${context.auth.userId}`;
  if (!database.rowCache.has(cacheKey)) {
    const columns = ["id", "createdAt", "updatedAt", ...table.fields.map((field) => field.name)];
    const ownerScoped = table.fields.some((field) => field.name === "ownerId");
    const sql =
      `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table.name)}` +
      (ownerScoped ? " WHERE ownerId = ?" : "") +
      " ORDER BY createdAt DESC";
    const rows = database.sqlite
      .prepare(sql)
      .all(...(ownerScoped ? [context.auth.userId] : []))
      .map((row) => rowToApiValue(row, table));
    database.rowCache.set(cacheKey, rows);
  }

  return { rows: database.rowCache.get(cacheKey), error: null };
}

function runCustomQuery(database, context, queryName) {
  const handler = database.queries.find((candidate) => candidate.name === queryName);
  if (!handler) {
    return null;
  }

  try {
    const createHandler = new Function(`return (${handler.handlerSource});`);
    const data = createHandler()(context);
    assertJsonCompatible(data);
    return { data, error: null };
  } catch (error) {
    return {
      data: null,
      error: {
        message: error?.message || "Query handler failed.",
        hint: error?.hint ?? "Check the Capsule query handler and retry the query.",
      },
    };
  }
}

function runMutation(database, auth, mutationName, args) {
  let context;
  let result;
  database.sqlite.exec("BEGIN");
  try {
    context = applyContextMiddleware(database, createMutationContext(database, auth), "mutation");

    for (const hookSource of database.mutationHooks.beforeMutation) {
      runMutationHook(hookSource, { name: mutationName, args, ctx: context });
    }

    result = runCustomMutation(database, context, mutationName, args);
    if (!result) {
      result = mutationName.startsWith("update")
        ? runUpdateMutation(database, context.auth, mutationName, args)
        : runInsertMutation(database, context.auth, mutationName, args);
    }

    if (result.ok) {
      for (const hookSource of database.mutationHooks.afterMutation) {
        runMutationHook(hookSource, { name: mutationName, args, ctx: context, result });
      }
    }

    database.sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    database.sqlite.exec("ROLLBACK");
    database.rowCache.clear();
    return createHookErrorResult(error);
  }
}

function runCustomMutation(database, context, mutationName, args) {
  const handler = database.mutations.find((candidate) => candidate.name === mutationName);
  if (!handler) {
    return null;
  }

  const createHandler = new Function(`return (${handler.handlerSource});`);
  const result = createHandler()(context, ...args);
  if (result !== undefined) {
    assertJsonCompatible(result);
  }
  database.rowCache.clear();
  return { ok: true, error: null };
}

function runAppMessage(database, auth, messageName, data, options = {}) {
  if (!messageName) {
    return {
      data: null,
      error: {
        message: "Missing app message type.",
        hint: "Pass an unprefixed message name declared by the Capsule.",
      },
    };
  }

  try {
    validateAppMessageType(messageName);
  } catch (error) {
    return {
      data: null,
      error: {
        message: error.message,
        hint: error.hint,
      },
    };
  }

  const handler = database.messages.find((candidate) => candidate.name === messageName);
  if (!handler) {
    return {
      data: null,
      error: {
        message: `Unknown app message: ${messageName}`,
        hint: "Use an app message declared by the Capsule.",
      },
    };
  }

  try {
    if (data !== undefined) {
      assertJsonCompatible(data);
    }
    const context = applyContextMiddleware(
      database,
      createMessageContext(database, auth, options.sendAppMessage),
      "message",
    );
    const createHandler = new Function(`return (${handler.handlerSource});`);
    const result = createHandler()(context, data);
    if (result !== undefined) {
      assertJsonCompatible(result);
    }
    return { data: result ?? null, error: null };
  } catch (error) {
    return {
      data: null,
      error: {
        message: error?.message || "App message handler failed.",
        hint: error?.hint ?? "Check the Capsule message handler and retry the app message.",
      },
    };
  }
}

function validateAppMessageType(type) {
  const value = String(type ?? "");
  const reservedPrefixes = ["app.", "auth.", "query.", "mutation.", "file.", "files.", "runtime.", "upload."];
  const reservedExact = new Set(["error", "refresh"]);
  if (reservedExact.has(value) || reservedPrefixes.some((prefix) => value.startsWith(prefix))) {
    throw commandError(
      `Reserved app message type: ${value}`,
      "Use an unprefixed app message type that does not start with a Sporades platform namespace.",
    );
  }
  if (!value || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) {
    throw commandError(
      `Invalid app message type: ${value}`,
      "Use an unprefixed app message type containing letters, numbers, underscores, or hyphens.",
    );
  }
}

function isAllAppMessageScope(scope) {
  return scope === "all" || scope?.scope === "all";
}

function createMessageContext(database, auth, sendAppMessage) {
  return {
    ...createMutationContext(database, auth),
    messages: {
      send(appMessage) {
        validateAppMessageType(appMessage?.type);
        if (isAllAppMessageScope(appMessage?.scope)) {
          throw commandError(
            "Client-origin app messages cannot broadcast to all clients.",
            "Use the default current-user scope or an explicit users scope authorized by the message handler.",
          );
        }
        if (appMessage?.data !== undefined) {
          assertJsonCompatible(appMessage.data);
        }
        return sendAppMessage?.(auth, appMessage) ?? 0;
      },
    },
  };
}

function runMutationHook(hookSource, event) {
  const createHook = new Function(`return (${hookSource});`);
  const hook = createHook();
  return hook(event);
}

function createMutationContext(database, auth) {
  return {
    db: createEndpointDatabaseApi(database),
    auth,
    env: database.serverEnv,
    log: createEndpointLogger(),
  };
}

function createHookErrorResult(error) {
  return {
    ok: false,
    error: {
      message: error?.message || "Mutation hook failed.",
      hint: error?.hint ?? "Check the Capsule mutation hooks and retry the mutation.",
    },
  };
}

function runInsertMutation(database, auth, mutationName, args) {
  const table = resolveTableForAddMutation(database.schema, mutationName);
  if (!table) {
    return {
      ok: false,
      error: {
        message: `Unknown mutation: ${mutationName}`,
        hint: "Use a mutation defined by the capsule.",
      },
    };
  }

  const now = new Date().toISOString();
  const values = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  try {
    for (const field of table.fields) {
      if (field.name === "ownerId") {
        values[field.name] = auth.userId;
        continue;
      }
      if (field.name === "text") {
        values[field.name] = String(args[0] ?? "");
        continue;
      }
      const positionalIndex = table.fields.filter((candidate) => candidate.name !== "ownerId").indexOf(field);
      if (args[positionalIndex] !== undefined) {
        values[field.name] = fieldValueForWrite(database, field, args[positionalIndex]);
        continue;
      }
      if (field.defaultValue !== undefined) {
        values[field.name] = fieldValueForWrite(database, field, field.defaultValue);
      }
    }
  } catch (error) {
    return { ok: false, error: { message: error.message, hint: error.hint } };
  }
  const missingField = table.fields.find((field) => values[field.name] === undefined);
  if (missingField) {
    return {
      ok: false,
      error: {
        message: `Missing value for field: ${missingField.name}`,
        hint: "Pass a value accepted by the capsule mutation.",
      },
    };
  }

  const columns = Object.keys(values);
  database.sqlite
    .prepare(
      `INSERT INTO ${quoteIdentifier(table.name)} (` +
        columns.map(quoteIdentifier).join(", ") +
        ") VALUES (" +
        columns.map(() => "?").join(", ") +
        ")",
    )
    .run(...columns.map((column) => values[column]));
  database.rowCache.clear();
  return { ok: true, error: null };
}

function runUpdateMutation(database, auth, mutationName, args) {
  const resolved = resolveTableForUpdateMutation(database.schema, mutationName);
  if (!resolved) {
    return {
      ok: false,
      error: {
        message: `Unknown mutation: ${mutationName}`,
        hint: "Use a mutation defined by the capsule.",
      },
    };
  }

  const [id, value] = args;
  if (!id) {
    return {
      ok: false,
      error: {
        message: "Missing value for field: id",
        hint: "Pass a value accepted by the capsule mutation.",
      },
    };
  }
  if (value === undefined) {
    return {
      ok: false,
      error: {
        message: `Missing value for field: ${resolved.field.name}`,
        hint: "Pass a value accepted by the capsule mutation.",
      },
    };
  }

  const now = new Date().toISOString();
  const ownerScoped = resolved.table.fields.some((field) => field.name === "ownerId");
  let nextValue;
  try {
    nextValue = fieldValueForWrite(database, resolved.field, value);
  } catch (error) {
    return { ok: false, error: { message: error.message, hint: error.hint } };
  }

  database.sqlite
    .prepare(
      `UPDATE ${quoteIdentifier(resolved.table.name)} SET ${quoteIdentifier(resolved.field.name)} = ?, updatedAt = ? WHERE id = ?` +
        (ownerScoped ? " AND ownerId = ?" : ""),
    )
    .run(nextValue, now, id, ...(ownerScoped ? [auth.userId] : []));
  database.rowCache.clear();
  return { ok: true, error: null };
}

function formatMutationResult(message, mutationName, result) {
  const formatted = {
    id: message.id,
    type: "mutation.result",
    data: null,
    error: result.error,
  };
  if (message.mutation) {
    formatted.mutation = mutationName;
  } else if (message.name) {
    formatted.ok = result.ok;
  }
  return formatted;
}

function authStatus(config, serverEnv) {
  const authConfig = config.auth ?? { mode: "anonymous" };
  const normalized = normalizeAuthConfig(authConfig);
  const clientIdEnv = normalized.providers.google.clientIdEnv;
  const clientSecretEnv = normalized.providers.google.clientSecretEnv;
  const providers = {
    anonymous: {
      enabled: normalized.providers.anonymous.enabled,
    },
    google: {
      enabled: normalized.providers.google.enabled,
      configured: Boolean(clientIdEnv && clientSecretEnv && serverEnv[clientIdEnv] && serverEnv[clientSecretEnv]),
      clientIdEnv,
      clientSecretEnv,
    },
  };
  if (normalized.providers.email.enabled) {
    providers.email = {
      enabled: true,
    };
  }
  return {
    mode: normalized.mode,
    providers,
    google: {
      configured: providers.google.configured,
      clientIdEnv,
      clientSecretEnv,
    },
  };
}

function normalizeAuthConfig(authConfig) {
  const providerConfig = authConfig.providers ?? {};
  for (const provider of Object.keys(providerConfig)) {
    if (!["anonymous", "google", "email"].includes(provider)) {
      throw commandError(
        `Unsupported auth provider: ${provider}`,
        "Use supported auth providers: anonymous, google, email.",
      );
    }
  }

  const googleConfig = readProviderConfig(providerConfig.google);
  const legacyGoogle = authConfig.google ?? {};
  const googleEnabled = googleConfig.enabled || authConfig.mode === "google";
  const emailConfig = readProviderConfig(providerConfig.email);
  const anonymousConfig = readProviderConfig(providerConfig.anonymous);
  const anonymousEnabled = providerConfig.anonymous === undefined ? true : anonymousConfig.enabled;
  const mode = authConfig.mode ?? (googleEnabled ? "google" : "anonymous");

  return {
    mode,
    providers: {
      anonymous: {
        enabled: anonymousEnabled,
      },
      google: {
        enabled: googleEnabled,
        clientIdEnv: googleConfig.clientIdEnv ?? legacyGoogle.clientIdEnv ?? null,
        clientSecretEnv: googleConfig.clientSecretEnv ?? legacyGoogle.clientSecretEnv ?? null,
      },
      email: {
        enabled: emailConfig.enabled,
      },
    },
  };
}

function readProviderConfig(config) {
  if (config === true) {
    return { enabled: true };
  }
  if (config === false || config === undefined || config === null) {
    return { enabled: false };
  }
  return {
    enabled: config.enabled !== false,
    clientIdEnv: config.clientIdEnv ?? null,
    clientSecretEnv: config.clientSecretEnv ?? null,
  };
}

function authProvidersForClient(authConfig) {
  const providers = {};
  for (const [name, provider] of Object.entries(authConfig.providers)) {
    if (name === "google") {
      providers.google = {
        enabled: provider.enabled,
        configured: provider.configured,
      };
      continue;
    }
    providers[name] = {
      enabled: provider.enabled,
    };
  }
  return providers;
}

function resolveTableForQuery(schema, queryName) {
  return schema.tables.find((table) => table.name === queryName) ?? null;
}

function resolveTableForAddMutation(schema, mutationName) {
  if (!mutationName.startsWith("add") || mutationName.length <= 3) {
    return null;
  }
  const tableName = tableNameForSingular(mutationName.slice(3));
  return schema.tables.find((table) => table.name === tableName) ?? null;
}

function resolveTableForUpdateMutation(schema, mutationName) {
  const match = mutationName.match(/^update([A-Z][A-Za-z0-9]*?)([A-Z][A-Za-z0-9]*)$/);
  if (!match) {
    return null;
  }
  const table = schema.tables.find((candidate) => candidate.name === tableNameForSingular(match[1]));
  if (!table) {
    return null;
  }
  const fieldName = `${match[2][0].toLowerCase()}${match[2].slice(1)}`;
  const field = table.fields.find((candidate) => candidate.name === fieldName);
  return field ? { table, field } : null;
}

function tableNameForSingular(singular) {
  return `${singular[0].toLowerCase()}${singular.slice(1)}s`;
}

function rowToApiValue(row, table) {
  const value = { ...row };
  for (const field of table.fields) {
    if (field.kind === "Boolean") {
      value[field.name] = Boolean(value[field.name]);
    } else if (field.kind === "Json") {
      value[field.name] = JSON.parse(value[field.name]);
    }
    if (field.kind === "Number") {
      value[field.name] = value[field.name] === null ? null : Number(value[field.name]);
    }
  }
  return value;
}

function toSqlNumber(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw commandError(`Invalid number for field: ${fieldName}`, "Pass a finite JavaScript number for Number() fields.");
  }
  return value;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}
