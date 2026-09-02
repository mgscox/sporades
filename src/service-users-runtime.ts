import {
  accessKeyListPage,
  accessKeyNotFoundError,
  accessKeySummary,
  accessKeyVerifierDigest,
  createAccessKeySecret,
  markAccessKeySecretDisclosed,
  normalizeAccessKeyIssue,
  normalizeAccessKeyListOptions,
  throwAccessKeyIssueError,
} from "./access-keys-runtime.js";
import { commandError } from "./runtime-errors.js";

type LooseRecord = Record<string, any>;

const SERVICE_USER_DISPLAY_NAME_BYTES = 160;

function serviceUserError(code: string, message: string, hint: string) {
  return commandError(message, hint, code);
}

function normalizeDisplayName(value: unknown) {
  if (typeof value !== "string") {
    throw serviceUserError("INVALID_SERVICE_USER", "Invalid service User.", "Provide a displayName and initial accessKey.");
  }
  const displayName = value.trim();
  if (!displayName || Buffer.byteLength(displayName, "utf8") > SERVICE_USER_DISPLAY_NAME_BYTES || /[\u0000-\u001f\u007f]/.test(displayName)) {
    throw serviceUserError("INVALID_SERVICE_USER", "Invalid service User.", "Use a bounded printable displayName.");
  }
  return displayName;
}

function serviceUserSummary(row: LooseRecord) {
  return {
    id: row.id,
    displayName: row.displayName,
    status: row.lifecycleStatus,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt ?? null,
  };
}

async function requireCurrentHumanSession(database: LooseRecord, context: LooseRecord, sessionToken: string | null) {
  if (context?.credential?.kind !== "session" || typeof sessionToken !== "string" || !sessionToken) {
    throw serviceUserError("FORBIDDEN", "Service-User management requires a human Session.", "Sign in with a linked human account.");
  }
  const adapter = database.adapter;
  const sql = adapter.dialect.sql;
  await adapter.prepare(sql(
    "UPDATE [sporades_auth_sessions] SET [token] = [token] WHERE [token] = ? AND [userId] = ?",
  )).run(sessionToken, context.auth?.userId);
  const row = await adapter.prepare(sql(
    "SELECT [s].[token] FROM [sporades_auth_sessions] [s] " +
    "JOIN [sporades_auth_users] [u] ON [u].[id] = [s].[userId] " +
    "WHERE [s].[token] = ? AND [s].[userId] = ? AND [s].[expiresAt] > ? " +
    "AND [u].[userKind] = 'human' AND [u].[lifecycleStatus] = 'active' " +
    "AND [u].[isAuthenticated] = 1 AND [u].[isGuest] = 0",
  )).get(sessionToken, context.auth?.userId, database.clock.now().toISOString());
  if (!row) {
    throw serviceUserError("FORBIDDEN", "Service-User management requires a current human Session.", "Sign in again and retry.");
  }
}

async function lockServiceUser(database: LooseRecord, userId: unknown, requireActive = true) {
  if (typeof userId !== "string" || !userId || Buffer.byteLength(userId, "utf8") > 256) {
    throw serviceUserError("SERVICE_USER_NOT_FOUND", "Service User not found.", "Refresh the service-User list.");
  }
  const adapter = database.adapter;
  const sql = adapter.dialect.sql;
  const locked = await adapter.prepare(sql(
    "UPDATE [sporades_auth_service_user_locks] SET [operationRevision] = [operationRevision] + 1 WHERE [userId] = ?",
  )).run(userId);
  if (Number(locked?.changes ?? 0) !== 1) {
    throw serviceUserError("SERVICE_USER_NOT_FOUND", "Service User not found.", "Refresh the service-User list.");
  }
  const row = await adapter.prepare(sql(
    "SELECT [id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider], " +
    "[userKind], [lifecycleStatus], [disabledAt] FROM [sporades_auth_users] WHERE [id] = ?",
  )).get(userId);
  if (!row || row.userKind !== "service" || (requireActive && row.lifecycleStatus !== "active")) {
    throw serviceUserError(
      requireActive ? "SERVICE_USER_NOT_ACTIVE" : "SERVICE_USER_NOT_FOUND",
      requireActive ? "Service User is not active." : "Service User not found.",
      requireActive ? "Use an active service User." : "Refresh the service-User list.",
    );
  }
  return row;
}

