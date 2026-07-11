import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const rootPackageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const expectedSporadesVersionRange = `^${rootPackageJson.version}`;

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-create-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
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

test("sporades --help prints top-level CLI help", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["--help"], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage: sporades <command> \[options\]/);
    assert.match(result.stdout, /Commands:/);
    assert.match(result.stdout, /create <name>/);
    assert.match(result.stdout, /--help, -h/);
  });
});

test("sporades -h prints top-level CLI help", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["-h"], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage: sporades <command> \[options\]/);
    assert.match(result.stdout, /--help, -h/);
  });
});

test("sporades --version prints the baked local CLI version", async () => {
  await withTempDir(async (dir) => {
    const plain = await runCli(["--version"], { cwd: dir });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stderr, "");
    assert.equal(plain.stdout, `${rootPackageJson.version}\n`);

    const shorthandJson = await runCli(["-v", "--json"], { cwd: dir });
    assert.equal(shorthandJson.code, 0, shorthandJson.stderr);
    assert.deepEqual(JSON.parse(shorthandJson.stdout), {
      ok: true,
      data: { version: rootPackageJson.version, source: "cli" },
      error: null,
    });
  });
});

test("sporades command --help prints command-specific help", async () => {
  const cases = [
    ["create", /^Usage: sporades create <name> \[options\]/, /--template <name>/],
    ["dev", /^Usage: sporades dev \[status\|stop\|reset\] \[options\]/, /--public/],
    ["auth", /^Usage: sporades auth <command> \[options\]/, /set google/],
    ["security", /^Usage: sporades security \[options\]/, /--session <name>/],
    ["doctor", /^Usage: sporades doctor \[options\]/, /--strict/],
    ["env", /^Usage: sporades env <command> \[options\]/, /reencrypt/],
    ["deploy", /^Usage: sporades deploy \[status\|stop\|restart\|remove\|reset\|ssh\] \[options\]/, /deploy ssh/],
    ["host", /^Usage: sporades host <command> \[options\]/, /github workflow write/],
    ["logs", /^Usage: sporades logs \[tail\] \[options\]/, /logs tail/],
    ["db", /^Usage: sporades db <command> \[options\]/, /query <sql>/],
  ];

  await withTempDir(async (dir) => {
    for (const [command, usage, detail] of cases) {
      const result = await runCli([command, "--help"], { cwd: dir });

      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, usage);
      assert.match(result.stdout, detail);
    }
  });
});

test("sporades create writes a runnable React blank scaffold by default", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "blank-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "blank-island")), template: "blank" },
      error: null,
    });

    const projectDir = path.join(dir, "blank-island");
    const entries = await readdir(projectDir);
    assert.deepEqual(
      entries.toSorted(),
      [
        ".env.sporades.server",
        ".gitignore",
        "AGENTS.md",
        "CLAUDE.md",
        "README.md",
        "client",
        "index.html",
        "package.json",
        "server",
        "shared",
        "sporades.json",
      ].toSorted(),
    );

    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.name, "blank-island");
    assert.equal(config.template, "blank");
    assert.equal(config.client.framework, "react");
    assert.equal(config.auth.mode, "anonymous");

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /capsule\(/);
    assert.match(serverEntry, /schema: \{\}/);
    assert.match(serverEntry, /queries: \{\}/);
    assert.match(serverEntry, /mutations: \{\}/);
    assert.doesNotMatch(serverEntry, /todos|auth|files|messages/);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /createRoot/);
    assert.match(clientEntry, /Blank Sporades Capsule/);
    assert.doesNotMatch(clientEntry, /createHooks|useQuery|useMutation|useAuth|files|messages|todo/i);

    const agents = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
    assert.match(agents, /Template: blank/);
    const readme = await readFile(path.join(projectDir, "README.md"), "utf8");
    assert.match(readme, /A blank Sporades capsule\./);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.react, "^19.0.0");
    assert.equal(packageJson.dependencies["react-dom"], "^19.0.0");
    assert.equal(packageJson.devDependencies["@types/react"], "^19.0.0");
    assert.equal(packageJson.devDependencies["@types/react-dom"], "^19.0.0");
    assert.equal(packageJson.devDependencies.sporades, expectedSporadesVersionRange);
  });
});

