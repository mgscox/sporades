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
      `import { Boolean, Date, Json, Number, Reference, String, capsule, endpoint, message, mutation, query, table } from "sporades/server";
import { auth, createHooks, files, isAuthenticated, onMessage, sendMessage } from "sporades/client";

const app = capsule({
  name: "typed island",
  schema: {
    users: table({
      name: String(),
    }),
    todos: table({
      text: String(),
      done: Boolean().default(false),
      effort: Number().default(1),
      dueAt: Date(),
      meta: Json<{ tags: string[] }>().default({ tags: [] }),
      authorId: Reference("users").default(null),
      ownerId: String(),
    }),
  },
  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .limit(50)
        .all(),
    ),
  },
  mutations: {
    addTodo: mutation((ctx, text) => {
      ctx.log.info("adding", text.trim());
      ctx.db.todos.insert({
        text: text.trim(),
        ownerId: ctx.auth.userId,
        dueAt: new globalThis.Date(),
        meta: { tags: ["typed"] },
        authorId: null,
      });
    }),
  },
  endpoints: {
    ping: endpoint({ method: "GET", path: "/ping" }, (ctx) => ({
      path: ctx.request.path,
      userId: ctx.auth.userId,
      count: ctx.db.todos.all().length,
    })),
  },
  messages: {
    typing: message((ctx, data) => {
      ctx.messages.send({ type: "typing", data, scope: "currentUser" });
    }),
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
auth.signUp("email", { email: "a@example.com", password: "secret", name: "Ada" });
files.upload(new Blob(["hello"], { type: "text/plain" }));
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
