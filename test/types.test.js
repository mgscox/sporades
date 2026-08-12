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
      `import { Boolean, Date, Json, Number, Reference, String, capsule, emailEvent, endpoint, job, message, mutation, query, requireAuth, schedule, table } from "sporades/server";
import { auth, createHooks, createInfernoAdapters, createLitControllers, createSolidPrimitives, createSvelteStores, createVueComposables, files, isAuthenticated, journey, mutations, onMessage, preferences, queries, sendMessage, type JourneyRecord } from "sporades/client";

const app = capsule({
  name: "typed island",
  journey: { enabled: true, ttlSeconds: 30, capture: { navigation: true, focus: false } },
  emailEvents: emailEvent(async (ctx, event) => {
    ctx.log.info("email event", event.provider, event.kind, event.providerEventId, event.occurredAt);
    event.correlationId?.toUpperCase();
    event.recipient?.toUpperCase();
    JSON.stringify(event.raw);
    // @ts-expect-error Provider-specific payload fields stay under raw.
    event.Message_GUID;
  }),
  jobs: {
    summarise: job(async (ctx, payload) => {
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
        return row?.ownerId === ctx.auth.userId && userExists && hasFile === (file !== null) && file !== null && file.path.startsWith("/");
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
    privilegedTodos: query(async (ctx) => {
      const rows = await ctx.privileged.run({
        operation: "todos.maintenance.read",
        targetResourceKind: "capsule-db",
        metadata: { reason: "type-test" },
        signal: new AbortController().signal,
      }, async (privilegedCtx) => {
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
      return {
        path: ctx.request.path,
        userId: requireAuth(ctx).userId,
        count: ctx.db.todos.all().length,
      };
    }),
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