test("sporades create writes safe default security policy to sporades.json", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "secure-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(result.code, 0, result.stderr);

    const projectDir = path.join(dir, "secure-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.deepEqual(config.security, {
      cors: {
        allowedOrigins: [],
      },
      csp: {
        mode: "report-only",
      },
    });

    const security = await runCli(["security", "--session", "container", "--json"], { cwd: projectDir });
    assert.equal(security.code, 0, security.stderr);
    const body = JSON.parse(security.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.data.session, "container");
    assert.deepEqual(body.data.security.cors, {
      sameOrigin: true,
      publicDev: false,
      allowedOrigins: [],
      allowedOriginPatterns: [],
      requireExplicitCrossOrigin: true,
    });
    assert.equal(body.data.security.csp.header, "content-security-policy-report-only");
  });
});

test("sporades create writes a runnable React todo scaffold when requested", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "todo-island")), template: "todo" },
      error: null,
    });

    const projectDir = path.join(dir, "todo-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.name, "todo-island");
    assert.equal(config.template, "todo");

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /todos: table\(/);
    assert.match(serverEntry, /String\(\)/);
    assert.match(serverEntry, /Boolean\(\)\.default\(false\)/);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /createHooks/);
    assert.match(clientEntry, /useQuery\("todos"\)/);
    assert.match(clientEntry, /useMutation\("addTodo"\)/);

    const agents = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
    assert.match(agents, /Template: todo/);
    const readme = await readFile(path.join(projectDir, "README.md"), "utf8");
    assert.match(readme, /A Sporades todo capsule\./);
  });
});

test("sporades create writes a runnable React guestbook scaffold when requested", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "guest-island", "--template", "guestbook", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "guest-island")), template: "guestbook" },
      error: null,
    });

    const projectDir = path.join(dir, "guest-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.name, "guest-island");
    assert.equal(config.template, "guestbook");

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /entries: table\(/);
    assert.match(serverEntry, /body: String\(\)/);
    assert.match(serverEntry, /authorId: String\(\)/);
    assert.match(serverEntry, /authorName: String\(\)/);
    assert.match(serverEntry, /authorPicture: String\(\)/);
    assert.match(serverEntry, /entries: query/);
    assert.match(serverEntry, /orderBy\("createdAt", "desc"\)/);
    assert.match(serverEntry, /\.limit\(50\)/);
    assert.match(serverEntry, /sign: mutation/);
    assert.match(serverEntry, /body\.trim\(\)/);
    assert.match(serverEntry, /throw new Error\("Write a message before signing\."\)/);
    assert.match(serverEntry, /throw new Error\("Guestbook messages must be 280 characters or fewer\."\)/);
    assert.match(serverEntry, /authorId: ctx\.auth\.userId/);
    assert.match(serverEntry, /authorName: ctx\.auth\.displayName/);
    assert.match(serverEntry, /authorPicture: ctx\.auth\.picture/);
    assert.doesNotMatch(serverEntry, /avatar|upload/i);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /createHooks/);
    assert.match(clientEntry, /useAuth/);
    assert.match(clientEntry, /useQuery\("entries"\)/);
    assert.match(clientEntry, /useMutation\("sign"\)/);
    assert.match(clientEntry, /auth\.signIn\("google"\)/);
    assert.match(clientEntry, /auth\.signOut\(\)/);
    assert.match(clientEntry, /Sign in with Google/);
    assert.match(clientEntry, /Sign out/);
    assert.doesNotMatch(clientEntry, /providers\.google\?\.configured/);
    assert.match(clientEntry, /authorPicture/);
    assert.doesNotMatch(clientEntry, /better-auth|googleapis|gapi|oauth|accounts\.google|avatar|upload/i);

    const agents = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
    assert.match(agents, /Template: guestbook/);
    const readme = await readFile(path.join(projectDir, "README.md"), "utf8");
    assert.match(readme, /A Sporades guestbook capsule\./);
    assert.match(readme, /Trusted author fields come from `ctx\.auth`/);
  });
});