async function issueForOwner(database: LooseRecord, context: LooseRecord, ownerUserId: string, input: unknown) {
  const normalized = normalizeAccessKeyIssue(input, database.accessKeyScopes ?? [], database.clock.now());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const secret = createAccessKeySecret();
    let issuedAt = normalized.createdAt;
    const record = {
      id: crypto.randomUUID(),
      ownerUserId,
      name: normalized.name,
      reservedName: normalized.name,
      grantsJson: JSON.stringify(normalized.grants),
      secretVersion: 1,
      selector: secret.selector,
      verifierDigest: accessKeyVerifierDigest(secret.selector, secret.verifier),
      lifecycleRevision: 1,
      createdAt: normalized.createdAt,
      expiresAt: normalized.expiresAt,
      issuanceTime: () => {
        issuedAt = database.clock.now().toISOString();
        return issuedAt;
      },
    };
    const outcome = await database.adapter.issueAccessKeyRecord(record);
    if (outcome.status === "selector-conflict") continue;
    if (outcome.status !== "issued") throwAccessKeyIssueError(outcome.status);
    record.createdAt = issuedAt;
    markAccessKeySecretDisclosed(context);
    return {
      accessKey: accessKeySummary(record, database.accessKeyScopes ?? [], issuedAt),
      token: secret.token,
    };
  }
  throw serviceUserError("ACCESS_KEY_SECRET_CONFLICT", "Could not generate a unique Access key.", "Retry Access-key issuance.");
}

