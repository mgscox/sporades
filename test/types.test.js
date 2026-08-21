import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-types-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("sporades api bindings compile representative strict TypeScript app code", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await symlink(repoRoot, path.join(dir, "node_modules", "sporades"), "dir");
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ type: "module", dependencies: { sporades: "file:." } }, null, 2),
    );
    await writeFile(
      path.join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2022", "DOM"],
          },
          include: ["app.ts"],
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(dir, "app.ts"),
      `import { Boolean, Date, Json, Number, Reference, String, capsule, emailEvent, endpoint, job, message, mutation, query, requireAuth, requireUserAuth, schedule, stripeEvent, table, type TableApi, type TableDefinition } from "sporades/server";
import * as publicServerApi from "sporades/server";
import { createStripePaymentIntegration, type StripeCheckoutSessionResult, type StripeCustomerPortalSessionResult, type StripePaymentsDisabledResult, type VerifiedStripeEvent } from "sporades/server/stripe";
import { accessKeys, auth, createHooks, createInfernoAdapters, createLitControllers, createSolidPrimitives, createSvelteStores, createVueComposables, files, isAuthenticated, journey, mutations, onMessage, preferences, queries, sendMessage, teams, type AccessKeyErrorCode, type JourneyRecord } from "sporades/client";

const dormantStripe = createStripePaymentIntegration({ enabled: false });
// @ts-expect-error Lease recovery is an internal runtime/test seam, not Capsule API.
publicServerApi.recoverExpiredJobLeases;
const disabledCheckout: Promise<StripePaymentsDisabledResult> = dormantStripe.createCheckoutSession({});
void disabledCheckout;
// @ts-expect-error Enabled integration requires normalized configuration and named Server env.
createStripePaymentIntegration({ enabled: true });
const enabledStripe = createStripePaymentIntegration({ enabled: true, config: { enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET", publicOrigin: "https://payments.example.test", callbackPath: "/stripe/webhook", apiVersion: "2026-07-29.dahlia", livemode: false, requestTimeoutMs: 10000 }, env: { STRIPE_SECRET_KEY: "fixture", STRIPE_WEBHOOK_SECRET: "fixture" } });
const checkout: Promise<StripeCheckoutSessionResult> = enabledStripe.createCheckoutSession({ mode: "payment", priceId: "price_server_owned", quantity: 1, successPath: "/success", cancelPath: "/cancel", idempotencyKey: "capsule:checkout:user:intent", businessReference: "intent-123" });
const subscriptionCheckout: Promise<StripeCheckoutSessionResult> = enabledStripe.createCheckoutSession({ mode: "subscription", priceId: "price_recurring_server_owned", quantity: 1, successPath: "/success", cancelPath: "/cancel", idempotencyKey: "capsule:checkout:user:subscription", businessReference: "subscription-123" });
const customerPortal: Promise<StripeCustomerPortalSessionResult> = enabledStripe.createCustomerPortalSession({ customerId: "cus_server_owned", returnPath: "/account/billing", idempotencyKey: "capsule:portal:user:intent" });
const verifiedEvent: Promise<VerifiedStripeEvent> = enabledStripe.verifyWebhookEvent({ bodyBytes: new Uint8Array(), signature: "t=1,v1=fixture" });
void checkout;
void subscriptionCheckout;
void customerPortal;
void verifiedEvent;
// @ts-expect-error Checkout mode must be explicit; recurring Prices cannot silently use the one-time default.
enabledStripe.createCheckoutSession({ priceId: "price_server_owned", quantity: 1, successPath: "/success", cancelPath: "/cancel", idempotencyKey: "capsule:checkout:user:intent", businessReference: "intent-123" });
// @ts-expect-error Only Stripe Checkout payment and subscription modes are admitted.
enabledStripe.createCheckoutSession({ mode: "setup", priceId: "price_server_owned", quantity: 1, successPath: "/success", cancelPath: "/cancel", idempotencyKey: "capsule:checkout:user:intent", businessReference: "intent-123" });
// @ts-expect-error Portal callers may not select Stripe configuration or flow authority.
enabledStripe.createCustomerPortalSession({ customerId: "cus_server_owned", returnPath: "/account/billing", idempotencyKey: "capsule:portal:user:intent", configuration: "bpc_browser_owned" });
// @ts-expect-error Webhook callers cannot control the verification clock or tolerance.
enabledStripe.verifyWebhookEvent({ bodyBytes: new Uint8Array(), signature: "t=1,v1=fixture", tolerance: 0 });
// @ts-expect-error The narrow payment boundary does not expose Stripe's generic request surface.
dormantStripe.request("GET", "/v1/customers");
// @ts-expect-error The narrow payment boundary does not expose the underlying Stripe client.
dormantStripe.client;

const uniqueUsers = table({ email: String(), teamId: String() }).unique("email").unique("teamId", "email");
uniqueUsers.fields.email.kind.toUpperCase();
// @ts-expect-error Unique declarations may name only declared table fields.
table({ email: String() }).unique("missing");
// @ts-expect-error A unique declaration needs at least one field.
table({ email: String() }).unique();
const annotatedUniqueUsers: TableDefinition<{ email: ReturnType<typeof String> }> = table({ email: String() });
annotatedUniqueUsers.unique("email");
// @ts-expect-error An exported TableDefinition keeps the non-empty unique declaration contract.
annotatedUniqueUsers.unique();
// @ts-expect-error An exported TableDefinition keeps keys scoped to its declared fields.
annotatedUniqueUsers.unique("missing");

declare const typedUsers: TableApi<{ id: string; createdAt: string; updatedAt: string; email: string; teamId: string }>;
typedUsers.insertOrIgnore({ email: "person@example.test", teamId: "team-a" }, "email");
const serviceInsertOrIgnoreResult: ReturnType<typeof typedUsers.insertOrIgnore> = Promise.resolve({
  id: "user-1",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  email: "person@example.test",
  teamId: "team-a",
});
async function awaitInsertOrIgnore() {
  const inserted = await typedUsers.insertOrIgnore({ email: "person@example.test", teamId: "team-a" }, "email");
  return inserted?.email ?? null;
}
void serviceInsertOrIgnoreResult;
void awaitInsertOrIgnore;
// v0.8.5 dynamic Schedule payloads retain their legacy source-text identity.
schedule({ expression: "* * * * *", job: "summarise", payload: () => ({ text: "dynamic" }) });
// @ts-expect-error Static Schedule payloads are fingerprinted directly and cannot declare payloadVersion.
schedule({ expression: "* * * * *", job: "summarise", payload: { text: "static" }, payloadVersion: "unused" });
// @ts-expect-error An idempotent insert names at least one conflict field.
typedUsers.insertOrIgnore({ email: "person@example.test" });
// @ts-expect-error Conflict fields are limited to the table row shape.
typedUsers.insertOrIgnore({ email: "person@example.test" }, "missing");
// @ts-expect-error Managed IDs cannot be declared unique or named as insert conflict fields.
typedUsers.insertOrIgnore({ email: "person@example.test" }, "id");
// @ts-expect-error Managed creation timestamps are not insert conflict fields.
typedUsers.insertOrIgnore({ email: "person@example.test" }, "createdAt");
// @ts-expect-error Managed update timestamps are not insert conflict fields.
typedUsers.insertOrIgnore({ email: "person@example.test" }, "updatedAt");

const legacyStripeSubscription = stripeEvent(async (ctx, event) => {
  ctx.log.info("legacy Stripe event", event.providerEventId);
  await ctx.db.todos.all();
});
void legacyStripeSubscription;

const app = capsule({
  name: "typed island",
  accessKeys: { scopes: ["todos:read", "todos:write"] },
  teams: {
    appRoles: ["author", "reviewer"],
    admitJoin: async (ctx, input) => {
      const rowsPromise: Promise<unknown[]> = ctx.db.todos.where("ownerId", input.teamId).all();
      const rowPromise: Promise<unknown> = ctx.db.todos.where("ownerId", input.teamId).get();
      const rows = await rowsPromise;
      await rowPromise;
      // @ts-expect-error admission policy data access is transaction-bound and read-only.
      ctx.db.todos.insert({ title: "not allowed", ownerId: input.teamId });
      ctx.log.info("team admission", input.currentMemberCount, input.userId);
      // @ts-expect-error admission receives only transaction-bound data access, auth, env, and logging.
      ctx.teams.list();
      return { allow: rows.length === 0 };
    },
  },
  files: {
    accessKeys: { read: { scopes: ["todos:read"] } },
    acl: {
      read: ({ file, ctx }) => {
        file.path.toUpperCase();
        const permitted = ctx.acl.teams.isMember("00000000-0000-4000-8000-000000000000");
        // @ts-expect-error File ACL contexts expose constrained decisions, not mutable Team management.
        ctx.teams.list();
        return permitted;
      },
      publicUrl: ({ file, ctx }) => ctx.acl.teams.isAdmin(file.path.split("/")[2] ?? ""),
      delete: ({ file, ctx }) => ctx.acl.teams.hasRole(file.path.split("/")[2] ?? "", "author"),
    },
  },
  journey: { enabled: true, ttlSeconds: 30, capture: { navigation: true, focus: false } },
  emailEvents: emailEvent(async (ctx, event) => {
    ctx.log.info("email event", event.provider, event.kind, event.providerEventId, event.occurredAt);
    event.correlationId?.toUpperCase();
    event.recipient?.toUpperCase();
    JSON.stringify(event.raw);
    // @ts-expect-error Provider-specific payload fields stay under raw.
    event.Message_GUID;
  }),
  stripeEvents: stripeEvent({ consequence: "atomic" }, async (ctx, event) => {
    const verified: VerifiedStripeEvent = event;
    verified.provider satisfies "stripe";
    verified.providerEventId.toUpperCase();
    verified.type.toUpperCase();
    verified.occurredAt.toUpperCase();
    verified.livemode.valueOf();
    verified.objectId?.toUpperCase();
    JSON.stringify(verified.raw);
    ctx.auth.userId satisfies "__privileged__";
    ctx.signal.throwIfAborted();
    await ctx.db.todos.insert({ title: "atomic observation", ownerId: "system" });
    await ctx.jobs.enqueue("summarise", { text: verified.providerEventId });
    // @ts-expect-error Atomic Stripe event handlers receive no HTTP request.
    ctx.request.body;
    // @ts-expect-error Atomic Stripe consequences exclude Team authority.
    ctx.teams.list();
    // @ts-expect-error Provider payment operations cannot run inside the app transaction.
    ctx.payments.stripe.enabled;
    // @ts-expect-error SMTP delivery cannot run inside the app transaction.
    ctx.mail.send({ to: "recipient@example.com", subject: "denied", textBody: "denied" });
    // @ts-expect-error Atomic callbacks cannot nest Privileged runs.
    ctx.privileged.run({}, () => undefined);
    // @ts-expect-error Atomic callbacks may enqueue but cannot inspect the queue.
    ctx.jobs.list();
  }),
  jobs: {
    summarise: job(async (ctx, payload) => {
      // @ts-expect-error A Job may run as the Privileged server role, which has no ordinary Credential provenance.
      ctx.credential.kind;
      if ("credential" in ctx) ctx.credential.kind satisfies "session" | "access-key";
      const text = typeof payload === "object" && payload !== null && "text" in payload && typeof payload.text === "string" ? payload.text : "";
      await ctx.mail.send({ to: "recipient@example.com", subject: "Job report", textBody: text || "empty" });
      const queued = await ctx.jobs.enqueue("summarise", { text }, { idempotencyKey: text });
      const visible = await ctx.jobs.get(queued.id);
      return { id: visible?.id ?? queued.id };
    }),
  },
  schedules: {
    dynamicSummary: schedule({
      expression: "* * * * *",
      job: "summarise",
      missedRun: "latest",
      payloadVersion: "dynamic-summary-v1",
      payload: async (occurrence, ctx) => {
        occurrence.scheduleName.toUpperCase();
        occurrence.scheduledFor.toUpperCase();
        ctx.signal.throwIfAborted();
        // @ts-expect-error Schedule payload factories do not have direct mail authority.
        await ctx.mail.send({ to: "recipient@example.com", subject: "denied", textBody: "denied" });
        return ctx.privileged.run({ operation: "schedules.payload.read", targetResourceKind: "capsule-db" }, () => ({ text: occurrence.scheduledFor }));
      },
    }),
  },
  schema: {
    users: table({
      name: String(),
    }),
    fileLinks: table({
      fileRef: String(),
    }).acl({
      read: ({ row, ctx }) => ctx.acl.storage.exists("files", row?.fileRef ?? "missing"),
    }),
    todos: table({
      text: String(),
      done: Boolean().default(false),
      effort: Number().default(1),
      dueAt: Date(),
      meta: Json<{ tags: string[] }>().default({ tags: [] }),
      authorId: Reference("users").default(null),
      ownerId: String(),
    }).acl({
      read: async ({ row, ctx }) => {
        const file = ctx.acl.storage.get("files", "/avatars/profile.png");
        const hasFile = ctx.acl.storage.exists("files", file?.id ?? "/avatars/profile.png");
        const userExists = ctx.acl.db.exists("users", row?.authorId ?? "missing");
        const teamMember = ctx.acl.teams.isMember("00000000-0000-4000-8000-000000000000");
        const teamAdmin = ctx.acl.teams.isAdmin("00000000-0000-4000-8000-000000000000");
        const teamAuthor = ctx.acl.teams.hasRole("00000000-0000-4000-8000-000000000000", "author");
        const teamReviewer = ctx.acl.teams.hasAnyRole("00000000-0000-4000-8000-000000000000", ["author", "reviewer"]);
        // @ts-expect-error Team ACL helpers are decisions, not the mutable Team management API.
        ctx.acl.teams.create("not available in ACL");
        // @ts-expect-error Team ACL role sets must be arrays.
        ctx.acl.teams.hasAnyRole("00000000-0000-4000-8000-000000000000", "author");
        // @ts-expect-error ACL contexts do not expose the mutable current-user Teams API.
        ctx.teams.list();
        // @ts-expect-error ACL policy contexts cannot start privileged server-role work.
        ctx.privileged.run({ operation: "acl.bad", targetResourceKind: "capsule-db" }, () => true);
        // @ts-expect-error ACL policy contexts cannot send mail.
        ctx.mail.send({ to: "recipient@example.com", subject: "denied", textBody: "denied" });
        if (file) {
          file.bucket.toUpperCase();
          // @ts-expect-error ACL file metadata exposes logical bucket names, not internal bucket row IDs.
          file.bucketId;
        }
        // @ts-expect-error ACL helper reads are synchronous at the policy boundary, not Promise-returning.
        ctx.acl.storage.exists("files", "/avatars/profile.png").then(() => true);
        return row?.ownerId === ctx.auth.userId && userExists && hasFile === (file !== null) && file !== null && file.path.startsWith("/") && !teamMember && !teamAdmin && !teamAuthor && !teamReviewer;
      },
      write: async ({ next, previous, ctx }) => {
        await Promise.resolve();
        const ownerId = next?.ownerId ?? previous?.ownerId;
        return ownerId === ctx.auth.userId;
      },
    }),
  },
  middleware: [
    async (ctx) => {
      await Promise.resolve();
      await ctx.mail.send({ to: "recipient@example.com", subject: "Middleware", textBody: ctx.kind });
      return { ...ctx, requestKind: ctx.kind };
    },
  ],
  queries: {
    sessionGuarded: query(requireAuth({ credentials: ["session"], scopes: ["todos:read"] }, (ctx) => {
      ctx.credential.kind satisfies "session";
      // @ts-expect-error Session provenance has no Access-key attribution ID.
      ctx.credential.id;
      return ctx.auth.userId;
    })),
    accessKeyGuarded: query(requireAuth({ credentials: ["access-key"] }, (ctx) => {
      ctx.credential.kind satisfies "access-key";
      ctx.credential.id.toUpperCase();
      ctx.credential.name.toUpperCase();
      return ctx.auth.userId;
    })),
    anyCredentialGuarded: query(requireAuth((ctx) => {
      ctx.credential.kind satisfies "session" | "access-key";
      return ctx.auth.userId;
    })),
    todos: query(async (ctx) => {
      await ctx.mail.send({ to: "recipient@example.com", subject: "Query", textBody: "Query" });
      return ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .limit(50)
        .all();
    }),
    noOrdinaryScheduleInspection: query((ctx) => {
      // @ts-expect-error Schedule inspection is available only in an active Privileged callback.
      return ctx.schedules.list();
    }),
    asyncTodos: query(async (ctx) => {
      await Promise.resolve();
      return ctx.db.todos.where("ownerId", ctx.auth.userId).all();
    }),
    greetingFor: query((_ctx, name: string, options: { uppercase: boolean }) => {
      return options.uppercase ? name.toUpperCase() : name;
    }),
    ownTeams: query(async (ctx) => {
      const result = await ctx.teams.list();
      const created = await ctx.teams.create("Typed Team");
      const renamed = await ctx.teams.rename(created.team.id, "Renamed Typed Team");
      const members = await ctx.teams.listMembers(renamed.team.id);
      const memberPage = await ctx.teams.listMembers(renamed.team.id, { cursor: members.nextCursor, limit: 25 });
      memberPage.totalCount.valueOf();
      const memberCount = await ctx.teams.countMembers(renamed.team.id);
      memberCount.totalCount.valueOf();
      const roleUpdate = await ctx.teams.updateApplicationRoles(renamed.team.id, members.members[0]?.userId ?? "", { add: ["author"], remove: [] });
      const joinLink = await ctx.teams.validateJoinLink("opaque-join-code");
      const joined = await ctx.teams.join("opaque-join-code");
      const promoted = await ctx.teams.promote(renamed.team.id, members.members[0]?.userId ?? "");
      const demoted = await ctx.teams.demote(renamed.team.id, members.members[0]?.userId ?? "");
      const removed = await ctx.teams.removeMember(renamed.team.id, members.members[0]?.userId ?? "");
      const left = await ctx.teams.leave(renamed.team.id);
      const deleted = await ctx.teams.delete(renamed.team.id);
      return result.teams.map((team) => team.id).concat(renamed.team.id, members.members[0]?.userId ?? "", joinLink.valid ? "valid" : "invalid", joined.team.role, roleUpdate.updated ? "roles" : "", promoted.updated ? "promoted" : "", demoted.updated ? "demoted" : "", removed.removed ? "removed" : "", left.left ? "left" : "", deleted.deleted ? "deleted" : "");
    }),
    ownAccessKeys: query(async (ctx) => {
      const issued = await ctx.accessKeys.issue({
        name: "typed-key",
        grants: ["todos:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      issued.token.toUpperCase();
      issued.accessKey.effectiveScopes.map((scope) => scope.toUpperCase());
      const listed = await ctx.accessKeys.list({ status: "active", limit: 25 });
      listed.declaredScopes.map((scope) => scope.toUpperCase());
      listed.nextCursor?.toUpperCase();
      const revoked = await ctx.accessKeys.revoke(issued.accessKey.id);
      const rotated = await ctx.accessKeys.rotate(issued.accessKey.id, { lifecycleRevision: issued.accessKey.lifecycleRevision });
      rotated.token.toUpperCase();
      const deleted = await ctx.accessKeys.delete(revoked.accessKey.id);
      deleted.deleted satisfies true;
      revoked.accessKey.lifecycleRevision.valueOf();
      revoked.accessKey.revocationCause satisfies "owner" | "operator" | "password-reset" | "owner-unlinked" | "owner-deleted" | null;
      // @ts-expect-error Access-key grants are immutable after issuance.
      ctx.accessKeys.update(issued.accessKey.id, { grants: ["todos:write"] });
      // @ts-expect-error Access-key status filters are a closed vocabulary.
      await ctx.accessKeys.list({ status: "disabled" });
      return listed.totalCount;
    }),
    privilegedTodos: query(async (ctx) => {
      const rows = await ctx.privileged.run({
        operation: "todos.maintenance.read",
        targetResourceKind: "capsule-db",
        metadata: { reason: "type-test" },
        signal: new AbortController().signal,
      }, async (privilegedCtx) => {
        const privilegedMemberCount = await privilegedCtx.teams.countMembers("00000000-0000-4000-8000-000000000000");
        privilegedMemberCount.totalCount.valueOf();
        const privilegedMembers = await privilegedCtx.teams.listMembers("00000000-0000-4000-8000-000000000000", { limit: 25 });
        privilegedMembers.members[0]?.displayName.toUpperCase();
        const privilegedLinks = await privilegedCtx.teams.listJoinLinks("00000000-0000-4000-8000-000000000000");
        privilegedLinks.links[0]?.expiresAt.toUpperCase();
        // @ts-expect-error Privileged Join-link inspection never exposes the target email.
        privilegedLinks.links[0]?.email.toUpperCase();
        const privilegedLink = await privilegedCtx.teams.inspectJoinLink("opaque-join-code");
        privilegedLink.usable.valueOf();
        // @ts-expect-error Privileged work cannot infer a current user's Team list.
        privilegedCtx.teams.list();
        // @ts-expect-error Privileged work cannot validate an email-bound Join link.
        privilegedCtx.teams.validateJoinLink("opaque-join-code");
        // @ts-expect-error Privileged work cannot mutate Team state.
        privilegedCtx.teams.create("Forbidden Team");
        privilegedCtx.auth.userId satisfies "__privileged__";
        const allJobs = await privilegedCtx.jobs.list();
        await privilegedCtx.mail.send({
          to: "recipient@example.com",
          subject: "Privileged report",
          textBody: "Ready",
        });
        allJobs.nextCursor?.toUpperCase();
        const schedules = await privilegedCtx.schedules.list();
        schedules[0]?.name.toUpperCase();
        const oneSchedule = await privilegedCtx.schedules.get("dynamicSummary");
        oneSchedule?.latestOccurrence?.scheduledFor.toUpperCase();
        const fileUrl = await privilegedCtx.files.url("/reports/private.txt");
        if (fileUrl.ok) {
          fileUrl.data.url.toUpperCase();
          fileUrl.data.file.ownerId.toUpperCase();
        }
        const publicFileUrl = await privilegedCtx.files.createPublicUrl("/reports/private.txt", { ttlSeconds: 600 });
        if (publicFileUrl.ok) {
          publicFileUrl.data.publicUrl.fileId.toUpperCase();
        }
        return privilegedCtx.db.todos.all();
      });
      return rows.length;
    }),
  },
  mutations: {
    addTodo: mutation(async (ctx, text) => {
      await Promise.resolve();
      const me = requireAuth(ctx);
      me.userId.toUpperCase();
      requireUserAuth(ctx).userId.toUpperCase();
      const linkedUser = requireAuth(ctx, { linked: true });
      linkedUser.isGuest.valueOf();
      // @ts-expect-error requireAuth options accept a boolean linked flag only.
      requireAuth(ctx, { linked: "yes" });
      ctx.log.info("adding", text.trim());
      await ctx.mail.send({
        to: [{ email: "recipient@example.com", name: "Recipient" }],
        cc: "copy@example.com",
        subject: "Todo added",
        textBody: text,
        provider: { trace: "types" },
      });
      return ctx.db.todos.insert({
        text: text.trim(),
        ownerId: ctx.auth.userId,
        dueAt: new globalThis.Date(),
        meta: { tags: ["typed"] },
        authorId: null,
      });
    }),
  },
  endpoints: {
    ping: endpoint({ method: "GET", path: "/ping" }, async (ctx) => {
      await Promise.resolve();
      await ctx.mail.send({ to: "recipient@example.com", subject: "Ping", htmlBody: "<p>Ping</p>" });
      const bodyBytes = ctx.request.bodyBytes;
      const bodyCopy: Uint8Array = bodyBytes.toUint8Array();
      bodyBytes.byteLength satisfies number;
      bodyBytes.length satisfies number;
      bodyBytes.at(0)?.toFixed();
      for (const byte of bodyBytes) byte.toFixed();
      bodyCopy.fill(0);
      // @ts-expect-error endpoint body bytes expose no mutable indexed storage.
      bodyBytes[0] = 0;
      // @ts-expect-error endpoint body bytes expose no mutating typed-array methods.
      bodyBytes.set([0]);
      return {
        path: ctx.request.path,
        userId: requireAuth(ctx).userId,
        count: ctx.db.todos.all().length,
      };
    }),
    guarded: endpoint({ method: "GET", path: "/guarded" }, requireAuth({ credentials: ["session"] }, (ctx) => ({
      status: 200,
      body: ctx.request.method + ":" + ctx.credential.kind,
    }))),
  },
  messages: {
    typing: message(async (ctx, data) => {
      await ctx.mail.send({ to: "recipient@example.com", subject: "Message", textBody: "Typing" });
      await ctx.privileged.run({
        operation: "messages.auditTyping",
        targetResourceKind: "capsule-db",
      }, (privilegedCtx) => privilegedCtx.db.todos.all().length);
      const sentToClients: number = ctx.messages.send({ type: "typing", data, scope: "currentUser" });
      return { ok: true, sentToClients };
    }),
  },
  hooks: {
    beforeMutation: [
      async ({ ctx, name, args }) => {
        await Promise.resolve();
        await ctx.mail.send({ to: "recipient@example.com", subject: "Before hook", textBody: name });
        await ctx.privileged.run({ operation: "hooks.beforeMutation", targetResourceKind: "capsule-db" }, () => undefined);
        ctx.log.info("before", name, args.length);
      },
    ],
    afterMutation: [
      async ({ ctx, result }) => {
        await Promise.resolve();
        await ctx.mail.send({ to: "recipient@example.com", subject: "After hook", textBody: globalThis.String(result?.ok) });
        ctx.log.info("after", result?.ok);
      },
    ],
    init: async (ctx) => {
      await ctx.mail.send({ to: "recipient@example.com", subject: "Init", textBody: "Init" });
    },
    shutdown: async (ctx) => {
      await ctx.mail.send({ to: "recipient@example.com", subject: "Shutdown", textBody: "Shutdown" });
    },
  },
});

const guarded = requireAuth((ctx) => ctx.credential.kind);
// @ts-expect-error Auth guard branding is type-only and not a public runtime property.
guarded.__sporadesAuthGuardedHandler;
// @ts-expect-error Unguarded handlers cannot use an incompatible query context.
query((ctx: { nope: number }) => ctx.nope);
// @ts-expect-error Unguarded handlers cannot use an incompatible Custom-endpoint context.
endpoint({ method: "GET", path: "/invalid-context" }, (ctx: { nope: number }) => ctx.nope);

const hooks = createHooks({
  useState<State>(initial: State | (() => State)): [State, (nextState: State) => void] {
    return [initial as State, () => {}];
  },
  useEffect() {},
});

const todos = hooks.useQuery<Array<{ id: string; text: string }>>("todos");
todos.data?.map((todo) => todo.text.toUpperCase());
hooks.useMutation("addTodo").run("Ship the types");
hooks.useAuth().signIn("google");
const vue = createVueComposables({
  reactive<State extends object>(state: State): State { return state; },
  onScopeDispose(cleanup) { void cleanup; },
});
vue.useQuery<Array<{ id: string; text: string }>>("todos").data?.map((todo) => todo.text.toUpperCase());
const vueMutation = vue.useMutation<{ id: string }>("addTodo");
vueMutation.run("Ship Vue types");
vueMutation.data?.id.toUpperCase();
vue.useAuth().signOut();
const solid = createSolidPrimitives({
  createSignal<State>(initial: State): [() => State, (next: State | ((current: State) => State)) => State] {
    let value = initial;
    return [() => value, (next) => value = typeof next === "function" ? (next as (current: State) => State)(value) : next];
  },
  onCleanup(cleanup) { void cleanup; },
});
solid.createQuery<Array<{ id: string }>>("todos")().data?.map((todo) => todo.id);
const solidMutation = solid.createMutation<{ id: string }>("addTodo");
solidMutation.run("Ship Solid types");
solidMutation.state().data?.id.toUpperCase();
solid.createAuth().state().auth?.userId.toUpperCase();
const litHost = { addController() {}, requestUpdate() {} };
const lit = createLitControllers();
lit.queryController<Array<{ id: string }>>(litHost, "todos").state.data?.map((todo) => todo.id);
lit.mutationController<{ id: string }>(litHost, "addTodo").run("Ship Lit types");
lit.authController(litHost).state.auth?.userId.toUpperCase();
const infernoHost = { forceUpdate() {} };
const inferno = createInfernoAdapters();
const infernoQuery = inferno.queryAdapter<Array<{ id: string }>>(infernoHost, "todos");
infernoQuery.componentDidMount(); infernoQuery.state.data?.map((todo) => todo.id); infernoQuery.componentWillUnmount();
inferno.mutationAdapter<{ id: string }>(infernoHost, "addTodo").run("Ship Inferno types");
inferno.authAdapter(infernoHost).state.auth?.userId.toUpperCase();
const svelte = createSvelteStores();
const stopSvelteQuery = svelte.queryStore<Array<{ id: string }>>("todos").subscribe((state) => state.data?.map((todo) => todo.id));
svelte.mutationStore<{ id: string }>("addTodo").run("Ship Svelte types");
svelte.authStore().subscribe((state) => state.isAuthenticated());
stopSvelteQuery();
const querySubscription = queries.subscribe<Array<{ id: string; text: string }>>("todos", (state) => {
  state.data?.map((todo) => todo.text.toUpperCase());
  state.error?.message.toUpperCase();
  state.loading.valueOf();
});
querySubscription.unsubscribe();
mutations.run("addTodo", "Ship the framework-neutral types").then((result) => result.error?.message);
auth.get().then((result) => result.data?.auth?.userId);
const authSubscription = auth.subscribe((state) => {
  state.auth?.userId.toUpperCase();
  Object.values(state.providers).forEach((provider) => provider?.enabled.valueOf());
});
authSubscription.unsubscribe();
auth.signUp("email", { email: "a@example.com", password: "secret", name: "Ada" });
accessKeys.issue({ name: "bot", grants: ["requests:*"] }).then((result) => result.data?.token.toUpperCase());
accessKeys.list({ status: "active", limit: 20 }).then((result) => result.data?.accessKeys.map((key) => key.effectiveScopes));
accessKeys.rotate("key-id", { lifecycleRevision: 1 });
accessKeys.revoke("key-id");
accessKeys.delete("key-id");
const accessKeyErrorCode: AccessKeyErrorCode = "ACCESS_KEY_REVISION_CONFLICT";
const accessKeyTransportErrorCode: AccessKeyErrorCode = "TRANSPORT_CLOSED";
accessKeyErrorCode.toLowerCase();
// @ts-expect-error browser auth API does not expose privileged server-role authority.
auth.privileged;
// @ts-expect-error browser file API cannot run privileged file operations.
files.privileged;
// @ts-expect-error browser auth API has no direct Job Queue authority.
auth.jobs;
// @ts-expect-error browser APIs have no direct SMTP authority.
auth.mail;
files.upload(new Blob(["hello"], { type: "text/plain" }));
files.publicUrl("/docs/hello.txt", { expires: new globalThis.Date() });
// @ts-expect-error public URL expiry option is named expires, not expiresAt.
files.publicUrl("/docs/hello.txt", { expiresAt: new globalThis.Date() });
preferences.get().then((result) => result.data?.preferences.theme);
preferences.update({ theme: "dark", sidebar: { collapsed: true } }).then((result) => result.data?.preferences.sidebar);
// @ts-expect-error preferences.update accepts a JSON object patch.
preferences.update(null);
teams.list().then((result) => result.data?.teams.map((team) => team.memberCount));
teams.create("Browser Team").then((result) => result.data?.team.id);
teams.rename("00000000-0000-4000-8000-000000000000", "Renamed Browser Team").then((result) => result.data?.team.name);
teams.listMembers("00000000-0000-4000-8000-000000000000").then((result) => result.data?.members.map((member) => member.displayName));
teams.listMembers("00000000-0000-4000-8000-000000000000", { cursor: "opaque", limit: 25 }).then((result) => result.data?.totalCount.valueOf());
teams.countMembers("00000000-0000-4000-8000-000000000000").then((result) => result.data?.totalCount.valueOf());
teams.updateApplicationRoles("00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000", { add: ["author"], remove: ["reviewer"] }).then((result) => result.data?.updated.valueOf());
teams.validateJoinLink("opaque-join-code").then((result) => result.data?.valid.valueOf());
teams.join("opaque-join-code").then((result) => result.data?.team.applicationRoles);
teams.promote("00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000").then((result) => result.data?.updated.valueOf());
teams.demote("00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000").then((result) => result.data?.updated.valueOf());
teams.removeMember("00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000").then((result) => result.data?.removed.valueOf());
teams.leave("00000000-0000-4000-8000-000000000000").then((result) => result.data?.left.valueOf());
teams.delete("00000000-0000-4000-8000-000000000000").then((result) => result.data?.deleted.valueOf());
// @ts-expect-error the initial Teams interface does not accept a current-Team selection or inputs.
teams.list("current-team");
// @ts-expect-error Team names must be strings.
teams.create({ name: "not a string" });
// @ts-expect-error Team renames always require an explicit Team ID.
teams.rename("Renamed Browser Team");
// @ts-expect-error membership directories always require an explicit Team ID.
teams.listMembers();
// @ts-expect-error application-role changes require both bounded add and remove arrays.
teams.updateApplicationRoles("00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000", { add: ["author"] });
// @ts-expect-error application-role changes are not an arbitrary browser payload.
teams.updateApplicationRoles("00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000", { add: "author", remove: [] });
// @ts-expect-error application-role updates require explicit string Team and user IDs.
teams.updateApplicationRoles({ teamId: "not-a-string" }, "00000000-0000-4000-8000-000000000000", { add: [], remove: [] });
// @ts-expect-error Team IDs must be strings.
teams.listMembers({ teamId: "not-a-string" });
// @ts-expect-error member counts require an explicit string Team ID.
teams.countMembers({ teamId: "not-a-string" });
// @ts-expect-error member page limits must be numbers.
teams.listMembers("00000000-0000-4000-8000-000000000000", { limit: "25" });
// @ts-expect-error Join codes must be strings.
teams.validateJoinLink({ code: "not-a-string" });
// @ts-expect-error Join codes must be strings.
teams.join({ code: "not-a-string" });
// @ts-expect-error Team lifecycle IDs must be strings.
teams.promote("00000000-0000-4000-8000-000000000000", { userId: "not-a-string" });
// @ts-expect-error removeMember requires an explicit target user ID.
teams.removeMember("00000000-0000-4000-8000-000000000000");
// @ts-expect-error leave requires an explicit Team ID.
teams.leave();
journey.enable({ capture: { focus: false } }).then((result) => result.data?.enabled);
journey.set({ status: "editing", metadata: { document: "roadmap" }, ttlSeconds: 20 });
journey.list().then((result) => result.data?.journeys.map((entry) => entry.userId));
const journeyRecord: JourneyRecord = { sessionId: "session", userId: "user", status: "online", metadata: null, updatedAt: "now", expiresAt: "later" };
journeyRecord.metadata;
// @ts-expect-error public Journey records require an explicit metadata field.
const incompleteJourneyRecord: JourneyRecord = { sessionId: "session", userId: "user", status: "online", updatedAt: "now", expiresAt: "later" };
const journeySubscription = journey.subscribe((event) => event.type === "snapshot" ? event.states : event.state);
journeySubscription.unsubscribe();
journey.disable();
queries.subscribe("greetingFor", () => {}, "Ada", { uppercase: true });
// @ts-expect-error Query arguments must be JSON-compatible.
queries.subscribe("greetingFor", () => {}, new Date());
createHooks({ useState: <State,>(value: State | (() => State)): [State, (next: State) => void] => [typeof value === "function" ? (value as () => State)() : value, () => {}], useEffect: () => {} }).useQuery("greetingFor", "Ada", { uppercase: true });
createVueComposables({ reactive: (value) => value, onScopeDispose: () => {} }).useQuery("greetingFor", "Ada");
createSolidPrimitives({ createSignal: (value) => [() => value, () => value], onCleanup: () => {} }).createQuery("greetingFor", "Ada");
const queryHost = { addController() {}, requestUpdate() {} };
createLitControllers().queryController(queryHost, "greetingFor", "Ada");
createInfernoAdapters().queryAdapter({ forceUpdate() {} }, "greetingFor", "Ada");
createSvelteStores().queryStore("greetingFor", "Ada");
// @ts-expect-error journey.set requires an object with a status.
journey.set(null);
// @ts-expect-error Journey metadata is a top-level JSON object, not an array.
journey.set({ status: "editing", metadata: [] });
isAuthenticated().then((ok) => ok.valueOf());
sendMessage("typing", { active: true });
onMessage<{ active: boolean }>()
  .filter((event) => event.type === "typing" && event.data?.active === true)
  .subscribe(() => {});

app.kind satisfies "capsule";
`,
    );

    const result = await run(path.join(repoRoot, "node_modules", ".bin", "tsc"), ["--project", dir], { cwd: dir });

    assert.equal(result.code, 0, result.stdout + result.stderr);
  });
});