test("sporades create writes a complete Campfire exemplar", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "campfire-island", "--template", "campfire", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const project = path.join(dir, "campfire-island");
    const [config, packageJson, html, server, client, readme, button] = await Promise.all([
      readFile(path.join(project, "sporades.json"), "utf8").then(JSON.parse),
      readFile(path.join(project, "package.json"), "utf8").then(JSON.parse),
      readFile(path.join(project, "index.html"), "utf8"),
      readFile(path.join(project, "server/index.ts"), "utf8"),
      readFile(path.join(project, "client/index.tsx"), "utf8"),
      readFile(path.join(project, "README.md"), "utf8"),
      readFile(path.join(project, "client/components/ui/button.tsx"), "utf8"),
    ]);
    assert.equal(config.template, "campfire");
    assert.deepEqual(config.auth.providers, { anonymous: true, email: true });
    assert.match(html, /cdn\.tailwindcss\.com/);
    assert.match(server, /journey:\s*\{\s*enabled:\s*true/);
    for (const channel of ["general", "ideas", "random", "protect-the-crown"]) assert.match(client, new RegExp(channel));
    for (const musketeer of ["Athos", "Porthos", "Aramis", "d'Artagnan"]) assert.match(client + readme, new RegExp(musketeer.replace("'", "\\\\?['’]"), "i"));
    assert.match(client, /journey\.enable/);
    assert.match(client, /journey\.disable/);
    assert.match(client, /journey\.subscribe/);
    assert.match(server, /toggleReaction/);
    assert.match(server, /ctx\.auth\.userId/);
    assert.match(readme, /development-only/i);
    assert.match(readme, /separate browser contexts/i);
    assert.match(button, /export function Button/);
    assert.equal(packageJson.dependencies["lucide-react"], undefined, "generated dependencies contain no unused icon package");
    for (const component of ["card", "avatar", "badge", "switch", "input", "separator", "scroll-area"]) {
      const source = await readFile(path.join(project, `client/components/ui/${component}.tsx`), "utf8");
      assert.match(source, /export function/);
      assert.match(client, new RegExp(`components/ui/${component}`));
      if (component === "switch") assert.match(source, /role="switch"/);
    }
    assert.match(client, /aria-label/);
    assert.match(client, /fixedChannels\.map\(\(slug\) => <button key=\{slug\}/);
    assert.match(client, /musketeers\.map\(\(person\) => <Button key=\{person\.key\}/);
    assert.match(client, /return <button key=\{kind\}/);
  });
});

test("sporades create writes Campfire for Preact", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "preact-campfire", "--template", "campfire", "--framework", "preact", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const client = await readFile(path.join(dir, "preact-campfire", "client/index.tsx"), "utf8");
    assert.match(client, /from "preact"/);
    assert.match(client, /journey\.subscribe/);
  });
});

test("Campfire automatically prepares fixtures and restores per-Musketeer activity sharing", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "remembering-campfire", "--template", "campfire", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const client = await readFile(path.join(dir, "remembering-campfire", "client/index.tsx"), "utf8");
    assert.match(client, /import \{ auth, createHooks, journey, preferences \} from "sporades\/client"/);
    assert.match(client, /useEffect\(\(\) => \{[\s\S]*prepareFixtures\(\)/);
    assert.match(client, /preferences\.get\(\)/);
    assert.match(client, /preferences\.update\(\{ campfireShareActivity: enabled \}\)/);
    assert.match(client, /status: kind === "up" \? "liked" : "disliked"/);
    assert.match(client, /status: "posted"/);
    assert.match(client, /posted a message in/);
  });
});

