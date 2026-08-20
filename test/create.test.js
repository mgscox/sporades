import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { transform } from "esbuild";
import { parseServerEnv } from "../dist/bundle-pipeline.js";

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
    ["auth", /^Usage: sporades auth <command> \[options\]/, /set <provider>/],
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
    assert.equal(config.client.toolchain, "esbuild");
    assert.equal(config.auth.mode, "anonymous");
    assert.deepEqual(config.payments, { stripe: { enabled: false } });

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    assert.match(serverEntry, /capsule\(/);
    assert.match(serverEntry, /schema: paymentSchema/);
    assert.match(serverEntry, /queries: paymentQueries/);
    assert.match(serverEntry, /mutations: paymentMutations/);
    assert.match(serverEntry, /jobs: paymentJobs/);
    assert.doesNotMatch(serverEntry, /todos|auth|files|messages/);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /createRoot/);
    assert.match(clientEntry, /Blank Sporades Capsule/);
    assert.doesNotMatch(clientEntry, /createHooks|useQuery|useMutation|useAuth|files|messages|todo/i);
    assert.match(await readFile(path.join(projectDir, "index.html"), "utf8"), /src="\/client\.js"/);

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
    assert.deepEqual(packageJson.allowScripts, {
      esbuild: true,
      fsevents: true,
    });
  });
});

