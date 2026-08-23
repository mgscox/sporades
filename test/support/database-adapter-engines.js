import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLibsqlDatabaseAdapter, createPostgresDatabaseAdapter, createSqliteDatabaseAdapter } from "../../dist/server-runtime-source.js";
import { withFakeLibsqlService } from "./libsql-http-service.js";

// Per-engine setup for tests that drive a real Database adapter against real storage.
// ADR-0035 executes one conformance specification once per engine, so the setup each engine
// needs to hand a caller a live adapter lives here instead of being copied into every test.

const POSTGRES_TEST_URL_VARIABLE = "SPORADES_POSTGRES_TEST_URL";
const DEDICATED_POSTGRES_TEST_DATABASE = {
  host: "127.0.0.1",
  port: "55432",
  database: "sporades_w17",
};

const RUNTIME_TABLE_NAMES = [
  "sporades",
  "sporades_auth_access_key_locks",
  "sporades_auth_access_key_owners",
  "sporades_auth_access_keys",
  "sporades_auth_email_credentials",
  "sporades_auth_identities",
  "sporades_auth_oauth_states",
  "sporades_auth_password_reset_codes",
  "sporades_auth_sessions",
  "sporades_auth_users",
  "sporades_file_buckets",
  "sporades_file_public_urls",
  "sporades_file_uploads",
  "sporades_files",
  "sporades_jobs",
  "sporades_log_events",
  "sporades_schedule_legacy_adoption",
  "sporades_schedule_occurrences",
  "sporades_schedules",
  "sporades_team_bootstrap",
  "sporades_team_join_link_counters",
  "sporades_team_join_link_redemptions",
  "sporades_team_join_link_secrets",
  "sporades_team_join_link_throttles",
  "sporades_team_join_links",
  "sporades_team_membership_application_roles",
  "sporades_team_membership_counters",
  "sporades_team_memberships",
  "sporades_teams",
  "sporades_team_billing_customers",
  "sporades_team_billing_subscriptions",
  "sporades_team_billing_operations",
  "sporades_team_billing_observations",
  "sporades_team_billing_replay",
  "sporades_user_preferences",
];

export function postgresTestUrl() {
  return process.env[POSTGRES_TEST_URL_VARIABLE] ?? null;
}

export const POSTGRES_SKIP_REASON = process.env[POSTGRES_TEST_URL_VARIABLE]
  ? false
  : `Set ${POSTGRES_TEST_URL_VARIABLE} to run the Postgres adapter tests.`;

async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function withSqliteAdapter(fn, options = {}) {
  return await withTempDir("sporades-adapter-sqlite-", async (dir) => {
    const filePath = path.join(dir, options.fileName ?? "adapter.db");
    let adapter = await createSqliteDatabaseAdapter(filePath);
    try {
      return await fn(adapter, {
        async restart() {
          adapter.close();
          adapter = await createSqliteDatabaseAdapter(filePath);
          return adapter;
        },
      });
    } finally {
      adapter.close();
    }
  });
}

export async function withLibsqlAdapter(fn, options = {}) {
  return await withTempDir("sporades-adapter-libsql-", async (dir) => {
    return await withFakeLibsqlService(path.join(dir, options.fileName ?? "adapter.db"), {
      ...(options.service ?? {}),
      ...(options.isolateProcess ? { isolateProcess: true } : {}),
    }, async (service) => {
      let adapter = await createLibsqlDatabaseAdapter({ url: service.url });
      try {
        return await fn(adapter, {
          ...service,
          service,
          async restart() {
            await adapter.close();
            adapter = await createLibsqlDatabaseAdapter({ url: service.url });
            return adapter;
          },
        });
      } finally {
        await adapter.close();
      }
    });
  });
}

// Postgres is the one engine whose storage outlives the test process, so a run starts by
// dropping the runtime-owned tables plus any app tables the caller is about to migrate.
export async function withPostgresAdapter(fn, options = {}) {
  const url = postgresTestUrl();
  if (!url) {
    throw new Error(`${POSTGRES_TEST_URL_VARIABLE} is not set.`);
  }
  let adapter = await createPostgresDatabaseAdapter({ url });
  try {
    await resetPostgresSchema(adapter, options.appTableNames ?? []);
    return await fn(adapter, {
      async restart() {
        await adapter.close();
        adapter = await createPostgresDatabaseAdapter({ url });
        return adapter;
      },
    });
  } finally {
    await adapter.close();
  }
}

export async function resetPostgresSchema(adapter, appTableNames = []) {
  // This is intentionally more restrictive than a normal test URL check. Unlike the ephemeral
  // engines, Postgres survives the test process and this helper drops tables. Keep the destructive
  // capability permanently pinned to the one local, dedicated database that exists for this suite.
  const url = postgresTestUrl();
  const parsed = url ? new URL(url) : null;
  if (
    !parsed ||
    parsed.hostname !== DEDICATED_POSTGRES_TEST_DATABASE.host ||
    parsed.port !== DEDICATED_POSTGRES_TEST_DATABASE.port ||
    parsed.pathname !== `/${DEDICATED_POSTGRES_TEST_DATABASE.database}`
  ) {
    throw new Error(
      `${POSTGRES_TEST_URL_VARIABLE} must target postgres://${DEDICATED_POSTGRES_TEST_DATABASE.host}:${DEDICATED_POSTGRES_TEST_DATABASE.port}/${DEDICATED_POSTGRES_TEST_DATABASE.database} before resetting a test schema.`,
    );
  }
  const names = [...appTableNames, ...RUNTIME_TABLE_NAMES].map((name) => `"${name}"`).join(", ");
  await adapter.exec(`DROP TABLE IF EXISTS ${names} CASCADE`);
}

// The engines the conformance specification runs against. Gating decides only whether the
// Postgres run happens; every engine that runs, runs the same specification. Conformance surfaces
// reach this list only through `runDatabaseAdapterConformance`, which is the one place it is
// iterated, so no surface can run against a subset of it.
export const DATABASE_ADAPTER_ENGINES = [
  { name: "SQLite", skip: false, withAdapter: withSqliteAdapter },
  { name: "libSQL", skip: false, withAdapter: withLibsqlAdapter },
  { name: "Postgres", skip: POSTGRES_SKIP_REASON, withAdapter: withPostgresAdapter },
];