test("Campfire typing publication is throttled and renewed while input remains active", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "cadence-campfire", "--template", "campfire", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const source = await readFile(path.join(dir, "cadence-campfire", "client/journey-typing.ts"), "utf8");
    const { createTypingPublisher } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    let now = 0;
    let nextTimer = 1;
    const timers = new Map();
    const published = [];
    const publisher = createTypingPublisher((state) => published.push({ at: now, state }), {
      now: () => now,
      setTimer: (fn, delay) => { const id = nextTimer++; timers.set(id, { at: now + delay, fn }); return id; },
      clearTimer: (id) => timers.delete(id),
    });
    const advance = (milliseconds) => { now += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
    publisher.input("a", "general");
    publisher.input("ab", "general");
    publisher.input("abc", "general");
    assert.equal(published.length, 1, "input bursts publish once immediately");
    advance(750);
    assert.equal(published.length, 2, "latest active input publishes after the throttle window");
    advance(2500);
    assert.equal(published.length, 3, "active typing renews before its four-second TTL");
    publisher.stop("general");
    assert.equal(published.at(-1).state.status, "reading");
    advance(5000);
    assert.equal(published.at(-1).state.status, "reading", "stopped typing does not renew");
  });
});

test("Campfire auth transitions retire Journey consent and typing timers", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "lifecycle-campfire", "--template", "campfire", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const source = await readFile(path.join(dir, "lifecycle-campfire", "client/journey-lifecycle.ts"), "utf8");
    const client = await readFile(path.join(dir, "lifecycle-campfire", "client/index.tsx"), "utf8");
    const { retireJourneyConsent } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    const calls = [];
    await retireJourneyConsent({
      typingPublisher: { dispose: () => calls.push("dispose") },
      journey: { disable: async () => calls.push("disable") },
      setSharing: (value) => calls.push(`sharing:${value}`),
    });
    assert.deepEqual(calls, ["dispose", "disable", "sharing:false"]);
    assert.equal((client.match(/await retireJourneyConsent/g) ?? []).length, 2, "fixture preparation and identity switching share retirement cleanup");
  });
});

