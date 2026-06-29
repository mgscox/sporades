import { createHash, randomBytes, randomUUID } from "node:crypto";

export const SERVER_RUNTIME_SOURCE_FUNCTIONS = [
  readJsonRequest,
  openDevDatabase,
  extractSchema,
  extractFields,
  parseFieldDefault,
  toSqlLiteral,
  authStatus,
  createAnonymousAuthTables,
  resolveAnonymousSession,
  sessionFromRow,
  createWebSocketAccept,
  createWebSocketHub,
  drainWebSocketFrames,
  sendJson,
  linkGoogleAccount,
  runQuery,
  runMutation,
  formatMutationResult,
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
  const sqlite = new DatabaseSync(databasePath);
  const schema = extractSchema(serverSource);
  const rowCache = new Map();
  const database = {
    sqlite,
    schema,
    rowCache,
    serverEnv,
    authConfig: authStatus(config, serverEnv),
    close: () => sqlite.close(),
  };
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("CREATE TABLE IF NOT EXISTS sporades (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO sporades (key, value) VALUES (?, ?)").run("schemaVersion", "v0");
  createAnonymousAuthTables(sqlite);

  for (const table of schema.tables) {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (` +
        [
          "id TEXT PRIMARY KEY",
          "createdAt TEXT NOT NULL",
          "updatedAt TEXT NOT NULL",
          ...table.fields.map((field) => {
            const defaultSql = field.defaultValue === undefined ? "" : ` DEFAULT ${toSqlLiteral(field.defaultValue)}`;
            return `${quoteIdentifier(field.name)} ${field.sqliteType} NOT NULL${defaultSql}`;
          }),
        ].join(", ") +
        ")",
    );
  }

  return database;
}

function extractSchema(serverSource) {
  return {
    tables: [...serverSource.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*table\s*\(\s*\{([\s\S]*?)\}\s*\)/g)].map(
      (match) => ({
        name: match[1],
        fields: extractFields(match[2]),
      }),
    ),
  };
}

function extractFields(tableSource) {
  return [...tableSource.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(String|Boolean)\(\)(?:\.default\(([^)]*)\))?/g)].map(
    (match) => {
      const kind = match[2];
      return {
        name: match[1],
        kind,
        sqliteType: kind === "Boolean" ? "INTEGER" : "TEXT",
        defaultValue: parseFieldDefault(kind, match[3]),
      };
    },
  );
}

function parseFieldDefault(kind, rawDefault) {
  if (rawDefault === undefined) {
    return undefined;
  }
  if (kind === "Boolean") {
    return rawDefault.trim() === "true";
  }
  return rawDefault.trim().replace(/^["']|["']$/g, "");
}

function toSqlLiteral(value) {
  if (typeof value === "boolean") {
    return value ? "1" : "0";
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

export function createWebSocketHub(getDatabase) {
  const clients = new Set();

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

      const sessionToken = new URL(request.url, "http://127.0.0.1").searchParams.get("sessionToken");
      const database = getDatabase();
      const session = resolveAnonymousSession(database, sessionToken);
      const client = { socket, buffer: Buffer.alloc(0), subscriptions: new Map(), session };
      clients.add(client);
      socket.on("data", (chunk) => {
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
  };

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

    if (message.type === "auth.signInWithGoogle") {
      const google = database.authConfig.google;
      if (!google.configured) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          error: {
            message: "Google OAuth is not configured.",
            hint: "Run `sporades auth set google --client-id <id> --client-secret <secret>`.",
          },
        });
        return;
      }
      const clientId = database.serverEnv[google.clientIdEnv];
      sendJson(client, {
        id: message.id ?? null,
        type: "auth.redirect",
        data: {
          url:
            "https://accounts.google.com/o/oauth2/v2/auth?" +
            new URLSearchParams({
              client_id: clientId,
              response_type: "code",
              scope: "openid email profile",
              state: client.session.token,
            }).toString(),
        },
        error: null,
      });
      return;
    }

    if (message.type === "auth.completeGoogleSignIn") {
      const result = linkGoogleAccount(database, client.session, message.profile ?? {});
      if (!result.ok) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          error: result.error,
        });
        return;
      }
      client.session.auth = result.auth;
      sendAuthResult(client, message.id ?? null);
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

    sendJson(client, {
      id: message.id ?? null,
      type: "error",
      error: {
        message: `Unsupported WebSocket message: ${message.type ?? ""}`.trim(),
        hint: "Use auth.get, auth.signInWithGoogle, query.subscribe, or mutation.run.",
      },
    });
  }

  function sendQueryResult(client, subscription) {
    const database = getDatabase();
    const result = runQuery(database, client.session.auth, subscription.name);
    const data =
      result.data !== undefined
        ? result.data
        : subscription.style === "direct"
          ? result.rows
          : { rows: result.rows };
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
    sendJson(client, {
      id,
      type: "auth.result",
      data: {
        sessionToken: client.session.token,
        auth: client.session.auth,
        providers: {
          google: {
            configured: database.authConfig.google.configured,
          },
        },
      },
      error: null,
    });
  }
}

function linkGoogleAccount(database, session, profile) {
  if (!database.authConfig.google.configured) {
    return {
      ok: false,
      error: {
        message: "Google OAuth is not configured.",
        hint: "Run `sporades auth set google --client-id <id> --client-secret <secret>`.",
      },
    };
  }
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

function createAnonymousAuthTables(sqlite) {
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
  if (queryName === "ctx.env") {
    return { data: database.serverEnv, error: null };
  }

  if (queryName !== "todos") {
    return {
      rows: null,
      error: {
        message: `Unknown query: ${queryName}`,
        hint: "Use a query defined by the capsule.",
      },
    };
  }

  const cacheKey = `todos:${auth.userId}`;
  if (!database.rowCache.has(cacheKey)) {
    const rows = database.sqlite
      .prepare("SELECT id, createdAt, updatedAt, text, done, ownerId FROM todos WHERE ownerId = ? ORDER BY createdAt DESC")
      .all(auth.userId)
      .map((row) => ({ ...row, done: Boolean(row.done) }));
    database.rowCache.set(cacheKey, rows);
  }

  return { rows: database.rowCache.get(cacheKey), error: null };
}

function runMutation(database, auth, mutationName, args) {
  if (mutationName !== "addTodo") {
    return {
      ok: false,
      error: {
        message: `Unknown mutation: ${mutationName}`,
        hint: "Use a mutation defined by the capsule.",
      },
    };
  }

  const now = new Date().toISOString();
  database.sqlite
    .prepare("INSERT INTO todos (id, createdAt, updatedAt, text, done, ownerId) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), now, now, String(args[0] ?? ""), 0, auth.userId);
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
  const google = authConfig.google ?? {};
  const clientIdEnv = google.clientIdEnv ?? null;
  const clientSecretEnv = google.clientSecretEnv ?? null;
  return {
    mode: authConfig.mode ?? "anonymous",
    google: {
      configured: Boolean(clientIdEnv && clientSecretEnv && serverEnv[clientIdEnv] && serverEnv[clientSecretEnv]),
      clientIdEnv,
      clientSecretEnv,
    },
  };
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}