test("sporades create writes the dormant built-in Stripe foundation into every blank Capsule", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "payments-island", "--template", "blank", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);

    const projectDir = path.join(dir, "payments-island");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.deepEqual(config.payments, { stripe: { enabled: false } });

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    const payments = await readFile(path.join(projectDir, "server", "payments.ts"), "utf8");
    const paymentClient = await readFile(path.join(projectDir, "client", "payments.ts"), "utf8");
    const shared = await readFile(path.join(projectDir, "shared", "payments.ts"), "utf8");
    const readme = await readFile(path.join(projectDir, "README.md"), "utf8");
    const agents = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));

    assert.match(serverEntry, /jobs:\s*paymentJobs/);
    assert.match(serverEntry, /queries:\s*paymentQueries/);
    assert.match(serverEntry, /stripeEvents:\s*paymentStripeEvents/);
    assert.match(payments, /stripeEvent/);
    assert.match(payments, /paymentStripeEvents\s*=\s*stripeEvent/);
    assert.match(payments, /switch\s*\(event\.type\)/);
    assert.match(payments, /default:[\s\S]{0,120}return/);
    assert.match(payments, /from "sporades\/server\/stripe"/);
    assert.match(payments, /createStripePaymentIntegration\(\{ enabled: false \}\)/);
    assert.match(payments, /stripePrices[^=]*=\s*Object\.freeze\(\{\}\)/);
    assert.match(payments, /type CheckoutMode = "payment" \| "subscription"/);
    assert.match(payments, /mode: product\.mode/);
    assert.match(payments, /mode: Text\(\)/);
    assert.match(payments, /stripeCheckout/);
    assert.match(payments, /stripeCustomerPortal/);
    assert.match(payments, /startStripeCheckout/);
    assert.match(payments, /startStripeCustomerPortal/);
    assert.match(payments, /requireAuth\(ctx, \{ linked: true \}\)/);
    assert.match(payments, /authorizeStripeCheckout/);
    assert.match(payments, /authorizeStripeCustomerPortal/);
    assert.match(payments, /resolveStripeCustomerForPortal/);
    const portalMutation = payments.slice(payments.indexOf("startStripeCustomerPortal"), payments.indexOf("function validateCheckoutInput"));
    assert(portalMutation.indexOf("authorizeStripeCustomerPortal(ctx, input)") < portalMutation.indexOf("!ctx.payments?.stripe.enabled"));
    assert.match(payments, /return false/);
    assert.match(payments, /\.acl\(/);
    assert.match(payments, /row\?\.ownerId === ctx\.auth\.userId/);
    assert.match(payments, /insertOrIgnore/);
    assert.match(payments, /ctx\.jobs\.enqueue\("stripeCheckout"/);
    assert.match(payments, /ctx\.jobs\.enqueue\("stripeCustomerPortal"/);
    assert.match(payments, /stripeCustomerPortal:[\s\S]+requireAuth\(ctx, \{ linked: true \}\)[\s\S]+authorizeStripeCustomerPortal\(ctx, policyInput\)[\s\S]+resolveStripeCustomerForPortal\(ctx, policyInput\)[\s\S]+createCustomerPortalSession/);
    assert.doesNotMatch(payments, /portalIntents: table\([^)]*status:/);
    const portalEnqueue = payments.match(/ctx\.jobs\.enqueue\("stripeCustomerPortal", \{[\s\S]*?\}, \{ idempotencyKey/)?.[0] ?? "";
    assert.doesNotMatch(portalEnqueue, /customerId/);
    assert.match(payments, /returnPath: "\/account\/billing"/);
    assert.match(payments, /sporades:[^:]+:stripe:portal:/);
    assert.match(payments, /idempotencyKey/);
    assert.match(payments, /ctx\.jobs\.get\(jobId\)/);
    assert.match(shared, /export type PaymentJobState/);
    assert.match(paymentClient, /status: "pending"/);
    assert.match(paymentClient, /status: "succeeded"/);
    assert.match(paymentClient, /status: "failed"/);
    assert.match(paymentClient, /startStripeCustomerPortal/);
    assert.match(paymentClient, /billing\.stripe\.com/);
    assert.equal(paymentClient.includes("\\/p\\/session\\/"), true);
    assert.match(paymentClient, /CheckoutInput = Readonly<\{ intentId: string; productKey: string; quantity: number \}>/);
    assert.doesNotMatch(paymentClient, /CheckoutInput[^;]+(?:priceId|customerId|mode|metadata|idempotencyKey|successPath|cancelPath)/);
    assert.doesNotMatch(paymentClient, /PortalInput[^;]+(?:customerId|returnPath|idempotencyKey)/);
    assert.match(paymentClient, /checkout\.stripe\.com/);
    assert.match(paymentClient, /\/c\/pay\//);
    assert.match(paymentClient, /\/pay\//);
    assert.match(paymentClient, /window\.location\.assign/);
    assert.match(readme, /payments\.stripe\.enabled/);
    assert.match(readme, /Sealed Server env/);
    assert.match(readme, /Anonymous Checkout requires an explicit Capsule opt-in/);
    assert.match(readme, /client\/payments\.ts/);
    assert.match(readme, /one-time[\s\S]{0,100}subscription/i);
    assert.match(readme, /verified events[\s\S]{0,100}Capsule policy/i);
    assert.match(readme, /exact signed bytes[\s\S]{0,160}idempotent Privileged Job/i);
    assert.match(readme, /admission performs no Capsule billing consequence/i);
    assert.match(readme, /Stripe event policy[\s\S]{0,80}server\/payments\.ts/i);
    assert.match(readme, /idempotent[\s\S]{0,120}order-independent/i);
    assert.match(readme, /raw provider value[\s\S]{0,160}(?:log|persist)/i);
    assert.match(readme, /Customer Portal is the preferred surface/i);
    assert.match(readme, /Unknown, deleted, and unauthorized holders/);
    assert.match(agents, /Sporades owns Stripe transport/i);
    assert.match(agents, /Checkout begins provider billing[\s\S]{0,120}local[\s\S]{0,80}access/i);
    assert.match(agents, /enabled callback path is runtime-owned/i);
    assert.match(agents, /verified provider values as sensitive/i);
    assert.match(agents, /Never enqueue `_sporades\.stripe-event`/i);
    assert.match(agents, /paymentStripeEvents/);
    assert.match(agents, /later-arriving older event/i);
    assert.match(agents, /unknown event types/i);
    assert.match(agents, /authorizeStripeCustomerPortal/);
    assert.match(agents, /Capsule owns.*Prices.*Customers.*Teams.*billing authority.*entitlements.*retention.*export.*erasure/is);
    assert.equal(packageJson.dependencies.stripe, undefined);
    assert.doesNotMatch(payments, /subscriptions:\s*table|entitlements:\s*table|invoices:\s*table|seats:\s*table|orders:\s*table/);

    const generated = [serverEntry, payments, paymentClient, shared, readme, agents, await readFile(path.join(projectDir, ".env.sporades.server"), "utf8")].join("\n");
    assert.doesNotMatch(generated, /sk_(?:live|test)_|whsec_|price_[A-Za-z0-9]|cus_[A-Za-z0-9]|https:\/\/checkout\.stripe\.com/i);
  });
});

test("every supported blank framework receives the same dormant payment foundation", async () => {
  await withTempDir(async (dir) => {
    for (const framework of ["vanilla", "react", "preact", "inferno", "lit", "solid", "vue", "svelte"]) {
      const name = `payments-${framework}`;
      const result = await runCli(["create", name, "--template", "blank", "--framework", framework, "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(result.code, 0, `${framework}: ${result.stderr}`);
      const projectDir = path.join(dir, name);
      const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
      assert.deepEqual(config.payments, { stripe: { enabled: false } }, framework);
      assert.match(await readFile(path.join(projectDir, "server", "payments.ts"), "utf8"), /createStripePaymentIntegration/, framework);
      assert.match(await readFile(path.join(projectDir, "shared", "payments.ts"), "utf8"), /PaymentJobState/, framework);
      assert.match(await readFile(path.join(projectDir, "client", "payments.ts"), "utf8"), /startStripeCheckout/, framework);
      assert.match(await readFile(path.join(projectDir, "client", "payments.ts"), "utf8"), /startStripeCustomerPortal/, framework);
      assert.match(await readFile(path.join(projectDir, "server", "index.ts"), "utf8"), /paymentJobs/, framework);
    }
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
    assert.equal(config.payments, undefined);
    assert.equal(config.name, "todo-island");
    assert.equal(config.template, "todo");

    const serverEntry = await readFile(path.join(projectDir, "server", "index.ts"), "utf8");
    await assert.rejects(readFile(path.join(projectDir, "server", "payments.ts"), "utf8"), { code: "ENOENT" });
    assert.match(serverEntry, /todos: table\(/);
    assert.match(serverEntry, /String\(\)/);
    assert.match(serverEntry, /Boolean\(\)\.default\(false\)/);

    const clientEntry = await readFile(path.join(projectDir, "client", "index.tsx"), "utf8");
    assert.match(clientEntry, /createHooks/);
    assert.match(clientEntry, /useQuery\("todos"\)/);
    assert.match(clientEntry, /useMutation\("addTodo"\)/);
    assert.match(clientEntry, /Object\.entries\(session\.providers\)/);
    assert.match(clientEntry, /state\.enabled && state\.configured && state\.runtimeAvailable/);
    assert.match(clientEntry, /auth\.signIn\(provider\)/);
    assert.doesNotMatch(clientEntry, /providers\.google|auth\.signIn\("google"\)/);

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
    assert.match(clientEntry, /auth\.signIn\(provider\)/);
    assert.match(clientEntry, /auth\.signOut\(\)/);
    assert.match(clientEntry, /state\.enabled && state\.configured && state\.runtimeAvailable/);
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
    assert.match(client, /prepareFixtures\(musketeers\.filter/);
    assert.match(client, /if \(!isLocalDemoOrigin\(\)\) return/);
    assert.match(client, /musketeers\.filter\(\(person\) => !existing\.has\(person\.key\)\)/);
    assert.match(client, /fixturePreparationActive/);
    assert.match(client, /expectedGeneration !== activityRestoreGeneration/);
    assert.match(client, /preferences\.get\(\)/);
    assert.match(client, /preferences\.update\(\{ campfireShareActivity: enabled \}\)/);
    assert.match(client, /status: kind === "up" \? "liked" : "disliked"/);
    assert.match(client, /status: "posted"/);
    assert.match(client, /posted a message in/);
    assert.match(client, /Shares reading, typing, posting, likes, dislikes, and channel/);
  });
});

test("Campfire typing publication is throttled and renewed while input remains active", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "cadence-campfire", "--template", "campfire", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const source = await readFile(path.join(dir, "cadence-campfire", "client/journey-typing.ts"), "utf8");
    const compiled = await transform(source, { loader: "ts", format: "esm" });
    const { createTypingPublisher } = await import(`data:text/javascript,${encodeURIComponent(compiled.code)}`);
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
    const compiled = await transform(source, { loader: "ts", format: "esm" });
    const { retireJourneyConsent } = await import(`data:text/javascript,${encodeURIComponent(compiled.code)}`);
    const calls = [];
    await retireJourneyConsent({
      typingPublisher: { dispose: () => calls.push("dispose") },
      journey: { disable: async () => calls.push("disable") },
      setSharing: (value) => calls.push(`sharing:${value}`),
    });
    assert.deepEqual(calls, ["dispose", "disable", "sharing:false"]);
    assert.equal((client.match(/await retireJourneyConsent/g) ?? []).length, 3, "fixture preparation, its auth loop, and identity switching share retirement cleanup");
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
    assert.match(serverEntry, /ctx\.auth\.isGuest/);
    assert.match(serverEntry, /recordPhoto: mutation/);
    assert.match(serverEntry, /job, mutation, Number, query, schedule, String, table/);
    assert.match(serverEntry, /timestampPhotoNames: job/);
    assert.match(serverEntry, /expression: "\* \* \* \* \*"/);
    assert.match(serverEntry, /job: "timestampPhotoNames"/);
    assert.match(serverEntry, /toISOString\(\)\.slice\(11, 16\)/);
    assert.match(serverEntry, /ctx\.db\.photos\.update/);
    assert.match(serverEntry, /ctx\.auth\.isGuest \? true : globalThis\.Boolean\(input\.isPublic\)/);
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
    assert.match(clientEntry, /auth\.signIn\(provider\)/);
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
    assert.match(serverEntry, /schema: paymentSchema/);
    assert.match(serverEntry, /mutations: paymentMutations/);
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
    assert.equal(config.client.toolchain, "esbuild");

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

test("sporades create writes a runnable framework-neutral Vanilla TypeScript scaffold", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "vanilla-island", "--framework", "vanilla", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const projectDir = path.join(dir, "vanilla-island");
    const [config, packageJson, client, server, agents] = await Promise.all([
      readFile(path.join(projectDir, "sporades.json"), "utf8").then(JSON.parse),
      readFile(path.join(projectDir, "package.json"), "utf8").then(JSON.parse),
      readFile(path.join(projectDir, "client", "index.ts"), "utf8"),
      readFile(path.join(projectDir, "server", "index.ts"), "utf8"),
      readFile(path.join(projectDir, "AGENTS.md"), "utf8"),
    ]);
    assert.deepEqual(config.client, { framework: "vanilla", toolchain: "esbuild" });
    assert.deepEqual(packageJson.dependencies, {});
    assert.equal(packageJson.devDependencies.react, undefined);
    assert.equal(packageJson.devDependencies.preact, undefined);
    assert.match(client, /queries\.subscribe(?:<[^>]+>)?\(/);
    assert.match(client, /mutations\.run\(/);
    assert.match(client, /auth\.get\(\)/);
    assert.match(client, /auth\.subscribe\(/);
    assert.match(client, /preferences\.(get|update)\(/);
    assert.match(client, /files\.upload\(/);
    assert.match(client, /onMessage\(/);
    assert.match(client, /sendMessage\(/);
    assert.match(client, /journey\.(enable|subscribe)\(/);
    assert.match(client, /createElement\(/);
    assert.match(client, /textContent/);
    assert.match(client, /replaceChildren\(/);
    assert.doesNotMatch(client, /innerHTML|insertAdjacentHTML/);
    assert.doesNotMatch(client, /`<li>\$\{|\.map\([^\n]+<li>/);
    assert.doesNotMatch(client, /from ["'](?:react|preact)/);
    assert.match(server, /notes: query/);
    assert.match(server, /addNote: mutation/);
    assert.match(agents, /client\/index\.ts/);
    assert.match(agents, /framework-neutral/i);
    assert.doesNotMatch(agents, /useAuth\(\)/);
  });
});

test("sporades create explicitly scaffolds React with the Vite client toolchain", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "vite-island", "--framework", "react", "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(result.code, 0, result.stderr);
    const projectDir = path.join(dir, "vite-island");
    const [config, html, client, css, chunk, asset, packageJson] = await Promise.all([
      readFile(path.join(projectDir, "sporades.json"), "utf8").then(JSON.parse),
      readFile(path.join(projectDir, "index.html"), "utf8"),
      readFile(path.join(projectDir, "client", "index.tsx"), "utf8"),
      readFile(path.join(projectDir, "client", "styles.css"), "utf8"),
      readFile(path.join(projectDir, "client", "vite-scaffold.ts"), "utf8"),
      readFile(path.join(projectDir, "client", "sporades-mark.svg"), "utf8"),
      readFile(path.join(projectDir, "package.json"), "utf8").then(JSON.parse),
    ]);
    assert.deepEqual(config.client, { framework: "react", toolchain: "vite" });
    assert.match(html, /src="\/client\/index\.tsx"/);
    assert.doesNotMatch(html, /src="\/client\.js"/);
    assert.match(client, /import "\.\/styles\.css"/);
    assert.match(client, /import\("\.\/vite-scaffold"\)/);
    assert.match(css, /sporades-mark\.svg/);
    assert.match(chunk, /viteScaffoldLabel/);
    assert.match(asset, /<svg/);
    assert.equal(packageJson.dependencies.react, "^19.0.0");
    assert.equal(packageJson.dependencies["react-dom"], "^19.0.0");
    assert.equal(packageJson.devDependencies.vite, undefined, "Sporades owns the selected client toolchain");
  });
});

test("sporades create explicitly scaffolds Preact with the Vite client toolchain", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "preact-vite", "--framework", "preact", "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(result.code, 0, result.stderr);
    const projectDir = path.join(dir, "preact-vite");
    const [config, html, client, packageJson] = await Promise.all([
      readFile(path.join(projectDir, "sporades.json"), "utf8").then(JSON.parse),
      readFile(path.join(projectDir, "index.html"), "utf8"),
      readFile(path.join(projectDir, "client", "index.tsx"), "utf8"),
      readFile(path.join(projectDir, "package.json"), "utf8").then(JSON.parse),
    ]);
    assert.deepEqual(config.client, { framework: "preact", toolchain: "vite" });
    assert.match(html, /src="\/client\/index\.tsx"/);
    assert.match(client, /from "preact"/);
    assert.match(client, /import "\.\/styles\.css"/);
    assert.equal(packageJson.dependencies.preact, "^10.25.0");
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies["react-dom"], undefined);
  });
});

test("sporades create scaffolds an idiomatic Solid/Vite blank Capsule by default", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "solid-blank", "--framework", "solid", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const projectDir = path.join(dir, "solid-blank");
    const [config, html, entry, app, client, tsconfig, packageJson] = await Promise.all([
      readFile(path.join(projectDir, "sporades.json"), "utf8").then(JSON.parse),
      readFile(path.join(projectDir, "index.html"), "utf8"),
      readFile(path.join(projectDir, "client", "index.tsx"), "utf8"),
      readFile(path.join(projectDir, "client", "App.tsx"), "utf8"),
      readFile(path.join(projectDir, "client", "sporades.ts"), "utf8"),
      readFile(path.join(projectDir, "tsconfig.json"), "utf8").then(JSON.parse),
      readFile(path.join(projectDir, "package.json"), "utf8").then(JSON.parse),
    ]);
    assert.deepEqual(config.client, { framework: "solid", toolchain: "vite" });
    assert.match(html, /src="\/client\/index\.tsx"/);
    assert.match(entry, /render\(\(\) => <App \/>/);
    assert.match(entry, /import "\.\/styles\.css"/);
    assert.match(app, /createAuth\(\)/);
    assert.match(client, /createSolidPrimitives/);
    assert.equal(tsconfig.compilerOptions.jsx, "preserve");
    assert.equal(tsconfig.compilerOptions.jsxImportSource, "solid-js");
    assert.equal(tsconfig.compilerOptions.moduleResolution, "Bundler");
    assert.equal(tsconfig.compilerOptions.strict, true);
    assert.equal(packageJson.dependencies["solid-js"], "^1.9.0");
    assert.equal(packageJson.devDependencies["vite-plugin-solid"], "^2.11.0");
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies["react-dom"], undefined);
    assert.doesNotMatch(`${entry}\n${app}\n${client}`, /from "react|react-dom|createRoot/);
  });
});

test("sporades create admits every Lit/Vite template with project-owned Lit and structured toolchain boundaries", async () => {
  await withTempDir(async (dir) => {
    for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) {
      const result = await runCli(["create", `lit-${template}`, "--framework", "lit", "--template", template, "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const project = path.join(dir, `lit-${template}`);
      const [config, html, client, packageJson, tsconfig] = await Promise.all([
        readFile(path.join(project, "sporades.json"), "utf8").then(JSON.parse), readFile(path.join(project, "index.html"), "utf8"),
        readFile(path.join(project, "client", "index.ts"), "utf8"), readFile(path.join(project, "package.json"), "utf8").then(JSON.parse),
        readFile(path.join(project, "tsconfig.json"), "utf8").then(JSON.parse),
      ]);
      assert.deepEqual(config.client, { framework: "lit", toolchain: "vite" });
      assert.match(html, /<sporades-app><\/sporades-app>[\s\S]*src="\/client\/index\.ts"/);
      assert.match(client, /class SporadesApp extends LitElement/);
      assert.match(client, /createLitControllers/);
      assert.match(client, /static styles = css/);
      if (template === "todo") assert.match(client, /queryController<Todo\[]>[\s\S]*mutationController/);
      if (template === "guestbook") assert.match(client, /queryController<any\[]>\(this, "entries"\)[\s\S]*mutationController\(this, "sign"\)/);
      if (template === "photo-library") assert.match(client, /files\.upload[\s\S]*Make public/);
      if (template === "campfire") assert.match(client, /createTypingPublisher[\s\S]*ttlSeconds: 12/);
      assert.equal(packageJson.dependencies.lit, "^3.2.1");
      assert.equal(packageJson.devDependencies["@lit/reactive-element"], undefined);
      assert.equal(packageJson.dependencies.react, undefined);
      assert.equal(packageJson.dependencies["react-dom"], undefined);
      assert.equal(tsconfig.compilerOptions.experimentalDecorators, undefined);
      assert.doesNotMatch(`${html}\n${client}`, /from "react|react-dom|createRoot|cdn\.tailwindcss|components\/ui/);
    }
    const esbuild = await runCli(["create", "lit-esbuild", "--framework", "lit", "--toolchain", "esbuild", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.deepEqual(JSON.parse(esbuild.stdout).error, { message: "Unsupported client framework/toolchain combination: lit/esbuild", hint: "Use Lit with Vite." });
  });
});

test("sporades create admits native Inferno across both toolchains and every template", async () => {
  await withTempDir(async (dir) => {
    for (const toolchain of ["esbuild", "vite"]) for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) {
      const result = await runCli(["create", `inferno-${toolchain}-${template}`, "--framework", "inferno", "--toolchain", toolchain, "--template", template, "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const project = path.join(dir, `inferno-${toolchain}-${template}`);
      const [config, html, client, packageJson, tsconfig, readme, agents] = await Promise.all([
        readFile(path.join(project, "sporades.json"), "utf8").then(JSON.parse), readFile(path.join(project, "index.html"), "utf8"), readFile(path.join(project, "client/index.tsx"), "utf8"), readFile(path.join(project, "package.json"), "utf8").then(JSON.parse), readFile(path.join(project, "tsconfig.json"), "utf8").then(JSON.parse), readFile(path.join(project, "README.md"), "utf8"), readFile(path.join(project, "AGENTS.md"), "utf8"),
      ]);
      assert.deepEqual(config.client, { framework: "inferno", toolchain });
      assert.match(html, toolchain === "esbuild" ? /assets\/client\.css[\s\S]*src="\/client\.js"/ : /src="\/client\/index\.tsx"/);
      assert.match(client, /from "inferno"/); assert.match(client, /from "inferno-create-element"/); assert.match(client, /createInfernoAdapters/); assert.match(client, /componentDidMount[\s\S]*componentWillUnmount/);
      assert.equal(packageJson.dependencies.inferno, "^9.1.0"); assert.equal(packageJson.dependencies["inferno-create-element"], "^9.1.0"); assert.equal(packageJson.dependencies.react, undefined); assert.equal(packageJson.dependencies["react-dom"], undefined);
      assert.equal(tsconfig.compilerOptions.jsxFactory, "createElement"); assert.match(readme, /native Inferno class components/); assert.match(agents, /inferno/i); assert.doesNotMatch(`${client}\n${html}\n${readme}`, /from "react|react-dom|inferno-compat|cdn\.tailwindcss/i);
      if (template === "guestbook") assert.match(client, /mutationAdapter\(this,"sign"\)/);
      if (template === "photo-library") assert.match(client, /files\.upload/);
      if (template === "campfire") assert.match(client, /createTypingPublisher[\s\S]*journey\.enable[\s\S]*preferences\.update/);
    }
    const omitted = await runCli(["create", "inferno-default", "--framework", "inferno", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(omitted.code, 0); assert.deepEqual(JSON.parse(await readFile(path.join(dir, "inferno-default", "sporades.json"), "utf8")).client, { framework: "inferno", toolchain: "esbuild" });
  });
});

test("sporades create admits every Solid/Vite template and rejects the unsupported toolchain structurally", async () => {
  await withTempDir(async (dir) => {
    const todo = await runCli(["create", "solid-todo", "--framework", "solid", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(todo.code, 0, todo.stderr || todo.stdout);
    const app = await readFile(path.join(dir, "solid-todo", "client", "App.tsx"), "utf8");
    assert.match(app, /createQuery<[^>]+>\("todos"\)/);
    assert.match(app, /createMutation\("addTodo"\)/);
    assert.match(app, /onInput=/);
    assert.doesNotMatch(app, /createHooks|useState|useEffect|react-dom|from "react/);

    const esbuild = await runCli(["create", "solid-esbuild", "--framework", "solid", "--toolchain", "esbuild", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(esbuild.code, 1);
    assert.deepEqual(JSON.parse(esbuild.stdout).error, {
      message: "Unsupported client framework/toolchain combination: solid/esbuild",
      hint: "Use SolidJS with Vite.",
    });

    for (const [template, marker] of [["guestbook", /createMutation\("sign"\)/], ["photo-library", /files\.upload/], ["campfire", /createTypingPublisher/]]) {
      const richer = await runCli(["create", `solid-${template}`, "--framework", "solid", "--template", template, "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(richer.code, 0, richer.stderr || richer.stdout);
      const project = path.join(dir, `solid-${template}`);
      const [richerApp, html, readme, agents, files] = await Promise.all([
        readFile(path.join(project, "client", "App.tsx"), "utf8"), readFile(path.join(project, "index.html"), "utf8"),
        readFile(path.join(project, "README.md"), "utf8"), readFile(path.join(project, "AGENTS.md"), "utf8"), readdir(path.join(project, "client")),
      ]);
      assert.match(richerApp, marker);
      assert.match(readme, /SolidJS client/);
      assert.match(agents, /SolidJS|Solid/);
      assert.doesNotMatch(`${richerApp}\n${html}\n${files.join("\n")}`, /from "react|react-dom|cdn\.tailwindcss|components\/ui/);
    }
  });
});

test("sporades create scaffolds an idiomatic Vue/Vite blank Capsule by default", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "vue-blank", "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const projectDir = path.join(dir, "vue-blank");
    const [config, html, entry, app, client, packageJson] = await Promise.all([
      readFile(path.join(projectDir, "sporades.json"), "utf8").then(JSON.parse),
      readFile(path.join(projectDir, "index.html"), "utf8"),
      readFile(path.join(projectDir, "client", "index.ts"), "utf8"),
      readFile(path.join(projectDir, "client", "App.vue"), "utf8"),
      readFile(path.join(projectDir, "client", "sporades.ts"), "utf8"),
      readFile(path.join(projectDir, "package.json"), "utf8").then(JSON.parse),
    ]);
    assert.deepEqual(config.client, { framework: "vue", toolchain: "vite" });
    assert.match(html, /src="\/client\/index\.ts"/);
    assert.match(entry, /createApp\(App\)/);
    assert.match(app, /<script setup lang="ts">/);
    assert.match(app, /<template>/);
    assert.match(app, /<style scoped>/);
    assert.match(client, /createVueComposables/);
    assert.equal(packageJson.dependencies.vue, "^3.5.13");
    assert.equal(packageJson.devDependencies["@vitejs/plugin-vue"], "^5.2.4");
    assert.equal(packageJson.devDependencies["@vue/compiler-sfc"], "^3.5.13");
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies.preact, undefined);
  });
});

test("sporades create scaffolds the admitted Vue/Vite todo Capsule", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "vue-todo", "--template", "todo", "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const projectDir = path.join(dir, "vue-todo");
    const [server, app] = await Promise.all([
      readFile(path.join(projectDir, "server", "index.ts"), "utf8"),
      readFile(path.join(projectDir, "client", "App.vue"), "utf8"),
    ]);
    assert.match(server, /todos: table/);
    assert.match(app, /useQuery\("todos"\)/);
    assert.match(app, /useMutation\("addTodo"\)/);
    assert.match(app, /v-model="text"/);
    assert.match(app, /@submit\.prevent="submit"/);
    assert.doesNotMatch(app, /createHooks|react|preact/i);
  });
});

test("sporades create rejects unsupported Vue toolchains and admits every complete template", async () => {
  await withTempDir(async (dir) => {
    const esbuild = await runCli(["create", "vue-esbuild", "--framework", "vue", "--toolchain", "esbuild", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(esbuild.code, 1);
    assert.deepEqual(JSON.parse(esbuild.stdout).error, {
      message: "Unsupported client framework/toolchain combination: vue/esbuild",
      hint: "Use Vue with Vite.",
    });
    for (const template of ["guestbook", "photo-library", "campfire"]) {
      const result = await runCli(["create", `vue-${template}`, "--framework", "vue", "--template", template, "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(result.code, 0, `${template}: ${result.stderr || result.stdout}`);
      const project = path.join(dir, `vue-${template}`);
      const [config, app] = await Promise.all([
        readFile(path.join(project, "sporades.json"), "utf8").then(JSON.parse),
        readFile(path.join(project, "client", "App.vue"), "utf8"),
      ]);
      assert.deepEqual(config.client, { framework: "vue", toolchain: "vite" });
      assert.match(app, /<script setup lang="ts">/);
      assert.match(app, /<template>/);
      assert.match(app, /<style scoped>/);
      const agents = await readFile(path.join(project, "AGENTS.md"), "utf8");
      const readme = await readFile(path.join(project, "README.md"), "utf8");
      assert.match(agents, /client\/index\.ts.*Vue mount entrypoint/);
      assert.match(agents, /client\/App\.vue.*Vue Single-File Component UI/);
      assert.match(readme, /native Vue Single-File Component in `client\/App\.vue`/);
      assert.doesNotMatch(app, /createHooks|react-dom|preact\/hooks/);
      assert.equal((await readdir(path.join(project, "client"), { recursive: true })).some((file) => String(file).endsWith(".tsx")), false);
      if (template === "guestbook") {
        assert.match(app, /useQuery\("entries"\)/);
        assert.match(app, /useMutation\("sign"\)/);
        assert.match(app, /auth\.signIn\(provider\)/);
        assert.match(app, /authorPicture/);
      } else if (template === "photo-library") {
        assert.match(app, /files\.upload\(selectedFile\.value\)/);
        assert.match(app, /shouldPublish \? await files\.publicUrl/);
        assert.match(app, /files\.revokePublicUrl/);
        assert.match(app, /Photo saved privately/);
      } else {
        assert.match(app, /journey\.enable/);
        assert.match(app, /journey\.disable/);
        assert.match(app, /journey\.subscribe/);
        assert.match(app, /preferences\.get/);
        assert.match(app, /preferences\.update/);
        assert.match(app, /retireOwnedActivity/);
        assert.match(app, /createTypingPublisher/);
        assert.doesNotMatch(await readFile(path.join(project, "index.html"), "utf8"), /tailwindcss/);
        assert.doesNotMatch(readme, /Tailwind is loaded|Shadcn/i);
      }
    }
  });
});

test("sporades create admits the complete Svelte Vite template set while rejecting esbuild", async () => {
  await withTempDir(async (dir) => {
    for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) {
      const result = await runCli(["create", `svelte-${template}`, "--framework", "svelte", "--template", template, "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(result.code, 0, `${template}: ${result.stderr || result.stdout}`);
      const project = path.join(dir, `svelte-${template}`);
      const [config, html, entry, app, client, agents, readme, packageJson] = await Promise.all([
        readFile(path.join(project, "sporades.json"), "utf8").then(JSON.parse),
        readFile(path.join(project, "index.html"), "utf8"),
        readFile(path.join(project, "client", "index.ts"), "utf8"),
        readFile(path.join(project, "client", "App.svelte"), "utf8"),
        readFile(path.join(project, "client", "sporades.ts"), "utf8"),
        readFile(path.join(project, "AGENTS.md"), "utf8"),
        readFile(path.join(project, "README.md"), "utf8"),
        readFile(path.join(project, "package.json"), "utf8").then(JSON.parse),
      ]);
      assert.deepEqual(config.client, { framework: "svelte", toolchain: "vite" });
      assert.match(html, /src="\/client\/index\.ts"/);
      assert.match(entry, /mount\(App/);
      assert.match(app, /<script lang="ts">/);
      assert.match(app, /<style>/);
      assert.match(client, /createSvelteStores/);
      assert.match(agents, /client\/App\.svelte.*Svelte component UI/);
      assert.match(readme, /native component in `client\/App\.svelte`/);
      assert.equal(packageJson.dependencies.svelte, "^5.0.0");
      assert.equal(packageJson.devDependencies["@sveltejs/vite-plugin-svelte"], "^5.1.1");
      assert.equal(packageJson.dependencies.react, undefined);
      assert.equal(packageJson.dependencies.vue, undefined);
      assert.equal((await readdir(path.join(project, "client"), { recursive: true })).some((file) => String(file).endsWith(".tsx")), false);
      assert.doesNotMatch(app, /\$[A-Za-z][A-Za-z0-9]*\.run\(/);
      if (template === "guestbook") {
        assert.match(app, /queryStore\("entries"\).*mutationStore\("sign"\)/s);
        assert.match(app, /sign\.run\(message\)/);
      }
      if (template === "photo-library") {
        assert.match(app, /files\.upload.*files\.publicUrl.*files\.revokePublicUrl/s);
        assert.match(app, /recordPhoto\.run\(/);
        for (const mutation of ["updatePhotoIsPublic", "updatePhotoImageUrl", "updatePhotoPublicUrlId"]) assert.match(app, new RegExp(`requireMutation\\(${mutation},`));
      }
      if (template === "campfire") {
        assert.match(app, /preferences\.get.*preferences\.update/s);
        assert.match(app, /journey\.enable/);
        assert.match(app, /journey\.set/);
        assert.match(app, /journey\.disable/);
        assert.match(app, /seedCampfire.*registerFixture/s);
        for (const mutation of ["sendMessage", "toggleReaction", "seedCampfire", "registerFixture"]) assert.match(app, new RegExp(`${mutation}\\.run\\(`));
        assert.doesNotMatch(html, /tailwindcss/);
      }
    }
    const esbuild = await runCli(["create", "svelte-esbuild", "--framework", "svelte", "--toolchain", "esbuild", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(esbuild.code, 1);
    assert.deepEqual(JSON.parse(esbuild.stdout).error, {
      message: "Unsupported client framework/toolchain combination: svelte/esbuild",
      hint: "Use Svelte with Vite.",
    });
  });
});

test("sporades create keeps Vanilla TypeScript on esbuild", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["create", "vanilla-vite", "--framework", "vanilla", "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout).error, {
      message: "Unsupported client framework/toolchain combination: vanilla/vite",
      hint: "Use React or Preact with Vite, or keep Vanilla TypeScript on esbuild.",
    });
  });
});

test("the Vanilla scaffold renders persisted text and runtime errors as inert DOM text", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["create", "safe-vanilla", "--framework", "vanilla", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const source = await readFile(path.join(dir, "safe-vanilla", "client", "index.ts"), "utf8");
    const maliciousNote = '<img src=x onerror="globalThis.pwned=true">';
    const maliciousError = '<svg onload="globalThis.pwned=true">failed</svg>';
    const createdElements = [];
    let queryListener;

    class FakeElement {
      constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.listeners = new Map();
        this._textContent = "";
        this.value = "";
        this.files = [];
      }
      set textContent(value) { this._textContent = String(value); this.children = []; }
      get textContent() { return this._textContent || this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
      set innerHTML(_value) { throw new Error("The Vanilla scaffold must not use HTML parsing."); }
      append(...children) { this.children.push(...children); }
      replaceChildren(...children) { this.children = children; this._textContent = ""; }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      reset() {}
    }

    const app = new FakeElement("div");
    globalThis.document = {
      querySelector(selector) { assert.equal(selector, "#app"); return app; },
      createElement(tagName) { const node = new FakeElement(tagName); createdElements.push(node); return node; },
    };
    globalThis.window = { addEventListener() {} };
    globalThis.__vanillaSdk = {
      queries: { subscribe(_name, listener) { queryListener = listener; listener({ data: [{ id: "unsafe", text: maliciousNote }], error: null, loading: false }); return { unsubscribe() {} }; } },
      mutations: { run: async () => ({ data: null, error: null }) },
      auth: {
        get: async () => ({ data: null, error: { message: maliciousError } }),
        subscribe(listener) { listener({ auth: null, providers: {}, loading: false, error: null }); return { unsubscribe() {} }; },
      },
      preferences: { get: async () => ({ data: { preferences: {} }, error: null }), update: async () => ({ data: null, error: null }) },
      files: { upload: async () => ({ name: "file" }) },
      onMessage: () => ({ unsubscribe() {} }),
      sendMessage() {},
      journey: { subscribe: () => ({ unsubscribe() {} }), enable: async () => ({ data: null, error: null }), set: async () => ({ data: null, error: null }), disable() {} },
    };
    try {
      const executableSource = source
        .replace(/import \{([^}]+)\} from "sporades\/client";/, "const {$1} = globalThis.__vanillaSdk;")
        .replace(/^import type .*;\n/m, "");
      const compiled = await transform(executableSource, { loader: "ts", format: "esm", target: "es2022" });
      await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}#${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const list = createdElements.find((node) => node.tagName === "ul");
      const status = createdElements.find((node) => node.tagName === "pre");
      assert.equal(list.children.length, 1);
      assert.equal(list.children[0].tagName, "li");
      assert.equal(list.children[0].textContent, maliciousNote);
      assert.equal(status.textContent, maliciousError);
      assert.equal(createdElements.some((node) => node.tagName === "img" || node.tagName === "svg"), false);
      assert.equal(globalThis.pwned, undefined);

      queryListener({ data: null, error: { message: maliciousError }, loading: false });
      assert.equal(list.children[0].textContent, maliciousError);
      assert.equal(createdElements.some((node) => node.tagName === "img" || node.tagName === "svg"), false);
    } finally {
      delete globalThis.document;
      delete globalThis.window;
      delete globalThis.__vanillaSdk;
      delete globalThis.pwned;
    }
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
    assert.match(clientEntry, /auth\.signIn\(provider\)/);
    assert.match(clientEntry, /auth\.signOut\(\)/);
    assert.match(clientEntry, /state\.enabled && state\.configured && state\.runtimeAvailable/);
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
    assert.match(clientEntry, /auth\.signIn\(provider\)/);
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
        hint: "Use one of: react, preact, inferno, lit, solid, vue, svelte, vanilla.",
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

test("sporades create accepts a local template directory without copying ignored or secret state", async () => {
  await withTempDir(async (dir) => {
    const templateDir = path.join(dir, "template");
    await mkdir(templateDir, { recursive: true });
    await mkdir(path.join(templateDir, "client"), { recursive: true });
    await mkdir(path.join(templateDir, "node_modules", "ignored"), { recursive: true });
    await mkdir(path.join(templateDir, ".sporades"), { recursive: true });
    await writeFile(path.join(templateDir, ".gitignore"), "node_modules/\n.sporades/\n.env*.local\n");
    await writeFile(path.join(templateDir, ".env.sporades.server"), "SECRET=must-not-copy\n");
    await writeFile(path.join(templateDir, ".env.test.local"), "LOCAL=must-not-copy\n");
    await writeFile(path.join(templateDir, "node_modules", "ignored", "index.js"), "ignored\n");
    await writeFile(path.join(templateDir, ".sporades", "binding.json"), "{}\n");
    await writeFile(path.join(templateDir, "client", "index.tsx"), "export {};\n");
    await writeFile(path.join(templateDir, "package.json"), JSON.stringify({
      name: "daily-build-template",
      private: true,
      type: "module",
      scripts: { test: "node --test", "custom:check": "node custom.mjs" },
      dependencies: { react: "^19.0.0" },
      devDependencies: { sporades: "0.1.0", typescript: "^5.8.0" },
      allowScripts: {
        "custom-native-addon": true,
        "esbuild@0.25.12": false,
        "fsevents@2.3.3": true,
      },
    }, null, 2));
    await writeFile(path.join(templateDir, "sporades.json"), JSON.stringify({
      name: "daily-build-template",
      template: "blank",
      client: { framework: "react", toolchain: "vite" },
    }, null, 2));

    const result = await runCli([
      "create",
      "local-island",
      "--template",
      templateDir,
      "--no-install",
      "--no-git",
      "--json",
    ], { cwd: dir });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { path: await realpath(path.join(dir, "local-island")), template: templateDir },
      error: null,
    });

    const projectDir = path.join(dir, "local-island");
    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.equal(packageJson.name, "local-island");
    assert.equal(packageJson.dependencies.react, "^19.0.0");
    assert.equal(packageJson.devDependencies.typescript, "^5.8.0");
    assert.equal(packageJson.devDependencies.sporades, expectedSporadesVersionRange);
    assert.equal(packageJson.scripts.test, "node --test");
    assert.equal(packageJson.scripts.dev, "sporades dev");
    assert.equal(packageJson.scripts["custom:check"], "node custom.mjs");
    assert.deepEqual(packageJson.allowScripts, {
      "custom-native-addon": true,
      esbuild: true,
      fsevents: true,
    });
    assert.equal(config.name, "local-island");
    assert.equal(await readFile(path.join(projectDir, "client", "index.tsx"), "utf8"), "export {};\n");
    await assert.rejects(readFile(path.join(projectDir, ".env.sporades.server"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(projectDir, ".env.test.local"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(projectDir, "node_modules", "ignored", "index.js"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"), /ENOENT/);
  });
});

test("sporades create applies root-anchored local-template ignore rules only at the template root", async () => {
  await withTempDir(async (dir) => {
    const templateDir = path.join(dir, "template");
    await mkdir(path.join(templateDir, "fixtures"), { recursive: true });
    await mkdir(path.join(templateDir, "client", "fixtures"), { recursive: true });
    await writeFile(path.join(templateDir, ".gitignore"), "/fixtures\n");
    await writeFile(path.join(templateDir, "fixtures", "root.ts"), "export const root = true;\n");
    await writeFile(path.join(templateDir, "client", "fixtures", "nested.ts"), "export const nested = true;\n");
    await writeFile(path.join(templateDir, "package.json"), JSON.stringify({
      name: "anchored-template",
      private: true,
      type: "module",
      dependencies: { react: "^19.0.0" },
    }, null, 2));
    await writeFile(path.join(templateDir, "sporades.json"), JSON.stringify({
      name: "anchored-template",
      template: "blank",
      client: { framework: "react", toolchain: "vite" },
    }, null, 2));

    const result = await runCli([
      "create",
      "anchored-island",
      "--template",
      templateDir,
      "--no-install",
      "--no-git",
    ], { cwd: dir });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const projectDir = path.join(dir, "anchored-island");
    await assert.rejects(readFile(path.join(projectDir, "fixtures", "root.ts"), "utf8"), /ENOENT/);
    assert.equal(
      await readFile(path.join(projectDir, "client", "fixtures", "nested.ts"), "utf8"),
      "export const nested = true;\n",
    );
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
    const anonymousData = JSON.parse(anonymousStatus.stdout).data;
    assert.equal(anonymousData.mode, "anonymous");
    assert.deepEqual(anonymousData.providers.anonymous, { enabled: true, configured: true, runtimeAvailable: true });
    assert.equal(anonymousData.providers.google.configured, false);
    assert.deepEqual(Object.keys(anonymousData.providers), ["anonymous", "email", "google", "microsoft", "apple", "facebook"]);

    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "google-client-id", "--client-secret", "super-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);
    assert.doesNotMatch(setResult.stdout, /super-secret/);
    const setData = JSON.parse(setResult.stdout).data;
    assert.equal(setData.mode, "google");
    assert.equal(setData.providers.anonymous.enabled, true);
    assert.equal(setData.providers.google.configured, true);
    assert.equal(setData.providers.google.runtimeAvailable, true);

    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.deepEqual(config.auth.providers, {
      anonymous: { enabled: true },
      google: {
        enabled: true,
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
    const data = JSON.parse(status.stdout).data;
    assert.equal(data.mode, "google");
    assert.deepEqual(data.providers.email, { enabled: true, configured: true, runtimeAvailable: true });
    assert.equal(data.providers.google.configured, true);
    assert.equal(data.providers.microsoft.enabled, false);
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
    const data = JSON.parse(setResult.stdout).data;
    assert.equal(data.mode, "google");
    assert.equal(data.providers.google.configured, true);
    assert.equal(data.providers.google.runtimeAvailable, true);

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

test("sporades auth set rejects malformed provider credential documents without leaking runtime type errors", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "oauth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "oauth-island");
    const cases = [
      ["google", null, "Google"],
      ["google", [], "Google"],
      ["google", { web: "not-an-object" }, "Google"],
      ["google", { web: { client_id: 42, client_secret: "secret" } }, "Google"],
      ["microsoft", { clientId: "id", clientSecret: 42 }, "Microsoft"],
      ["apple", { servicesId: "id", teamId: "team", keyId: "key", privateKey: ["secret"] }, "Apple"],
      ["facebook", { appId: "id", appSecret: "secret", graphVersion: 23 }, "Facebook"],
    ];

    for (const [provider, document, label] of cases) {
      const filename = `${provider}-invalid.json`;
      await writeFile(path.join(projectDir, filename), JSON.stringify(document));
      const result = await runCli(["auth", "set", provider, "--client-json", filename, "--json"], { cwd: projectDir });
      assert.equal(result.code, 1, `${provider}: ${result.stdout || result.stderr}`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, false);
      assert.match(payload.error.message, new RegExp(`OAuth client JSON is missing ${label} .*credentials\\.$`));
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /TypeError|Cannot read|Cannot convert|42/);
    }
  });
});

test("sporades auth set merges OAuth providers, supports explicit disablement, and redacts every secret", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "oauth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "oauth-island");

    const google = await runCli(
      ["auth", "set", "google", "--client-id", "google-id", "--client-secret", "google-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(google.code, 0, google.stderr);
    const microsoft = await runCli(
      ["auth", "set", "microsoft", "--client-id", "microsoft-id", "--client-secret", "microsoft-secret", "--tenant", "organizations", "--json"],
      { cwd: projectDir },
    );
    assert.equal(microsoft.code, 0, microsoft.stdout || microsoft.stderr);
    const disabled = await runCli(["auth", "set", "microsoft", "--disable", "--json"], { cwd: projectDir });
    assert.equal(disabled.code, 0, disabled.stderr);

    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    assert.deepEqual(config.auth.providers, {
      anonymous: { enabled: true },
      google: {
        enabled: true,
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      },
      microsoft: {
        enabled: false,
        clientIdEnv: "MICROSOFT_CLIENT_ID",
        clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
        tenant: "organizations",
      },
    });
    assert.doesNotMatch(JSON.stringify(config), /google-secret|microsoft-secret/);
    const env = await readFile(path.join(projectDir, ".env.sporades.server"), "utf8");
    assert.match(env, /^GOOGLE_CLIENT_SECRET=google-secret$/m);
    assert.match(env, /^MICROSOFT_CLIENT_SECRET=microsoft-secret$/m);

    const data = JSON.parse(disabled.stdout).data;
    assert.equal(data.providers.anonymous.enabled, true);
    assert.equal(data.providers.google.configured, true);
    assert.equal(data.providers.google.runtimeAvailable, true);
    assert.equal(data.providers.microsoft.enabled, false);
    assert.equal(data.providers.microsoft.configured, true);
    assert.equal(data.providers.microsoft.runtimeAvailable, true);
    assert.doesNotMatch(disabled.stdout, /google-secret|microsoft-secret|google-id|microsoft-id/);
  });
});

test("sporades auth set parses provider-specific credential files and reports all providers without live OAuth calls", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "oauth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "oauth-island");
    await writeFile(path.join(projectDir, "microsoft.json"), JSON.stringify({
      clientId: "ms-id",
      clientSecret: "ms-secret",
      tenant: "common",
    }));
    const applePrivateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg",
      "line-with-backslash-\\\\-and-quote-\"",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n");
    await writeFile(path.join(projectDir, "apple.json"), JSON.stringify({
      servicesId: "com.example.web",
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: applePrivateKey,
    }));
    await writeFile(path.join(projectDir, "facebook.json"), JSON.stringify({
      appId: "facebook-id",
      appSecret: "facebook-secret",
      graphVersion: "v23.0",
    }));

    for (const [provider, file] of [["microsoft", "microsoft.json"], ["apple", "apple.json"], ["facebook", "facebook.json"]]) {
      const result = await runCli(["auth", "set", provider, "--client-json", file, "--json"], { cwd: projectDir });
      assert.equal(result.code, 0, `${provider}: ${result.stdout || result.stderr}`);
      assert.doesNotMatch(result.stdout, /ms-secret|apple-private-key|facebook-secret/);
    }
    const email = await runCli(["auth", "set", "email", "--json"], { cwd: projectDir });
    assert.equal(email.code, 0, email.stderr);

    const statusResult = await runCli(["auth", "status", "--json"], { cwd: projectDir });
    assert.equal(statusResult.code, 0, statusResult.stderr);
    const status = JSON.parse(statusResult.stdout).data;
    assert.deepEqual(Object.keys(status.providers), ["anonymous", "email", "google", "microsoft", "apple", "facebook"]);
    assert.equal(status.providers.email.configured, true);
    assert.equal(status.providers.email.runtimeAvailable, true);
    assert.equal(status.providers.microsoft.configured, true);
    assert.equal(status.providers.microsoft.runtimeAvailable, true);
    assert.equal(status.providers.apple.configured, true);
    assert.equal(status.providers.facebook.configured, true);
    assert.equal(status.providers.facebook.runtimeAvailable, true);
    assert.equal(status.providers.facebook.graphVersion, "v23.0");
    assert.equal(status.providers.apple.callbackPath, "/__sporades/auth/apple/callback");
    assert.equal(status.providers.apple.callbackUrl, null);
    assert.match(status.providers.apple.callbackGuidance, /HTTPS/i);
    assert.doesNotMatch(statusResult.stdout, /ms-secret|BEGIN PRIVATE KEY|facebook-secret|facebook-id|ms-id/);

    const envRaw = await readFile(path.join(projectDir, ".env.sporades.server"), "utf8");
    assert.doesNotMatch(envRaw, /^-----BEGIN PRIVATE KEY-----$/m);
    assert.equal(
      parseServerEnv({ exists: true, raw: envRaw }).APPLE_PRIVATE_KEY,
      applePrivateKey,
    );
  });
});

test("sporades auth set facebook defaults to and validates the supported Graph version", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "facebook-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "facebook-island");

    const configured = await runCli(
      ["auth", "set", "facebook", "--client-id", "facebook-id", "--client-secret", "facebook-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(configured.code, 0, configured.stdout || configured.stderr);
    const status = JSON.parse(configured.stdout).data.providers.facebook;
    assert.equal(status.graphVersion, "v23.0");
    assert.equal(status.configured, true);
    assert.equal(status.runtimeAvailable, true);
    assert.doesNotMatch(configured.stdout, /facebook-id|facebook-secret/);

    const unsupported = await runCli(
      ["auth", "set", "facebook", "--client-id", "new-id", "--client-secret", "new-secret", "--graph-version", "v99.0", "--json"],
      { cwd: projectDir },
    );
    assert.equal(unsupported.code, 1);
    assert.deepEqual(JSON.parse(unsupported.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unsupported Facebook Graph API version.",
        hint: "Use `--graph-version v23.0`.",
        diagnostics: { graphVersion: "v99.0" },
      },
    });
    assert.doesNotMatch(`${unsupported.stdout}${unsupported.stderr}`, /new-secret/);
  });
});

test("sporades auth set microsoft accepts bounded tenant selections and rejects path-like tenant input before writing", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "tenant-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "tenant-island");
    const selections = [
      "common",
      "organizations",
      "consumers",
      "11111111-2222-3333-4444-555555555555",
      "contoso.onmicrosoft.com",
    ];
    for (const tenant of selections) {
      const result = await runCli([
        "auth", "set", "microsoft",
        "--client-id", "microsoft-id",
        "--client-secret", "microsoft-secret",
        "--tenant", tenant,
        "--json",
      ], { cwd: projectDir });
      assert.equal(result.code, 0, `${tenant}: ${result.stdout || result.stderr}`);
      assert.equal(JSON.parse(result.stdout).data.providers.microsoft.tenant, tenant);
      assert.doesNotMatch(result.stdout, /microsoft-secret/);
    }
    const configPath = path.join(projectDir, "sporades.json");
    const envPath = path.join(projectDir, ".env.sporades.server");
    const configBefore = await readFile(configPath, "utf8");
    const envBefore = await readFile(envPath, "utf8");
    const invalid = await runCli([
      "auth", "set", "microsoft",
      "--client-id", "replacement-id",
      "--client-secret", "replacement-secret",
      "--tenant", "../common",
      "--json",
    ], { cwd: projectDir });
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stdout, /Invalid Microsoft tenant/);
    assert.doesNotMatch(invalid.stdout, /replacement-secret/);
    assert.equal(await readFile(configPath, "utf8"), configBefore);
    assert.equal(await readFile(envPath, "utf8"), envBefore);
  });
});

test("sporades auth set leaves config and env exact when transaction staging fails", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "oauth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "oauth-island");
    const google = await runCli(
      ["auth", "set", "google", "--client-id", "google-id", "--client-secret", "google-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(google.code, 0, google.stderr);

    const configPath = path.join(projectDir, "sporades.json");
    const envPath = path.join(projectDir, ".env.sporades.server");
    const configBefore = await readFile(configPath, "utf8");
    const envBefore = await readFile(envPath, "utf8");
    await writeFile(path.join(projectDir, "apple.json"), JSON.stringify({
      servicesId: "com.example.web",
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n",
    }));

    await chmod(projectDir, 0o555);
    try {
      const result = await runCli(["auth", "set", "apple", "--client-json", "apple.json", "--json"], { cwd: projectDir });
      assert.equal(result.code, 1, result.stdout || result.stderr);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret|apple\.json|sporades-create-/);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.error.message, "Unable to update OAuth configuration atomically.");
      assert.equal(payload.error.diagnostics.recovery, "complete");
    } finally {
      await chmod(projectDir, 0o755);
    }
    assert.equal(await readFile(configPath, "utf8"), configBefore);
    assert.equal(await readFile(envPath, "utf8"), envBefore);
    assert.deepEqual((await readdir(projectDir)).filter((name) => name.includes(".sporades-tx-")), []);
  });
});