test("sporades create writes a minimal React photo library scaffold when requested", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "photos-island", "--template", "photo-library", "--no-install", "--no-git", "--json"],
      {
        cwd: dir,
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "photos-island")), template: "photo-library" },
      error: null,
    });

    const projectDir = path.join(dir, "photos-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.name, "photos-island");
    assert.equal(config.template, "photo-library");
    assert.equal(config.client.framework, "react");
    assert.deepEqual(config.auth, {
      providers: {
        anonymous: true,
        google: {
          clientIdEnv: "GOOGLE_CLIENT_ID",
          clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        },
      },
    });
    const envFile = await readFile(path.join(projectDir, ".env.sporades.server"), "utf8");
    assert.match(envFile, /^GOOGLE_CLIENT_ID=replace-with-google-client-id$/m);
    assert.match(envFile, /^GOOGLE_CLIENT_SECRET=replace-with-google-client-secret$/m);

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /photos: table\(/);
    assert.match(serverEntry, /fileId: String\(\)/);
    assert.match(serverEntry, /fileName: String\(\)/);
    assert.match(serverEntry, /fileType: String\(\)/);
    assert.match(serverEntry, /fileSize: Number\(\)/);
    assert.match(serverEntry, /imageUrl: String\(\)/);
    assert.match(serverEntry, /publicUrlId: String\(\)/);
    assert.match(serverEntry, /ownerId: String\(\)/);
    assert.match(serverEntry, /ownerName: String\(\)/);
    assert.match(serverEntry, /isPublic: Boolean\(\)\.default\(false\)/);
    assert.match(serverEntry, /publicPhotos: query/);
    assert.match(serverEntry, /\.where\("isPublic", true\)/);
    assert.match(serverEntry, /personalPhotos: query/);
    assert.match(serverEntry, /ctx\.auth\.provider !== "google"/);
    assert.match(serverEntry, /recordPhoto: mutation/);
    assert.match(serverEntry, /job, mutation, Number, query, schedule, String, table/);
    assert.match(serverEntry, /timestampPhotoNames: job/);
    assert.match(serverEntry, /expression: "\* \* \* \* \*"/);
    assert.match(serverEntry, /job: "timestampPhotoNames"/);
    assert.match(serverEntry, /toISOString\(\)\.slice\(11, 16\)/);
    assert.match(serverEntry, /ctx\.db\.photos\.update/);
    assert.match(serverEntry, /ctx\.auth\.provider === "google" \? globalThis\.Boolean\(input\.isPublic\) : true/);
    assert.match(serverEntry, /throw new Error\("Public photos need a public file URL\."\)/);
    assert.match(serverEntry, /ctx\.db\.photos\.insert/);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /createRoot/);
    assert.match(clientEntry, /auth, createHooks, files/);
    assert.match(clientEntry, /useAuth/);
    assert.match(clientEntry, /useQuery\("publicPhotos"\)/);
    assert.match(clientEntry, /useQuery\("personalPhotos"\)/);
    assert.match(clientEntry, /useMutation\("recordPhoto"\)/);
    assert.match(clientEntry, /useMutation\("updatePhotoIsPublic"\)/);
    assert.match(clientEntry, /useMutation\("updatePhotoImageUrl"\)/);
    assert.match(clientEntry, /useMutation\("updatePhotoPublicUrlId"\)/);
    assert.match(clientEntry, /files\.upload/);
    assert.match(clientEntry, /files\.publicUrl/);
    assert.match(clientEntry, /files\.revokePublicUrl/);
    assert.match(clientEntry, /auth\.signIn\("google"\)/);
    assert.match(clientEntry, /auth\.signOut\(\)/);
    assert.match(clientEntry, /Public gallery/);
    assert.match(clientEntry, /My library/);
    assert.match(clientEntry, /Photo Library/);
    assert.doesNotMatch(clientEntry, /better-auth|googleapis|gapi|oauth|accounts\.google/i);

    const agents = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
    assert.match(agents, /Template: photo-library/);
    const readme = await readFile(path.join(projectDir, "README.md"), "utf8");
    assert.match(readme, /A Sporades photo library capsule\./);
    assert.match(readme, /Uploads use `files\.upload\(\)`/);
    assert.match(readme, /Replace them with real OAuth credentials via `sporades auth set google`/);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.react, "^19.0.0");
    assert.equal(packageJson.dependencies["react-dom"], "^19.0.0");
    assert.equal(packageJson.dependencies.preact, undefined);
    assert.equal(packageJson.devDependencies["@types/react"], "^19.0.0");
    assert.equal(packageJson.devDependencies["@types/react-dom"], "^19.0.0");
  });
});

test("sporades create --template blank writes the blank scaffold", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "blank-island", "--template", "blank", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "blank-island")), template: "blank" },
      error: null,
    });

    const projectDir = path.join(dir, "blank-island");
    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));

    assert.equal(config.template, "blank");
    assert.match(serverEntry, /schema: \{\}/);
    assert.doesNotMatch(serverEntry, /todos|auth|files|messages/);
    assert.match(clientEntry, /Blank Sporades Capsule/);
    assert.doesNotMatch(clientEntry, /useQuery|useMutation|useAuth|files|messages|todo/i);
  });
});

test("sporades create --template blank preserves framework selection", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "blank-island", "--template", "blank", "--framework", "preact", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "blank-island")), template: "blank" },
      error: null,
    });

    const projectDir = path.join(dir, "blank-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.template, "blank");
    assert.equal(config.client.framework, "preact");

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /from "preact"/);
    assert.doesNotMatch(clientEntry, /react-dom|createHooks|useAuth|files|messages|todo/i);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.preact, "^10.25.0");
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies["react-dom"], undefined);
    assert.equal(packageJson.devDependencies["@types/react"], undefined);
    assert.equal(packageJson.devDependencies["@types/react-dom"], undefined);
  });
});