export function createServiceUsersApi(
  database: LooseRecord,
  contextGetter: () => LooseRecord,
  sessionToken: string | null,
  options: { mutationSurface?: boolean; assertMutationInvocation?: () => void; trackMutationWork?: (promise: Promise<any>, requiresConsumption?: boolean) => Promise<any> } = {},
) {
  const inContext = (operation: (context: LooseRecord) => Promise<any>) => {
    // A transaction is a storage mechanism, not authority. Endpoints, Queries,
    // Messages, Jobs, and lifecycle handlers can all execute transactionally;
    // only the runtime's Mutation dispatcher may mint this surface.
    if (options.mutationSurface !== true) {
      throw serviceUserError(
        "SERVICE_USER_MUTATION_REQUIRED",
        "Service-User lifecycle changes require a Mutation.",
        "Call ctx.serviceUsers from a Mutation so User, key, and Capsule records commit atomically.",
      );
    }
    options.assertMutationInvocation?.();
    const context = contextGetter();
    return (async () => {
      await requireCurrentHumanSession(database, context, sessionToken);
      return operation(context);
    })();
  };
  const tracked = (promise: Promise<any>, requiresConsumption = false) =>
    options.trackMutationWork ? options.trackMutationWork(promise, requiresConsumption) : promise;
  return {
    create(input: unknown) {
      return tracked(inContext(async (context) => {
        if (!input || typeof input !== "object" || Array.isArray(input)
          || Object.keys(input).some((key) => !["displayName", "accessKey"].includes(key))) {
          throw serviceUserError("INVALID_SERVICE_USER", "Invalid service User.", "Provide a displayName and initial accessKey.");
        }
        const displayName = normalizeDisplayName((input as LooseRecord).displayName);
        const id = crypto.randomUUID();
        const createdAt = database.clock.now().toISOString();
        const sql = database.adapter.dialect.sql;
        await database.adapter.prepare(sql(
          "INSERT INTO [sporades_auth_users] " +
          "([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider], [userKind], [lifecycleStatus], [disabledAt]) " +
          "VALUES (?, ?, ?, NULL, NULL, 1, 0, 'service', 'service', 'active', NULL)",
        )).run(id, createdAt, displayName);
        await database.adapter.prepare(sql(
          "INSERT INTO [sporades_auth_service_user_locks] ([userId], [operationRevision]) VALUES (?, 0)",
        )).run(id);
        const issued = await issueForOwner(database, context, id, (input as LooseRecord).accessKey);
        return { serviceUser: serviceUserSummary({ id, displayName, lifecycleStatus: "active", createdAt, disabledAt: null }), ...issued };
      }), true);
    },

    issueAccessKey(userId: unknown, input: unknown) {
      return tracked(inContext(async (context) => {
        const serviceUser = await lockServiceUser(database, userId, true);
        return { serviceUser: serviceUserSummary(serviceUser), ...await issueForOwner(database, context, serviceUser.id, input) };
      }), true);
    },

    listAccessKeys(userId: unknown, options: unknown = {}) {
      return tracked(inContext(async () => {
        const serviceUser = await lockServiceUser(database, userId, false);
        const normalized = normalizeAccessKeyListOptions(options);
        const rows = await database.adapter.listAccessKeyRecordsForOwner(serviceUser.id);
        return { serviceUser: serviceUserSummary(serviceUser), ...accessKeyListPage(rows, database.accessKeyScopes ?? [], database.clock.now(), normalized) };
      }));
    },

    rotateAccessKey(userId: unknown, id: unknown, options: unknown) {
      return tracked(inContext(async (context) => {
        const serviceUser = await lockServiceUser(database, userId, true);
        if (typeof id !== "string" || !id) throw accessKeyNotFoundError();
        if (!options || typeof options !== "object" || Array.isArray(options)
          || Object.keys(options).some((key) => key !== "lifecycleRevision")
          || !Number.isInteger((options as LooseRecord).lifecycleRevision)
          || (options as LooseRecord).lifecycleRevision < 1) {
          throw serviceUserError("ACCESS_KEY_REVISION_CONFLICT", "Invalid Access-key lifecycle revision.", "Pass the lifecycleRevision returned by listAccessKeys().");
        }
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const secret = createAccessKeySecret();
          const outcome = await database.adapter.rotateAccessKeyRecord({
            ownerUserId: serviceUser.id,
            id,
            lifecycleRevision: (options as LooseRecord).lifecycleRevision,
            secretVersion: 1,
            selector: secret.selector,
            verifierDigest: accessKeyVerifierDigest(secret.selector, secret.verifier),
            rotationTime: () => database.clock.now().toISOString(),
          });
          if (outcome.status === "selector-conflict") continue;
          if (outcome.status === "not-found") throw accessKeyNotFoundError();
          if (outcome.status === "not-active") throw serviceUserError("ACCESS_KEY_NOT_ACTIVE", "Access key is not active.", "Issue a new Access key.");
          if (outcome.status === "revision-conflict") throw serviceUserError("ACCESS_KEY_REVISION_CONFLICT", "Access-key revision changed.", "Refresh the key list and retry rotation.");
          markAccessKeySecretDisclosed(context);
          return {
            serviceUser: serviceUserSummary(serviceUser),
            accessKey: accessKeySummary(outcome.record, database.accessKeyScopes ?? [], outcome.rotatedAt),
            token: secret.token,
          };
        }
        throw serviceUserError("ACCESS_KEY_SECRET_CONFLICT", "Could not generate a unique Access key.", "Retry Access-key rotation.");
      }), true);
    },

    revokeAccessKey(userId: unknown, id: unknown) {
      return tracked(inContext(async () => {
        const serviceUser = await lockServiceUser(database, userId, false);
        if (typeof id !== "string" || !id) throw accessKeyNotFoundError();
        const outcome = await database.adapter.revokeAccessKeyRecord({
          ownerUserId: serviceUser.id,
          id,
          revocationTime: () => database.clock.now().toISOString(),
          revocationCause: "service-user-administrator",
        });
        if (!outcome) throw accessKeyNotFoundError();
        return {
          serviceUser: serviceUserSummary(serviceUser),
          accessKey: accessKeySummary(outcome, database.accessKeyScopes ?? [], outcome.revokedAt ?? database.clock.now().toISOString()),
        };
      }));
    },

    disable(userId: unknown) {
      return tracked(inContext(async () => {
        const serviceUser = await lockServiceUser(database, userId, true);
        const revoked = await database.adapter.bulkRevokeAccessKeysForOwner({
          ownerUserId: serviceUser.id,
          revocationTime: () => database.clock.now().toISOString(),
          revocationCause: "service-user-disabled",
        });
        const disabledAt = database.clock.now().toISOString();
        const sql = database.adapter.dialect.sql;
        const result = await database.adapter.prepare(sql(
          "UPDATE [sporades_auth_users] SET [lifecycleStatus] = 'disabled', [disabledAt] = ?, " +
          "[isAuthenticated] = 0 WHERE [id] = ? AND [userKind] = 'service' AND [lifecycleStatus] = 'active'",
        )).run(disabledAt, serviceUser.id);
        if (Number(result?.changes ?? 0) !== 1) {
          throw serviceUserError("SERVICE_USER_NOT_ACTIVE", "Service User is not active.", "Refresh the service-User list.");
        }
        const accessKeyRows = await database.adapter.listAccessKeyRecordsForOwner(serviceUser.id);
        return {
          serviceUser: serviceUserSummary({ ...serviceUser, lifecycleStatus: "disabled", disabledAt }),
          revokedCount: revoked.revokedCount,
          accessKeys: accessKeyRows.map((row: LooseRecord) => accessKeySummary(
            row,
            database.accessKeyScopes ?? [],
            disabledAt,
          )),
        };
      }));
    },
  };
}