test("sporades/server exports the endpoint builder", async () => {
  const runtime = await import("sporades/server");
  const handler = () => "pong";

  assert.equal(typeof runtime.endpoint, "function");
  assert.deepEqual(runtime.endpoint({ method: "POST", path: "/integrations/ping" }, handler), {
    kind: "endpoint",
    options: { method: "POST", path: "/integrations/ping" },
    handler,
  });
});

test("sporades/server exports the message builder", async () => {
  const runtime = await import("sporades/server");
  const handler = () => ({ ok: true });

  assert.equal(typeof runtime.message, "function");
  assert.deepEqual(runtime.message(handler), {
    kind: "message",
    handler,
  });
});

test("sporades/server exports the Json field builder", async () => {
  const runtime = await import("sporades/server");
  const field = runtime.Json();

  assert.equal(typeof runtime.Json, "function");
  assert.equal(field.kind, "Json");
  assert.equal(typeof field.default, "function");
  assert.deepEqual(field.default({ tags: ["json"] }), {
    kind: "Json",
    defaultValue: { tags: ["json"] },
  });
});

test("sporades/server exports the Reference field builder", async () => {
  const runtime = await import("sporades/server");

  assert.equal(typeof runtime.Reference, "function");
  const reference = runtime.Reference("users");
  assert.equal(typeof reference.default, "function");
  assert.deepEqual({ kind: reference.kind, targetTable: reference.targetTable }, {
    kind: "Reference",
    targetTable: "users",
  });
  assert.deepEqual(reference.default("user-1"), {
    kind: "Reference",
    targetTable: "users",
    defaultValue: "user-1",
  });
});

test("sporades create writes a runnable Preact todo scaffold", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "todo-island", "--template", "todo", "--framework", "preact", "--no-install", "--no-git", "--json"],
      {
        cwd: dir,
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "todo-island")), template: "todo" },
      error: null,
    });

    const projectDir = path.join(dir, "todo-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.template, "todo");
    assert.equal(config.client.framework, "preact");

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /todos: table\(/);
    assert.match(serverEntry, /addTodo: mutation/);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /from "preact"/);
    assert.match(clientEntry, /from "preact\/hooks"/);
    assert.match(clientEntry, /createHooks\(\{ useState, useEffect \}\)/);
    assert.match(clientEntry, /useQuery\("todos"\)/);
    assert.match(clientEntry, /useMutation\("addTodo"\)/);
    assert.match(clientEntry, /onInput=/);
    assert.doesNotMatch(clientEntry, /react-dom/);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.preact, "^10.25.0");
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies["react-dom"], undefined);
    assert.equal(packageJson.devDependencies["@types/react"], undefined);
    assert.equal(packageJson.devDependencies["@types/react-dom"], undefined);
    assert.equal(packageJson.devDependencies.sporades, expectedSporadesVersionRange);
  });
});

test("sporades create writes a runnable Preact guestbook scaffold", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "guest-island", "--template", "guestbook", "--framework", "preact", "--no-install", "--no-git", "--json"],
      {
        cwd: dir,
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "guest-island")), template: "guestbook" },
      error: null,
    });

    const projectDir = path.join(dir, "guest-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.template, "guestbook");
    assert.equal(config.client.framework, "preact");

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /from "preact"/);
    assert.match(clientEntry, /from "preact\/hooks"/);
    assert.match(clientEntry, /createHooks\(\{ useState, useEffect \}\)/);
    assert.match(clientEntry, /useQuery\("entries"\)/);
    assert.match(clientEntry, /useMutation\("sign"\)/);
    assert.match(clientEntry, /auth\.signIn\("google"\)/);
    assert.match(clientEntry, /auth\.signOut\(\)/);
    assert.match(clientEntry, /Sign in with Google/);
    assert.match(clientEntry, /Sign out/);
    assert.doesNotMatch(clientEntry, /providers\.google\?\.configured/);
    assert.match(clientEntry, /onInput=/);
    assert.doesNotMatch(clientEntry, /react-dom|better-auth|googleapis|gapi|oauth|accounts\.google|avatar|upload/i);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.preact, "^10.25.0");
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies["react-dom"], undefined);
    assert.equal(packageJson.devDependencies["@types/react"], undefined);
    assert.equal(packageJson.devDependencies["@types/react-dom"], undefined);
  });
});

test("sporades create writes a runnable Preact photo library scaffold", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "photos-island", "--template", "photo-library", "--framework", "preact", "--no-install", "--no-git", "--json"],
      {
        cwd: dir,
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "photos-island")), template: "photo-library" },
      error: null,
    });

    const projectDir = path.join(dir, "photos-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(config.template, "photo-library");
    assert.equal(config.client.framework, "preact");

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /from "preact"/);
    assert.match(clientEntry, /from "preact\/hooks"/);
    assert.match(clientEntry, /auth, createHooks, files/);
    assert.match(clientEntry, /createHooks\(\{ useState, useEffect \}\)/);
    assert.match(clientEntry, /useAuth/);
    assert.match(clientEntry, /useQuery\("publicPhotos"\)/);
    assert.match(clientEntry, /useQuery\("personalPhotos"\)/);
    assert.match(clientEntry, /useMutation\("recordPhoto"\)/);
    assert.match(clientEntry, /useMutation\("updatePhotoIsPublic"\)/);
    assert.match(clientEntry, /files\.upload/);
    assert.match(clientEntry, /files\.publicUrl/);
    assert.match(clientEntry, /auth\.signIn\("google"\)/);
    assert.match(clientEntry, /auth\.signOut\(\)/);
    assert.match(clientEntry, /Photo Library/);
    assert.doesNotMatch(clientEntry, /react-dom|better-auth|googleapis|gapi|oauth|accounts\.google/i);

    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies.preact, "^10.25.0");
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies["react-dom"], undefined);
    assert.equal(packageJson.devDependencies["@types/react"], undefined);
    assert.equal(packageJson.devDependencies["@types/react-dom"], undefined);
  });
});

test("sporades create rejects unsupported framework values with structured JSON", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "bad-framework", "--framework", "angular", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unsupported framework: angular",
        hint: "Use one of: react, preact.",
      },
    });
  });
});

test("sporades create rejects unsupported template values with structured JSON", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "bad-template", "--template", "blog", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unsupported template: blog",
        hint: "Use one of: blank, todo, guestbook, photo-library.",
      },
    });
  });
});

test("sporades auth status reports anonymous and Google OAuth configuration state", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const anonymousStatus = await runCli(["auth", "status", "--json"], { cwd: projectDir });
    assert.equal(anonymousStatus.code, 0, anonymousStatus.stderr);
    assert.deepEqual(JSON.parse(anonymousStatus.stdout), {
      ok: true,
      data: {
        mode: "anonymous",
        providers: {
          anonymous: {
            enabled: true,
          },
          google: {
            enabled: false,
            configured: false,
            clientIdEnv: null,
            clientSecretEnv: null,
          },
        },
        google: {
          configured: false,
          clientIdEnv: null,
          clientSecretEnv: null,
        },
      },
      error: null,
    });

    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "google-client-id", "--client-secret", "super-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);
    assert.doesNotMatch(setResult.stdout, /super-secret/);
    assert.deepEqual(JSON.parse(setResult.stdout), {
      ok: true,
      data: {
        mode: "google",
        providers: {
          anonymous: {
            enabled: true,
          },
          google: {
            enabled: true,
            configured: true,
            clientIdEnv: "GOOGLE_CLIENT_ID",
            clientSecretEnv: "GOOGLE_CLIENT_SECRET",
          },
        },
        google: {
          configured: true,
          clientIdEnv: "GOOGLE_CLIENT_ID",
          clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        },
      },
      error: null,
    });

    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.deepEqual(config.auth, {
      mode: "google",
      google: {
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      },
    });
    assert.doesNotMatch(JSON.stringify(config), /super-secret/);
    const envFile = await readFile(path.join(projectDir, ".env.sporades.server"), "utf8");
    assert.match(envFile, /^GOOGLE_CLIENT_ID=google-client-id$/m);
    assert.match(envFile, /^GOOGLE_CLIENT_SECRET=super-secret$/m);

    const googleStatus = await runCli(["auth", "status", "--json"], { cwd: projectDir });
    assert.equal(googleStatus.code, 0, googleStatus.stderr);
    assert.deepEqual(JSON.parse(googleStatus.stdout).data.google.configured, true);
  });
});

test("sporades auth status reports multi-provider configuration without secrets", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.auth = {
      providers: {
        anonymous: true,
        google: {
          clientIdEnv: "GOOGLE_CLIENT_ID",
          clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        },
        email: true,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=google-client-id\nGOOGLE_CLIENT_SECRET=super-secret\n");

    const status = await runCli(["auth", "status", "--json"], { cwd: projectDir });
    assert.equal(status.code, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /google-client-id|super-secret/);
    assert.deepEqual(JSON.parse(status.stdout), {
      ok: true,
      data: {
        mode: "google",
        providers: {
          anonymous: {
            enabled: true,
          },
          google: {
            enabled: true,
            configured: true,
            clientIdEnv: "GOOGLE_CLIENT_ID",
            clientSecretEnv: "GOOGLE_CLIENT_SECRET",
          },
          email: {
            enabled: true,
          },
        },
        google: {
          configured: true,
          clientIdEnv: "GOOGLE_CLIENT_ID",
          clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        },
      },
      error: null,
    });
  });
});

test("sporades auth set google can read a Google OAuth client JSON file", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    await writeFile(
      path.join(projectDir, "client_secret_google.json"),
      `${JSON.stringify({
        web: {
          client_id: "json-client-id.apps.googleusercontent.com",
          client_secret: "json-client-secret",
          redirect_uris: ["http://localhost:4000/__sporades/auth/google/callback"],
        },
      })}\n`,
    );

    const setResult = await runCli(["auth", "set", "google", "--client-json", "client_secret_google.json", "--json"], {
      cwd: projectDir,
    });
    assert.equal(setResult.code, 0, setResult.stderr);
    assert.doesNotMatch(setResult.stdout, /json-client-secret/);
    assert.deepEqual(JSON.parse(setResult.stdout), {
      ok: true,
      data: {
        mode: "google",
        providers: {
          anonymous: {
            enabled: true,
          },
          google: {
            enabled: true,
            configured: true,
            clientIdEnv: "GOOGLE_CLIENT_ID",
            clientSecretEnv: "GOOGLE_CLIENT_SECRET",
          },
        },
        google: {
          configured: true,
          clientIdEnv: "GOOGLE_CLIENT_ID",
          clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        },
      },
      error: null,
    });

    const envFile = await readFile(path.join(projectDir, ".env.sporades.server"), "utf8");
    assert.match(envFile, /^GOOGLE_CLIENT_ID=json-client-id\.apps\.googleusercontent\.com$/m);
    assert.match(envFile, /^GOOGLE_CLIENT_SECRET=json-client-secret$/m);
  });
});

test("sporades auth set google rejects invalid OAuth client JSON files", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    await writeFile(path.join(projectDir, "client_secret_google.json"), `${JSON.stringify({ web: { client_id: "only-id" } })}\n`);

    const result = await runCli(["auth", "set", "google", "--client-json", "client_secret_google.json", "--json"], {
      cwd: projectDir,
    });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "OAuth client JSON is missing Google client credentials.",
        hint: "Use a Google OAuth Web application JSON file containing `web.client_id` and `web.client_secret`.",
      },
    });
  });
});
