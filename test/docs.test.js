import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createMarkdownRenderer } from "vitepress";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readProjectFile(relativePath) {
  if (relativePath === "docs/user-guide.md") {
    const files = [
      "docs/user-guide.md",
      "docs/guide/projects.md",
      "docs/guide/server.md",
      "docs/guide/client.md",
      "docs/guide/auth.md",
      "docs/guide/files.md",
      "docs/guide/realtime.md",
      "docs/guide/background-work.md",
      "docs/guide/configuration.md",
      "docs/guide/local-operations.md",
      "docs/guide/hosting.md",
      "docs/guide/troubleshooting.md",
      "docs/guide/reference.md",
      "docs/reference/projects-and-configuration.md",
      "docs/reference/server-runtime.md",
      "docs/reference/jobs-and-schedules.md",
      "docs/reference/client-auth-and-preferences.md",
      "docs/reference/files-and-realtime.md",
      "docs/reference/operations-and-hosting.md",
    ];
    return (await Promise.all(files.map((file) => readFile(path.join(repoRoot, file), "utf8")))).join("\n");
  }
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-docs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extractShellBlockAfter(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `Expected heading ${heading}`);
  const afterHeading = markdown.slice(start);
  const matches = [...afterHeading.matchAll(/```sh\n([\s\S]*?)\n```/g)];
  const scriptBlock = matches.find((match) => match[1].startsWith("#!/usr/bin/env bash\n"));
  assert.ok(scriptBlock, `Expected executable shell block after ${heading}`);
  return scriptBlock[1];
}

test("documentation validation stays separate from the full regression suite", async () => {
  const [packageJson, workflow] = await Promise.all([
    readProjectFile("package.json").then(JSON.parse),
    readProjectFile(".github/workflows/deploy-docs.yml"),
  ]);

  assert.equal(
    packageJson.scripts["test:docs"],
    "node --test --test-concurrency=1 test/docs.test.js test/docs-llms.test.js",
  );
  assert.equal(packageJson.scripts["docs:check"], "npm run test:docs && npm run docs:build");
  assert.match(workflow, /- run: npm run docs:check/);
  assert.doesNotMatch(workflow, /- run: npm test(?:\s|$)/);
});

test("Registration Admission docs cover policy choice, atomicity, limits, OAuth custody, and recovery", async () => {
  const [guide, reference] = await Promise.all([
    readProjectFile("docs/guide/auth.md"),
    readProjectFile("docs/reference/client-auth-and-preferences.md"),
  ]);
  for (const contents of [guide, reference]) {
    assert.match(contents, /Registration Admission/i);
    assert.match(contents, /4 KiB/);
    assert.match(contents, /existing (?:identity|user)|already-linked identity/i);
    assert.match(contents, /REGISTRATION_DENIED/);
    assert.match(contents, /atomic|same (?:Auth )?transaction/i);
    assert.match(contents, /provider[\s\S]{0,160}Session[\s\S]{0,160}callback URI[\s\S]{0,160}nonce[\s\S]{0,160}expiry/i);
    assert.match(contents, /immutable/);
    assert.match(contents, /rotateOAuthRegistrationKey/);
    assert.match(contents, /retireOAuthRegistrationKeys/);
    assert.match(contents, /restore[\s\S]{0,160}(?:backup|database)/i);
    assert.match(contents, /benefit|advantage/i);
    assert.match(contents, /cost|tradeoff/i);
  }
  assert.match(reference, /auth\.signUp\("email", credentials, \{ registration: \{ admission: \{ invite \} \} \}\)/);
  assert.match(reference, /auth\.signIn\("google", undefined, \{ registration: \{ admission: \{ invite \} \} \}\)/);
  assert.doesNotMatch(reference, /auth\.(?:signUp|signIn)\([^\n]+, \{ admission:/);
});

async function runShell(scriptPath, options) {
  return new Promise((resolve) => {
    const child = spawn("bash", [scriptPath], {
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

test("the feature reference is split by lookup intent behind a compatible index", async () => {
  const [index, projects, server, jobs, client, realtime, operations] = await Promise.all([
    readProjectFile("docs/guide/reference.md"),
    readProjectFile("docs/reference/projects-and-configuration.md"),
    readProjectFile("docs/reference/server-runtime.md"),
    readProjectFile("docs/reference/jobs-and-schedules.md"),
    readProjectFile("docs/reference/client-auth-and-preferences.md"),
    readProjectFile("docs/reference/files-and-realtime.md"),
    readProjectFile("docs/reference/operations-and-hosting.md"),
  ]);
  const markdown = await createMarkdownRenderer(path.join(repoRoot, "docs"), { html: false });
  const renderedIndex = markdown.render(index);

  for (const legacyAnchor of [
    "create-a-capsule",
    "building-the-server-side",
    "current-user-jobs",
    "auth-workflows",
    "file-uploads",
    "hosted-capsules",
    "troubleshooting",
  ]) assert.match(renderedIndex, new RegExp(`id=["']${legacyAnchor}["']`));

  assert.match(projects, /authoritative client capability matrix/);
  assert.match(server, /invisible accept\/reject authorization policy/);
  assert.match(jobs, /Inspect Jobs from the CLI/);
  assert.match(client, /Configure Microsoft sign-in/);
  assert.match(realtime, /User Journey Tracker/);
  assert.match(realtime, /files\.accessKeys\.read/);
  assert.match(realtime, /never replace ownership\s+or File ACL checks/i);
  assert.match(operations, /Sporades Doctor/);
});

test("canonical endpoint docs preserve exact bounded request bytes without exposing mutable runtime storage", async () => {
  const [prd, server] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/reference/server-runtime.md"),
  ]);

  for (const document of [prd, server]) {
    assert.match(document, /bodyBytes/);
    assert.match(document, /exact[\s\S]*bytes/i);
    assert.match(document, /same bounded\s+request-body read/i);
    assert.match(document, /toUint8Array\(\)[\s\S]*copy/i);
    assert.match(document, /never automatically logged/i);
  }
});

test("the idempotent insert example awaits both asynchronous database paths", async () => {
  const [server, tableApi] = await Promise.all([
    readProjectFile("docs/reference/server-runtime.md"),
    readProjectFile("docs/api/types/server.TableApi.html"),
  ]);
  assert.match(
    server,
    /const inserted = await ctx\.db\.subscriptions\.insertOrIgnore\(\{ teamId, plan: "pro" \}, "teamId"\);/,
  );
  assert.match(
    server,
    /return inserted \?\? await ctx\.db\.subscriptions\.where\("teamId", teamId\)\.get\(\);/,
  );
  assert.match(
    tableApi,
    /id="insertorignore-1"[\s\S]*?MaybePromise[\s\S]*?Row[\s\S]*?null/,
  );
});

test("canonical database docs scope additive unique migration errors and rollback", async () => {
  const [prd, serverReference, roadmap] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/reference/server-runtime.md"),
    readProjectFile("docs/ROADMAP.md"),
  ]);

  for (const document of [prd, serverReference]) {
    assert.match(document, /add(?:ing|itive)[\s\S]*unique constraint/i);
    assert.match(document, /newly\s+added\s+constraint[\s\S]*row copy/i);
    assert.match(document, /foreign-key[\s\S]*unrelated\s+unique[\s\S]*(?:remain|retain)[\s\S]*(?:original|ordinary) error/i);
    assert.match(document, /original table[\s\S]*rows[\s\S]*schema metadata[\s\S]*hash/i);
    assert.match(document, /no temporary table[\s\S]*debris/i);
    assert.match(document, /temporary table name[\s\S]*(?:collide|collision)[\s\S]*valid app table[\s\S]*(?:preserv|untouched)/i);
  }
  assert.match(roadmap, /Capsule table uniqueness \| implemented/);
  assert.match(roadmap, /`insertOrIgnore`/);
  assert.match(roadmap, /SQLite, libSQL, and PostgreSQL/);
});

test("README documentation links resolve from the npm package page", async () => {
  const readme = await readProjectFile("README.md");
  assert.doesNotMatch(readme, /\]\(docs\/[A-Za-z0-9_./-]+\.md(?:#[^)]+)?\)/);
  for (const route of ["user-guide", "architecture", "runtime-layout", "server-installation", "PRD", "ROADMAP"]) {
    assert.match(readme, new RegExp(`https://mgscox\\.github\\.io/sporades/${route}`));
  }
  assert.match(readme, /https:\/\/mgscox\.github\.io\/sporades\/guide\/reference/);
  assert.match(readme, /https:\/\/mgscox\.github\.io\/sporades\/llms\.txt/);
});

test("Built-in Teams is discoverable without overstating its authorization model", async () => {
  const [changes, readme, userGuide, reference, nav] = await Promise.all([
    readProjectFile("CHANGES.md"),
    readProjectFile("README.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/reference/teams.md"),
    readProjectFile("docs/.vitepress/config.mts"),
  ]);

  assert.match(changes, /Built-in Teams[\s\S]*email-bound Join links[\s\S]*never sends Join-link email/);
  assert.match(changes, /https:\/\/mgscox\.github\.io\/sporades\/reference\/teams/);
  assert.match(readme, /Built-in collaboration[\s\S]*explicit Team ACL/);
  assert.match(readme, /https:\/\/mgscox\.github\.io\/sporades\/reference\/teams/);
  assert.match(userGuide, /Use Built-in Teams for explicit collaboration/);
  assert.match(reference, /never automatically partition Capsule data/);
  assert.match(nav, /\{ text: "Built-in Teams", link: "\/reference\/teams" \}/);
});

test("headless Team Billing docs preserve the platform-mechanics and app-rendering boundary", async () => {
  const [changes, readme, prd, context, reference, guide, convergenceAdr, managementAdr, serverTypes, clientTypes] = await Promise.all([
    readProjectFile("CHANGES.md"),
    readProjectFile("README.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("CONTEXT.md"),
    readProjectFile("docs/reference/teams.md"),
    readProjectFile("docs/guide/reference.md"),
    readProjectFile("docs/adr/0047-team-billing-truth-converges-inside-the-atomic-stripe-fence.md"),
    readProjectFile("docs/adr/0048-managed-team-billing-converges-from-durable-desired-state.md"),
    readProjectFile("src/types/server.d.ts"),
    readProjectFile("src/types/client.d.ts"),
  ]);
  for (const document of [changes, readme, prd, context, reference]) {
    assert.match(document, /headless Team Billing/i);
    assert.match(document, /provider[- ]free/i);
  }
  assert.match(reference, /Omit `teamBilling`[\s\S]*creates no Team Billing storage/i);
  assert.match(reference, /current linked Team administrator[\s\S]*transaction-bound read-only app tables/i);
  assert.match(reference, /Customer, Subscription, operation, observation, and replay correlation[\s\S]*runtime-owned storage/i);
  assert.match(reference, /does not render[\s\S]*product\s+copy/i);
  assert.match(reference, /teamBilling\.startCheckout[\s\S]*Apps create the button/i);
  assert.match(reference, /teamBilling\.openPortal[\s\S]*reviewed[\s\S]*configuration/i);
  assert.match(reference, /payment-method updates[\s\S]*invoice history[\s\S]*period end[\s\S]*quantity editing disabled/i);
  assert.match(reference, /mutable Dashboard default has\s+no effect/i);
  assert.match(reference, /Retries reuse identical provider parameters/i);
  assert.match(reference, /Verified[\s\S]*terminal[\s\S]*cannot revive the URL/i);
  assert.match(reference, /Checkout\s+completion[\s\S]*never establishes paid entitlement/i);
  assert.match(reference, /single\s+licensed item[\s\S]*declared Price[\s\S]*quantity[\s\S]*period[\s\S]*supported status/i);
  assert.match(reference, /cancellation outranks failed payment[\s\S]*provider Event identifiers are not[\s\S]*business ordering/i);
  assert.match(reference, /Deletion permanently latches[\s\S]*no delayed update can resurrect/i);
  assert.match(reference, /Malformed supported evidence[\s\S]*Raw Stripe JSON[\s\S]*never enter Team Billing tables/i);
  assert.match(reference, /privilegedCtx\.teamBilling\.listQuarantines[\s\S]*provider object and Event IDs[\s\S]*capped at 100/i);
  assert.match(reference, /opt-in atomic[\s\S]*same transaction[\s\S]*legacy `stripeEvent\(handler\)`[\s\S]*after the platform commit/i);
  assert.match(reference, /fixed quantity[\s\S]*accepted-Team-member[\s\S]*requestPlanTransition/i);
  assert.match(reference, /Price and quantity together[\s\S]*create_prorations[\s\S]*stable `proration_date`[\s\S]*pending_if_incomplete/i);
  assert.match(reference, /membership transaction[\s\S]*cannot roll that membership change back[\s\S]*per-Team lane/i);
  assert.match(reference, /acknowledgement[\s\S]*public state remains\s+pending[\s\S]*verified `customer\.subscription\.\*` evidence/i);
  assert.match(convergenceAdr, /Verified delivery is evidence, not billing truth/i);
  assert.match(convergenceAdr, /deleted Subscription ID is permanently terminal/i);
  assert.match(convergenceAdr, /Provider Event identifiers are replay identities, not a business\s+ordering rule/i);
  assert.match(managementAdr, /share one quantity policy[\s\S]*requestPlanTransition/i);
  assert.match(managementAdr, /membership transactions never wait for Stripe/i);
  assert.match(managementAdr, /durable per-Team claim[\s\S]*serializes them across independent SQLite, libSQL, and Postgres runtimes/i);
  assert.match(managementAdr, /Provider acknowledgement[\s\S]*awaiting observation[\s\S]*verified Subscription evidence/i);
  assert.match(guide, /Declare headless Team Billing/);
  assert.match(serverTypes, /teamBilling\?: TeamBillingDefinition<Schema>/);
  assert.match(serverTypes, /PrivilegedTeamBillingApi[\s\S]*listQuarantines\(options\?: \{ limit\?: number \}\)/);
  assert.match(clientTypes, /get\(teamId: string\): Promise<SporadesResult<TeamBillingProjection>>/);
  assert.match(clientTypes, /startCheckout\(input: TeamBillingCheckoutRequest\): Promise<SporadesResult<TeamBillingCheckoutResult>>/);
  assert.match(clientTypes, /openPortal\(input: TeamBillingPortalRequest\): Promise<SporadesResult<TeamBillingPortalResult>>/);
  assert.match(clientTypes, /requestPlanTransition\(input: TeamBillingPlanTransitionRequest\): Promise<SporadesResult<TeamBillingPlanTransitionResult>>/);
  assert.doesNotMatch(clientTypes, /providerCustomerId|providerSubscriptionId|providerPriceId|providerEventId|idempotencyKey/);
});

test("canonical docs describe the implemented platform scope", async () => {
  const [prd, context, endpointAdr, envAdr, fieldBuilderAdr, authAdr, scaffoldTemplate] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("CONTEXT.md"),
    readProjectFile("docs/adr/0007-no-endpoints-in-v0.md"),
    readProjectFile("docs/adr/0001-env-file-mount-for-v0.md"),
    readProjectFile("docs/adr/0002-capitalised-field-builders.md"),
    readProjectFile("docs/adr/0005-better-auth-server-side-anonymous.md"),
    readProjectFile("src/templates/scaffold-template.ts"),
  ]);

  const staleClaims = [
    /v0 scope:[\s\S]*?No remote hosting, no PaaS API, no TLS/i,
    /No endpoints in v0/i,
    /v0 does not include `endpoint\(\)`/i,
    /Schema-version-locked: hash changes -> drop and recreate/i,
    /hash changes -> drop and recreate/i,
    /Data is lost on schema change/i,
    /v1 will support incremental migrations/i,
    /Future field types:\s*`Number\(\)`, `Date\(\)`, `Json\(\)`/i,
    /Container hardening is deferred to post-v2 platform hardening work/i,
    /Hardened base images and container filesystems:/i,
  ];

  for (const pattern of staleClaims) {
    assert.doesNotMatch(prd, pattern);
    assert.doesNotMatch(context, pattern);
  }

  for (const required of [
    "Implemented scope",
    "Hosted Capsules",
    "Custom endpoints",
    "File storage",
    "App messages",
    "Additive migrations",
    "practical Docker hardening defaults",
    "Caddy automatic HTTPS",
    ".scratch/post-v2-platform-hardening-and-ops/",
  ]) {
    assert.match(prd, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  for (const required of ["Hosted Capsule", "Automatic TLS", "App message", "File metadata", "Schema migration"]) {
    assert.match(context, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  assert.match(endpointAdr, /Status:\s*Superseded/i);
  assert.match(endpointAdr, /Custom endpoints/i);
  assert.match(envAdr, /Status:\s*Superseded/i);
  assert.match(envAdr, /Hosted Capsule release/i);
  assert.doesNotMatch(fieldBuilderAdr, /Future field types/i);
  assert.match(fieldBuilderAdr, /Number\(\)/);
  assert.match(fieldBuilderAdr, /Date\(\)/);
  assert.match(fieldBuilderAdr, /Json\(\)/);
  assert.match(authAdr, /Status:\s*Superseded/i);
  assert.match(authAdr, /runtime-owned auth/i);
  assert.doesNotMatch(authAdr, /Sporades uses Better Auth on the server/i);

  assert.doesNotMatch(scaffoldTemplate, /No endpoints in v0/i);
  assert.doesNotMatch(scaffoldTemplate, /WebSocket only/i);
  assert.match(scaffoldTemplate, /Use endpoints only for HTTP integrations/i);
});

test("published docs and API reference describe the admitted SolidJS client contract", async () => {
  const [readme, prd, guide, clientTypes, api] = await Promise.all([
    readProjectFile("README.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("src/types/client.d.ts"),
    readProjectFile("docs/api/functions/client.createSolidPrimitives.html"),
  ]);
  assert.match(readme, /SolidJS\/Vite scaffolds across the complete template set/);
  assert.match(prd, /SolidJS\/Vite admission across every supported template/);
  assert.match(prd, /createSolidPrimitives/);
  assert.match(guide, /`solid`[\s\S]*SolidJS also[\s\S]*support the complete template set/);
  assert.match(clientTypes, /createSolidPrimitives[\s\S]*SporadesSolidPrimitives/);
  assert.match(api, /Bind root-owned SolidJS signals and cleanup/);
});

test("published docs and API reference describe the admitted Lit controller contract", async () => {
  const [readme, prd, guide, clientTypes, api] = await Promise.all([
    readProjectFile("README.md"), readProjectFile("docs/PRD.md"), readProjectFile("docs/user-guide.md"),
    readProjectFile("src/types/client.d.ts"), readProjectFile("docs/api/functions/client.createLitControllers.html"),
  ]);
  assert.match(readme, /Lit\/Vite Web Component scaffolds across the complete template set/);
  assert.match(prd, /Lit\/Vite admission across every supported template/);
  assert.match(prd, /createLitControllers/);
  assert.match(guide, /`lit`[\s\S]*Lit also selects Vite[\s\S]*supports the complete template set/);
  assert.match(clientTypes, /createLitControllers[\s\S]*SporadesLitControllers/);
  assert.match(api, /Create Lit reactive controllers bound to their host element lifecycle/);
});

test("published docs and API reference describe the admitted Inferno lifecycle contract", async () => {
  const [readme, prd, guide, clientTypes, api] = await Promise.all([
    readProjectFile("README.md"), readProjectFile("docs/PRD.md"), readProjectFile("docs/user-guide.md"),
    readProjectFile("src/types/client.d.ts"), readProjectFile("docs/api/functions/client.createInfernoAdapters.html"),
  ]);
  assert.match(readme, /Inferno scaffolds across the complete template set/);
  assert.match(prd, /Inferno admission across every supported template through esbuild or explicit Vite/);
  assert.match(prd, /createInfernoAdapters/);
  assert.match(guide, /`inferno`[\s\S]*Inferno supports the complete template set[\s\S]*explicit `--toolchain vite`/);
  assert.match(clientTypes, /createInfernoAdapters[\s\S]*SporadesInfernoAdapters/);
  assert.match(api, /Create query, mutation, and auth adapters for Inferno class-component lifecycle/);
});

test("canonical docs publish the implemented client capability matrix and ADR succession", async () => {
  const [guide, roadmap, oldAdr, activeAdr] = await Promise.all([
    readProjectFile("docs/user-guide.md"), readProjectFile("docs/ROADMAP.md"), readProjectFile("docs/adr/0010-user-owned-index-html.md"), readProjectFile("docs/adr/0032-user-owned-html-builds-to-a-normalized-public-tree.md"),
  ]);
  for (const row of ["Vanilla TypeScript | esbuild", "React | esbuild | Vite", "Preact | esbuild | Vite", "Vue | Vite", "Svelte | Vite", "SolidJS | Vite", "Lit | Vite", "Inferno | esbuild | Vite"]) assert.match(guide, new RegExp(row.replaceAll("|", "\\|")));
  assert.match(guide, /Angular and server-owning meta-frameworks remain outside/);
  assert.match(oldAdr, /Status: Superseded by ADR-0032/); assert.match(activeAdr, /Status: Accepted/); assert.match(activeAdr, /supersedes ADR 0010/);
  assert.match(roadmap, /Recently Implemented[\s\S]*Multi-framework client toolchains \| implemented/);
  assert.doesNotMatch(roadmap.match(/## Recommended Next Features[\s\S]*?## Recently Implemented/)?.[0] ?? "", /Multi-framework client toolchains/);
});

test("docs publish the implemented User journey tracker contract", async () => {
  const [guide, roadmap, clientTypes, serverTypes] = await Promise.all([
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("src/types/client.d.ts"),
    readProjectFile("src/types/server.d.ts"),
  ]);

  for (const required of [
    "journey.enable()", "journey.set", "journey.disable()", "journey.list()", "journey.subscribe",
    "page-runtime consent", "new transport connection", "sessionInactivityMinutes", "30 minutes",
    "1–1,440", "1–300 seconds", "data-sporades-journey", "normalized pathname", "100 milliseconds",
    "32 live", "1,000 live", "snapshot", "inactive", "Privileged server role",
  ]) assert.match(guide, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

  assert.match(guide, /does not return a `sessionId`/i);
  assert.match(guide, /query|origin/i);
  assert.match(guide, /8 KiB/i);
  assert.match(guide, /no private resume credential/i);
  assert.match(guide, /React, Preact, Vue, Svelte, SolidJS, Lit, and Inferno/i);
  assert.match(guide, /framework-neutral Journey stream/i);
  assert.match(guide, /composedPath\(\)[\s\S]*open Shadow DOM/i);
  assert.match(guide, /closed\s+Shadow DOM[\s\S]*host is annotated/i);
  assert.match(roadmap, /Recently Implemented[\s\S]*User journey tracker \| implemented/i);
  assert.doesNotMatch(roadmap.match(/## Recommended Next Features[\s\S]*?## Recently Implemented/)?.[0] ?? "", /User journey tracker/i);
  assert.doesNotMatch(roadmap.match(/## Data And Auth Helpers[\s\S]*?## Storage/)?.[0] ?? "", /User journey tracker/i);
  assert.match(clientTypes, /page-runtime User journey publication lifecycle/i);
  assert.match(serverTypes, /Journey tracker/i);
});

test("published docs and API describe production SMTP mail parity", async () => {
  const [prd, architecture, mailGuide, serverGuide, reference, declarations, apiMail, apiInput] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/architecture.md"),
    readProjectFile("docs/guide/mail.md"),
    readProjectFile("docs/guide/server.md"),
    readProjectFile("docs/reference/server-runtime.md"),
    readProjectFile("src/types/server.d.ts"),
    readProjectFile("docs/api/types/server.MailApi.html"),
    readProjectFile("docs/api/types/server.MailSendInput.html"),
  ]);
  const published = [prd, architecture, mailGuide, serverGuide, reference].join("\n");
  for (const required of [
    "Dev sessions", "local Container sessions", "Hosted Capsules", "Postmark",
    "Mailgun", "SMTP2GO", "at least once", "idempotency", "cannot roll back",
  ]) assert.match(published, new RegExp(required, "i"));
  assert.match(mailGuide, /provider\.headers/);
  assert.match(mailGuide, /sendWelcome:\s*job/);
  assert.match(architecture, /active\s+sockets/i);
  assert.match(reference, /exclude[\s\S]*addresses[\s\S]*bodies/i);
  assert.match(declarations, /intentionally[\s\S]*absent from browser, table ACL, and Schedule payload-factory contexts/i);
  assert.match(apiMail, /Server-only runtime-owned SMTP delivery API/);
  assert.match(apiInput, /not an arbitrary provider API payload/);
});

test("the Mail guide documents provider delivery events without claiming registration tooling", async () => {
  const [configuration, mail, navigation] = await Promise.all([
    readProjectFile("docs/guide/configuration.md"),
    readProjectFile("docs/guide/mail.md"),
    readProjectFile("docs/.vitepress/config.mts"),
  ]);
  assert.match(configuration, /guide\/mail|\.\/mail/);
  assert.match(navigation, /Mail[\s\S]*\/guide\/mail/);
  for (const required of [
    /mail\.webhooks\.mailjet/,
    /emailEvents:\s*emailEvent/,
    /VerifiedEmailEvent/,
    /raw\s+per-event/i,
    /does not persist/i,
    /durable Job/i,
    /does not\s+(?:yet\s+)?register|registration[\s\S]*not/i,
  ]) assert.match(mail, required);
});

test("the Mail guide documents secure SMTP2GO provider-event setup and semantics", async () => {
  const mail = await readProjectFile("docs/guide/mail.md");
  for (const required of [
    /mail\.webhooks\.smtp2go/,
    /SMTP2GO_WEBHOOK_SECRET/,
    /Bearer/i,
    /shared secret[\s\S]*not[\s\S]*(?:signature|signed)/i,
    /Basic[\s\S]*not accepted/i,
    /output_format[\s\S]*json/i,
    /defaults to\s+`form`/i,
    /processed[\s\S]*deferred/,
    /resubscribe[\s\S]*resubscribed/,
    /35[\s\S]*(?:48 hours|48h)/i,
    /X-Sporades-Correlation-Id/,
    /does not[\s\S]*(?:automatically|yet)[\s\S]*(?:register|reconcile)/i,
  ]) assert.match(mail, required);
});

test("the Mail guide documents secure Postmark provider-event setup and semantics", async () => {
  const mail = await readProjectFile("docs/guide/mail.md");
  for (const required of [
    /mail\.webhooks\.postmark/,
    /POSTMARK_WEBHOOK_SECRET/,
    /X-Sporades-Webhook-Token/,
    /not[\s\S]*(?:POSTMARK_API_KEY|Server API token)/i,
    /shared secret[\s\S]*not[\s\S]*(?:signature|signed)/i,
    /does not support HMAC/i,
    /SubscriptionChange[\s\S]*resubscribed/,
    /ManualSuppression[\s\S]*unsubscribed/,
    /MessageID[\s\S]*not[\s\S]*(?:unique|providerEventId)/i,
    /one\s+minute[\s\S]*five\s+minutes[\s\S]*15\s+minutes/i,
    /provider\.metadata[\s\S]*correlationId/,
    /does not[\s\S]*(?:automatically|yet)[\s\S]*(?:register|reconcile)/i,
  ]) assert.match(mail, required);
});

test("the Mail guide documents signed Mailgun provider-event setup and semantics", async () => {
  const mail = await readProjectFile("docs/guide/mail.md");
  for (const required of [
    /mail\.webhooks\.mailgun/,
    /MAILGUN_WEBHOOK_KEY/,
    /MAILGUN_API_KEY[\s\S]*not/i,
    /HMAC-SHA256[\s\S]*timestamp[\s\S]*token/i,
    /accepted[\s\S]*deferred/,
    /temporary[\s\S]*deferred/,
    /permanent[\s\S]*bounced/,
    /suppress-complaint[\s\S]*complained/,
    /suppress-unsubscribe[\s\S]*unsubscribed/,
    /`200`[\s\S]*`406`/,
    /provider-specific terminal response[\s\S]*Mailgun[\s\S]*`406`/i,
    /Delivery[\s\S]*(?:does not retry|not\s+retried)/i,
    /X-Mailgun-Variables[\s\S]*correlationId/,
    /US[\s\S]*EU[\s\S]*(?:separate|independent|isolated)/i,
    /does not[\s\S]*(?:automatically|yet)[\s\S]*(?:register|reconcile)/i,
  ]) assert.match(mail, required);
});

test("published docs describe the complete Job scheduling contract", async () => {
  const [prd, context, guide, roadmap, serverSource, serverDeclarations, apiSchedule, apiDefinition] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("CONTEXT.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("src/server.ts"),
    readProjectFile("src/types/server.d.ts"),
    readProjectFile("docs/api/functions/server.schedule.html"),
    readProjectFile("docs/api/types/server.ScheduleDefinition.html"),
  ]);

  for (const published of [prd, guide]) {
    assert.match(published, /five-field cron/i);
    assert.match(published, /IANA timezone/i);
    assert.match(published, /`skip`[\s\S]*`latest`/i);
    assert.match(published, /at least once/i);
    assert.match(published, /Privileged server role/i);
    assert.match(published, /duplicate/i);
    assert.match(published, /sporades\s+schedules/);
    assert.match(published, /sporades\s+deploy schedules/);
    assert.match(published, /sporades\s+host schedules/);
    assert.match(published, /JSON-only/i);
  }

  assert.match(guide, /payload factor(?:y|ies)[\s\S]*may run more than once/i);
  assert.match(guide, /payloadVersion[\s\S]*captured configuration/i);
  assert.match(guide, /payloadVersion[\s\S]*(?:optional|v0\.8\.5)/i);
  assert.match(guide, /durable incarnation[\s\S]*(?:generation )?authority/i);
  assert.match(guide, /failed candidate[\s\S]*(?:live|previous|prior) scheduler/i);
  assert.match(guide, /queued factories[\s\S]*never starts?/i);
  assert.match(guide, /remov(?:e|ing)[\s\S]*fresh identity/i);
  assert.match(guide, /`availableAt`[\s\S]*not recurring/i);
  assert.match(guide, /four-digit UTC timestamp/i);
  assert.match(guide, /owner deletion[\s\S]*(?:does not|without)[\s\S]*(?:cancel|prevent|rewrite)[\s\S]*(?:Job|snapshot|work)/i);
  assert.match(guide, /shutdown hook[\s\S]*mail closure[\s\S]*both failures/i);
  assert.match(guide, /import \{ capsule, job, schedule \} from "sporades\/server"/);
  assert.match(guide, /sendDigest:\s*job\(/);
  assert.match(guide, /jobs:\s*\{[\s\S]*sendDigest[\s\S]*schedules:\s*\{/);
  assert.match(context, /\*\*Schedule\*\*:/);
  assert.match(context, /\*\*Scheduled occurrence\*\*:/);
  assert.match(roadmap, /\| Job scheduling \| implemented \|/);
  assert.doesNotMatch(roadmap, /Recurring Job scheduling remains a dependent design item/);
  assert.doesNotMatch(roadmap, /required by future Job scheduling/);
  assert.doesNotMatch(roadmap, /Job scheduling remains a dependent roadmap track/);
  assert.match(prd, /\.scratch\/job-scheduling\/PRD\.md/);

  for (const api of [serverSource, serverDeclarations]) {
    assert.match(api, /export (?:declare )?function schedule/);
    assert.match(api, /numeric five-field cron/i);
    assert.match(api, /server-only/i);
    assert.match(api, /missedRun\?: "skip" \| "latest"/);
  }
  assert.match(apiSchedule, /numeric five-field cron/i);
  assert.match(apiSchedule, /at-least-once/i);
  assert.match(apiDefinition, /server-only recurring Job declaration/i);
});

test("Hetzner provisioning script reuses an existing SSH key with the local fingerprint", async () => {
  const hostProvisioning = await readProjectFile("docs/agents/host-provisioning.md");
  const script = extractShellBlockAfter(hostProvisioning, "## Provider script: Hetzner Cloud");

  await withTempDir(async (dir) => {
    const binDir = path.join(dir, "bin");
    await mkdir(binDir);
    const publicKeyPath = path.join(dir, "id_ed25519.pub");
    const callsPath = path.join(dir, "hcloud-calls.log");
    const scriptPath = path.join(dir, "provision-hetzner.sh");
    await writeFile(publicKeyPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey user@workstation\n");
    await writeFile(scriptPath, script);

    await writeFile(
      path.join(binDir, "ssh-keygen"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "256 MD5:aa:bb:cc:dd fake-key (ED25519)"
`,
    );
    await chmod(path.join(binDir, "ssh-keygen"), 0o755);

    await writeFile(
      path.join(binDir, "hcloud"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$HCLOUD_CALLS"
created_path="$HCLOUD_CALLS.created"
case "$*" in
  "ssh-key list -o columns=id,name,fingerprint -o noheader")
    printf '101 user@ubuntu aa:bb:cc:dd\\n'
    ;;
  "server list -o columns=id,name -o noheader")
    if [ -f "$created_path" ]; then
      printf '999 sporades-host-01\\n'
    fi
    ;;
  server\\ create*)
    touch "$created_path"
    exit 0
    ;;
  "server describe 999 -o json")
    printf '{"public_net":{"ipv4":{"ip":"203.0.113.42"}}}\\n'
    ;;
  *)
    echo "unexpected hcloud call: $*" >&2
    exit 17
    ;;
esac
`,
    );
    await chmod(path.join(binDir, "hcloud"), 0o755);

    const result = await runShell(scriptPath, {
      cwd: dir,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        HCLOUD_CALLS: callsPath,
        HCLOUD_TOKEN: "test-token",
        SPORADES_SSH_KEY_NAME: "workstation",
        SPORADES_SSH_PUBLIC_KEY: publicKeyPath,
      },
    });

    assert.equal(result.code, 0, result.stderr);
    const calls = await readFile(callsPath, "utf8");
    assert.match(calls, /^ssh-key list -o columns=id,name,fingerprint -o noheader$/m);
    assert.doesNotMatch(calls, /ssh-key create/);
    assert.match(calls, /server create[\s\S]*--ssh-key 101/);
  });
});

test("Host provisioning shared install script enables fail2ban for sshd", async () => {
  const hostProvisioning = await readProjectFile("docs/agents/host-provisioning.md");
  const script = extractShellBlockAfter(hostProvisioning, "## Shared script: install Sporades Host server");

  assert.match(script, /apt-get install -y ca-certificates curl fail2ban gnupg tar/);
  assert.match(script, /\/etc\/fail2ban\/jail\.d\/sporades-sshd\.conf/);
  assert.match(script, /systemctl enable --now fail2ban/);
  assert.match(script, /fail2ban-client status sshd/);
});

test("Host installation docs keep Fail2ban hardening separate from SSH audit truth", async () => {
  const serverInstallation = await readProjectFile("docs/server-installation.md");

  assert.match(serverInstallation, /Fail2ban protects the Host server's own `sshd` service/i);
  assert.match(serverInstallation, /hardening-adjacent telemetry/i);
  assert.match(serverInstallation, /not the audit source of truth/i);
});

test("SSH daemon session-log scanner spike records the parser and cursor decision", async () => {
  const spike = await readProjectFile(".scratch/privileged-audit-event-contract/ssh-daemon-session-log-scanner-spike.md");

  assert.match(spike, /OpenSSH `sshd -E` can write authentication and session facts/i);
  assert.match(spike, /Docker Desktop was not running/i);
  assert.match(spike, /\/app\/data\/ssh\/sshd\.log/);
  assert.match(spike, /\/app\/data\/ssh\/sshd-audit-cursor\.json/);

  for (const eventName of [
    "ssh.auth.succeeded",
    "ssh.auth.failed",
    "ssh.session.opened",
    "ssh.session.closed",
  ]) {
    assert.match(spike, new RegExp(eventName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const required of [
    "username",
    "remoteAddress",
    "keyFingerprint",
    "source: `sshd`",
    "Unknown daemon log lines",
    "full public keys",
    "raw daemon log lines",
    "private key material",
    "environment values",
    "Proceed",
  ]) {
    assert.match(spike, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("canonical docs describe Host stats without introducing host status", async () => {
  const [userGuide, serverInstallation, architecture] = await Promise.all([
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/server-installation.md"),
    readProjectFile("docs/architecture.md"),
  ]);

  assert.match(userGuide, /sporades host stats --host personal --json/);
  assert.match(userGuide, /sporades host stats team-notes --host personal --json/);
  assert.match(serverInstallation, /host stats --json` returns Host server disk, memory, load, Docker\/Caddy\s+availability/);
  assert.match(serverInstallation, /host\s+stats <subname> --json` returns normalized Docker Container stats/);
  assert.match(architecture, /`sporades host stats` reports Host server resource state/);
  assert.match(architecture, /`sporades host stats <subname>` reports Container stats and lifecycle state/);

  for (const contents of [userGuide, serverInstallation, architecture]) {
    assert.doesNotMatch(contents, /sporades host status/);
  }
});

test("docs describe implemented preferences and Container SSH access", async () => {
  const [roadmap, userGuide, prd, readme, runtimeLayout, sshPrd] = await Promise.all([
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("README.md"),
    readProjectFile("docs/runtime-layout.md"),
    readProjectFile(".scratch/ssh-to-docker/PRD.md"),
  ]);

  assert.match(roadmap, /Recently Implemented/);
  assert.match(roadmap, /User preferences table and SDK \| implemented/);
  assert.match(roadmap, /preferences\.get\(\)/);
  assert.match(roadmap, /preferences\.updated/);
  assert.doesNotMatch(roadmap, /SSH to Docker \| ready/);
  assert.match(roadmap, /SSH to Docker \| implemented/);
  assert.doesNotMatch(
    roadmap,
    /User preferences table and SDK \| ready \| Add a Sporades-owned key-value JSON preferences store/,
  );

  assert.match(userGuide, /const next = await preferences\.update/);
  assert.match(userGuide, /filter\("preferences\.updated"\)/);
  assert.match(userGuide, /The update notification is a convergence signal/);
  assert.match(userGuide, /Container SSH Access/);
  assert.match(userGuide, /"ssh":\s*\{\s*"authorizedKeys":\s*\[\s*\{\s*"key": "ssh-ed25519 AAAA/);
  assert.match(userGuide, /\{\s*"file": "~\/\.ssh\/id_ed25519\.pub"\s*\}/);
  assert.match(userGuide, /`file` entries resolve on the CLI machine/);
  assert.match(userGuide, /absolute paths, `~`, and project-relative paths/);
  assert.match(userGuide, /original\s+source\s+paths\s+are\s+not\s+copied\s+into\s+Hosted\s+Capsule\s+releases/);
  assert.match(userGuide, /OpenSSH `authorized_keys` semantics/);
  assert.match(userGuide, /`sporades` user/);
  assert.match(userGuide, /key-based\s+authentication\s+only/);
  assert.match(
    userGuide,
    /does\s+not\s+provide\s+root\s+login,\s+sudoers\s+access,\s+passwords,\s+custom\s+SSH\s+ports,\s+or\s+public\s+SSH\s+port\s+exposure/,
  );
  assert.match(userGuide, /`sporades deploy ssh`/);
  assert.match(userGuide, /`sporades host ssh`/);
  assert.match(userGuide, /Indicative examples/);
  assert.match(userGuide, /ssh -p <local-port> sporades@127\.0\.0\.1/);
  assert.match(userGuide, /ssh -N -L <local-port>:127\.0\.0\.1:<host-loopback-port> <host-profile-ssh-target>/);
  assert.doesNotMatch(userGuide, /ssh\.enabled/);

  assert.match(prd, /Container SSH access for local Container sessions and Hosted Capsules/);
  assert.match(prd, /opt-in\s+compatibility and emergency access path/);
  assert.match(prd, /same-user convergence signal/);

  assert.match(readme, /Preferences follow the Sporades user identity/);
  assert.match(readme, /Container SSH access is opt-in/);
  assert.doesNotMatch(readme, /The next shaped feature is opt-in SSH access/);
  assert.match(runtimeLayout, /\/app\/data\/ssh\/authorized_keys/);
  assert.match(runtimeLayout, /\.sporades\/ssh\/authorized_keys/);
  assert.match(runtimeLayout, /releases\/\s+<release-id>\/[\s\S]*\.sporades\/ssh\/authorized_keys/);
  assert.match(runtimeLayout, /generated public authorized-key material/);
  assert.match(runtimeLayout, /[Ss]ource `file` paths[\s\S]*are not copied/);
  assert.doesNotMatch(runtimeLayout, /do not currently start an SSH service or publish\s+container port 22/);
  assert.doesNotMatch(runtimeLayout, /Hosted Capsules do not currently publish SSH directly/);

  assert.match(sshPrd, /Status: implemented/i);
  assert.match(sshPrd, /implemented and documented/i);
});

test("docs describe the implemented Privileged audit event contract", async () => {
  const [roadmap, prd, context] = await Promise.all([
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("CONTEXT.md"),
  ]);

  assert.match(roadmap, /Privileged audit event contract \| implemented/);
  assert.doesNotMatch(roadmap, /\| Privileged audit event contract \| design \|/);
  assert.doesNotMatch(roadmap, /Blocked by Privileged audit event contract/);
  assert.match(roadmap, /implemented Privileged audit event contract/);
  assert.match(roadmap, /Real `sshd` auth\/session capture remains future scanner work/);
  assert.match(roadmap, /\.scratch\/privileged-audit-event-contract\/ssh-daemon-session-log-scanner-spike\.md/);
  assert.match(roadmap, /Implemented scheduled Privileged Jobs reuse the existing Privileged audit boundary/);

  assert.match(prd, /Privileged audit event contract for runtime-owned and platform-owned\s+security events/);
  assert.match(prd, /narrow structured JSONL audit\s+surface/);
  assert.match(prd, /not a new audit\s+database/);
  assert.match(prd, /centralized logging replacement/);
  assert.match(prd, /`sporades logs --json`/);
  assert.match(prd, /`sporades logs tail --json`/);
  assert.match(prd, /Host helper JSON/);
  assert.match(prd, /App `ctx\.log` writes\s+normal app log events only/);
  assert.match(prd, /browser\/client credentials do not carry privileged\s+authority/);

  for (const field of [
    "actorKind",
    "operation",
    "surface",
    "targetResourceKind",
    "outcome",
    "safeErrorCode",
    "metadata",
  ]) {
    assert.match(prd, new RegExp(field));
  }

  for (const actorKind of ["platform", "privileged-server-role", "captured-user", "unknown"]) {
    assert.match(prd, new RegExp(actorKind));
  }

  for (const outcome of ["started", "completed", "errored", "finished"]) {
    assert.match(prd, new RegExp(outcome));
  }
  assert.match(prd, /finally/);
  assert.match(prd, /Privileged audit emission is not best-effort/);
  assert.match(prd, /cannot emit a\s+required privileged audit event, the privileged operation throws/);
  assert.match(prd, /original\s+callback error as structured context/);
  assert.match(prd, /callback result as structured context/);
  assert.match(prd, /server-side only/);
  assert.match(prd, /must not be exposed in\s+default client-visible error responses/);
  assert.match(prd, /returns the callback result as-is/);
  assert.match(prd, /does not inspect, sanitize, or\s+classify successful callback return values/);
  assert.match(prd, /caller-supplied `AbortSignal`/);
  assert.match(prd, /privilegedCtx\.signal/);
  assert.match(prd, /fresh per-run\s+non-aborted default signal/);
  assert.match(prd, /must not use a shared\s+long-lived signal/);
  assert.match(prd, /cleaned up when the run\s+reaches `finished`/);
  assert.match(prd, /created and exposed to the callback only after\s+`started` audit emission succeeds/);
  assert.match(prd, /no privileged\s+context is handed out and the callback does not run/);
  assert.match(prd, /Required audit metadata is validated and redacted before `started`/);
  assert.match(prd, /metadata validation,\s+redaction, or generation fails/);
  assert.match(prd, /Metadata generation for `ctx\.privileged\.run\(\.\.\.\)` is synchronous and structural/);
  assert.match(prd, /must not perform\s+async DB, file, storage, network, or service work before `started`/);
  assert.match(prd, /do not introduce new runtime timeout, retry, or cancellation\s+policy/);
  assert.match(prd, /already-aborted signal/);
  assert.match(prd, /stable abort safe\s+error code/);
  assert.match(prd, /signal aborts while the callback is already running/);
  assert.match(prd, /does not interrupt arbitrary callback work/);
  assert.match(prd, /There is no audit-outcome concept of\s+allowed, denied, or\s+skipped/);
  assert.match(prd, /Existing SSH and platform audit emitters must use this same `outcome` vocabulary/);
  assert.match(prd, /the outcome\s+field does not use SSH-specific or legacy success\/failure terms/);
  for (const staleOutcome of ["requested", "allowed", "denied", "succeeded", "failed", "skipped"]) {
    assert.doesNotMatch(prd, new RegExp(`Outcomes use[^.]+${staleOutcome}`));
  }

  for (const redacted of [
    "full public keys",
    "private keys",
    "source key file paths",
    "generated authorized-key contents",
    "Server env values",
    "session tokens",
    "raw daemon logs",
  ]) {
    assert.match(prd, new RegExp(redacted.replaceAll(" ", "\\s+")));
  }

  assert.match(prd, /ssh\.config\.validated/);
  assert.match(prd, /ssh\.access\.enabled/);
  assert.match(prd, /ssh\.access\.disabled/);
  assert.match(prd, /ssh\.state\.inspected/);
  assert.match(prd, /Real\s+SSH login\/session\s+capture from `sshd` remains future scanner work/);
  assert.match(prd, /\.scratch\/privileged-audit-event-contract\/ssh-daemon-session-log-scanner-spike\.md/);
  assert.match(prd, /Security officers should be able to reconstruct incident timelines/);
  assert.match(prd, /verify that browser\s+or app\s+credentials could not forge a privileged event/);
  assert.match(prd, /redacted\s+evidence/);

  assert.match(context, /platform-owned structured JSONL log event/);
  assert.match(context, /current SSH configuration, lifecycle, and inspection events/);
  assert.match(context, /Capsule app `ctx\.log` cannot emit Privileged audit events/);
});

test("docs describe the implemented Privileged server role and Job Queue contracts", async () => {
  const [roadmap, prd, userGuide, apiServer, apiPrivileged, apiPrivilegedTeams, apiPrivilegedLink, apiJob, apiJobApi, apiClient] = await Promise.all([
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/api/modules/server.html"),
    readProjectFile("docs/api/types/server.PrivilegedApi.html"),
    readProjectFile("docs/api/types/server.PrivilegedTeamsApi.html"),
    readProjectFile("docs/api/types/server.PrivilegedTeamJoinLink.html"),
    readProjectFile("docs/api/functions/server.job.html"),
    readProjectFile("docs/api/types/server.JobApi.html"),
    readProjectFile("docs/api/modules/client.html"),
  ]);

  assert.match(roadmap, /Privileged server role \| implemented/);
  assert.doesNotMatch(roadmap, /\| Privileged server role \| design \|/);
  assert.match(roadmap, /Planning remains in `\.scratch\/privileged-server-role\/PRD\.md`/);
  assert.match(roadmap, /Job queue \| implemented[\s\S]*current-user and Privileged server role actors/);
  assert.doesNotMatch(roadmap, /\| Job queue \| ready \|/);
  assert.match(roadmap, /Job scheduling \| implemented[\s\S]*duplicate-protected occurrence creation/);
  assert.doesNotMatch(roadmap, /\| Job scheduling \| ready \|/);
  assert.match(prd, /Runtime-owned Job scheduling through named server-only `schedule\(\)`/);
  assert.doesNotMatch(prd, /Durable persistence, missed-run recovery, reconciliation, and[\s\S]*operator inspection remain pending/);
  assert.doesNotMatch(prd, /Recurring Job scheduling remains future work/);

  const implementedScope = prd.slice(prd.indexOf("### Implemented scope"), prd.indexOf("### Future scope"));
  const futureScope = prd.slice(prd.indexOf("### Future scope"), prd.indexOf("## Product Principles"));
  assert.match(implementedScope, /Privileged server role/);
  assert.match(implementedScope, /`ctx\.privileged\.run\(\.\.\.\)`/);
  assert.match(implementedScope, /runtime-owned Job Queue/);
  assert.match(implementedScope, /current\s+Sporades user or the Privileged server role/);
  assert.match(implementedScope, /retry/);
  assert.match(implementedScope, /cancellation/);
  assert.match(implementedScope, /restart recovery/);
  assert.match(implementedScope, /Runtime-owned Job scheduling/);
  assert.doesNotMatch(futureScope, /- Privileged server role:/);
  assert.doesNotMatch(futureScope, /trusted userless work inside a Capsule/);
  assert.doesNotMatch(futureScope, /Vector storage, Job Queue, and Job scheduling/);
  assert.doesNotMatch(futureScope, /Job scheduling/);

  assert.match(prd, /Privileged server role is implemented/);
  assert.match(prd, /`ctx\.privileged\.run\(\.\.\.\)`/);
  assert.match(prd, /query, mutation, Custom endpoint,\s+App message, context middleware, and supported mutation hook/);
  assert.match(prd, /current user identity/);
  assert.match(prd, /captured bounded[\s\S]*Auth and Credential snapshot/);
  assert.match(prd, /Privileged server role/);
  for (const notA of ["Capsule role", "app admin", "Teams", "user", "session", "browser credential", "service account"]) {
    assert.match(prd, new RegExp(notA));
  }
  for (const outcome of ["started", "completed", "errored", "finished"]) {
    assert.match(prd, new RegExp(outcome));
  }
  assert.match(prd, /Privileged run aborted/);
  assert.match(prd, /generated runtime artifacts/);

  assert.match(userGuide, /Choosing a server actor/);
  assert.match(userGuide, /current user/);
  assert.match(userGuide, /bounded Auth and Credential snapshot captured/i);
  assert.match(userGuide, /Privileged server role/);
  assert.match(userGuide, /`ctx\.privileged\.run\(\.\.\.\)`/);
  assert.match(userGuide, /not a Capsule role, app admin, Team, user, session,\s+service account, or browser credential/);

  assert.match(apiServer, /PrivilegedApi/);
  assert.match(apiServer, /PrivilegedContext/);
  assert.match(apiPrivileged, /ctx\.privileged\.run/);
  assert.match(apiPrivileged, /server-only/);
  for (const inspection of ["countMembers", "listMembers", "listJoinLinks", "inspectJoinLink"]) {
    assert.match(apiPrivilegedTeams, new RegExp(inspection));
  }
  assert.match(apiPrivilegedLink, /Target email is admin-only/);
  assert.match(prd, /read-only exact-Team inspection surface/);
  assert.match(prd, /`TEAM_NOT_FOUND`/);
  assert.match(prd, /Join-link metadata without\s+the target email/);
  assert.match(prd, /detached or aborted in-flight work fails closed/i);
  assert.match(apiPrivilegedTeams, /In-flight inspection rejects/);
  assert.match(prd, /Current-user\s+Team listing and email-bound Join-link validation remain unavailable/);

  for (const command of ["sporades jobs", "sporades deploy jobs", "sporades host jobs"]) {
    assert.match(userGuide, new RegExp(command));
  }
  assert.match(userGuide, /JSON-only/);
  assert.match(userGuide, /all Jobs/);
  assert.match(userGuide, /payloads/);
  assert.match(userGuide, /idempotency-key values/);
  for (const excluded of ["filters", "cursor", "pagination", "human renderer", "offline inspection"]) {
    assert.match(userGuide, new RegExp(excluded));
  }
  for (const status of ["delayed", "queued", "running", "succeeded", "failed", "cancelled"]) {
    assert.match(userGuide, new RegExp(`\\b${status}\\b`));
  }
  assert.match(userGuide, /Only `queued` Jobs are ready to run/);
  assert.match(userGuide, /single worker/);
  assert.match(userGuide, /lease recovery/);
  assert.match(userGuide, /current-user inspection[\s\S]*captured execution actor/i);
  assert.match(userGuide, /Privileged inspection[\s\S]*all Jobs/);
  assert.match(userGuide, /`enqueuedBy`[\s\S]*provenance/);
  assert.match(userGuide, /numeric five-field cron expressions/);
  assert.match(userGuide, /IANA timezone[\s\S]*server timezone[\s\S]*Dev, Container,[\s\S]*Hosted/);
  assert.match(userGuide, /future occurrence calculation only[\s\S]*does not backfill/);
  assert.match(userGuide, /day-of-month and day-of-week[\s\S]*OR behavior/);
  assert.match(userGuide, /spring[\s\S]*no occurrence[\s\S]*repeated fall hour[\s\S]*both matching UTC instants/);
  assert.match(userGuide, /Use `UTC`/);

  assert.match(apiServer, /JobApi/);
  assert.match(apiServer, /JobState/);
  assert.match(apiJob, /server-only Job handler/);
  assert.match(apiJobApi, /enqueue/);
  assert.match(apiJobApi, /get/);
  assert.match(apiJobApi, /list/);
  assert.doesNotMatch(apiClient, /JobApi/);
});

test("canonical, feature, and reference Job docs describe transaction-bound enqueue lifecycle", async () => {
  const [canonicalPrd, featurePrd, jobReference] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile(".scratch/job-queue/PRD.md"),
    readProjectFile("docs/reference/jobs-and-schedules.md"),
  ]);

  for (const document of [canonicalPrd, featurePrd, jobReference]) {
    assert.match(document, /`ctx\.jobs\.enqueue`[\s\S]*same (?:mutation,\s+App\s+message,\s+or\s+Custom\s+endpoint|handler) transaction/i);
    assert.match(document, /handler\s+rollback[\s\S]*removes\s+the\s+Job/i);
    assert.match(document, /worker dispatch[\s\S]*only\s+after\s+(?:the\s+)?transaction\s+commits/i);
    assert.match(document, /dispatch\s+registration\s+failure[\s\S]*does\s+not\s+(?:reverse|undo)[\s\S]*committed\s+handler/i);
    assert.match(document, /dispatch\s+registration\s+failure[\s\S]*does\s+not[\s\S]*misreport[\s\S]*committed\s+handler/i);
    assert.match(document, /later\s+(?:worker\s+)?wake[\s\S]*runtime\s+restart/i);
    assert.doesNotMatch(document, /enqueue is a durable runtime side effect outside the[\s\S]*Transaction boundary/i);
    assert.doesNotMatch(document, /queue writes are not atomic with Capsule app mutation writes/i);
    assert.doesNotMatch(document, /prove enqueue does not claim atomicity with Capsule mutation writes/i);
    assert.doesNotMatch(document, /do not promise[\s\S]*transactional enqueue with Capsule app mutations/i);
  }
});

test("canonical Job and architecture docs describe settled runtime shutdown", async () => {
  const [canonicalPrd, jobReference, architecture] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/reference/jobs-and-schedules.md"),
    readProjectFile("docs/architecture.md"),
  ]);

  for (const document of [canonicalPrd, jobReference, architecture]) {
    assert.match(document, /stop(?:s)? scheduling new Job work/i);
    assert.match(document, /clear(?:s)?[\s\S]*(?:immediate|delayed|retry)[\s\S]*timers/i);
    assert.match(document, /abort(?:s)?[\s\S]*(?:active|running) Job handlers/i);
    assert.match(document, /await(?:s)?[\s\S]*(?:worker|Job work)[\s\S]*before[\s\S]*(?:Database adapter|database connection)/i);
    assert.match(document, /worker settlement[\s\S]*before[\s\S]*Capsule shutdown hook/i);
    assert.match(document, /worker settlement[\s\S]*before[\s\S]*mail/i);
    assert.match(document, /active[\s\S]*worker[\s\S]*current attempt[\s\S]*without[\s\S]*claiming another/i);
    assert.match(document, /worker settlement[\s\S]*failure[\s\S]*does not skip[\s\S]*resource closure/i);
    assert.match(document, /Capsule shutdown hook[\s\S]*failure[\s\S]*(?:Database adapter|database connection)[\s\S]*(?:close|closure)/i);
    assert.match(document, /Signal shutdown[\s\S]*stop(?:s)? accepting[\s\S]*drain(?:s)?[\s\S]*HTTP/i);
    assert.match(document, /commit[\s\S]*(?:empty queue (?:read|scan)|worker scan)[\s\S]*(?:another scan|required rerun)/i);
    assert.match(document, /Candidate\s+initialization[\s\S]*Dev replacement ownership boundary/i);
    assert.match(document, /teardown[\s\S]*(?:prior|previous) runtime[\s\S]*(?:failure|reports a failure)/i);
    assert.match(document, /promote(?:s)?[\s\S]*(?:viable|initialized)[\s\S]*candidate/i);
    assert.match(document, /closed[\s\S]*(?:(?:prior|previous)[\s\S]*)?runtime/i);
    assert.match(document, /Job activation timer[\s\S]*preflight(?:ed|s)?[\s\S]*before[\s\S]*(?:prior|outgoing)[\s\S]*teardown/i);
    assert.match(document, /activation\s+scheduling[\s\S]*(?:degrades|fails)[\s\S]*promote(?:s|d)?[\s\S]*candidate/i);
    assert.match(document, /durable[\s\S]*(?:queued|delayed)[\s\S]*runtime restart/i);
  }
});

test("roadmap records delivered explicit-Team ACL decisions without claiming automatic data partitioning", async () => {
  const roadmap = await readProjectFile("docs/ROADMAP.md");

  assert.match(roadmap, /Built-in Teams foundation \| implemented/);
  assert.match(roadmap, /Capsules declare bounded `teams\.appRoles`/);
  assert.match(roadmap, /exact-Team admins atomically reconcile membership-scoped assignments/);
  assert.match(roadmap, /singleton Team/);
  assert.match(roadmap, /Capsule roles[\s\S]*must not compete with membership-scoped Team application roles/);
  assert.match(roadmap, /A non-Team role model requires a distinct demonstrated use case/);
  assert.match(roadmap, /Tickets 01–10 record these delivered slices/);
  assert.match(roadmap, /ACL rules can make constrained explicit-Team membership, admin, and declared-role decisions through `ctx\.acl\.teams`/);
  assert.match(roadmap, /no current-Team state or automatic Capsule data authorization exists/);
  assert.doesNotMatch(roadmap, /\| Team ACL \| candidate \|/);
  assert.doesNotMatch(roadmap, /Team ACL remains intentionally deferred/);
  assert.doesNotMatch(roadmap, /issues\/09-declare-and-assign-membership-application-roles\.md/);
  assert.doesNotMatch(roadmap, /Team administration, Join links, application roles, and Team ACL \| candidate/);
  assert.doesNotMatch(roadmap, /\| Teams for ACL \| candidate/);
});

test("canonical role docs reserve Team application roles for Team membership", async () => {
  const [prd, context] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("CONTEXT.md"),
  ]);

  for (const document of [prd, context]) {
    assert.match(document, /must not compete with membership-scoped Team application roles/);
    assert.match(document, /distinct demonstrated use case/);
    assert.match(document, /separate\s+PRD/);
    assert.match(document, /\^\[a-z\]\[a-z0-9-\]\{0,31\}\$/);
    assert.match(document, /maximum 32 characters/i);
    assert.match(document, /`admin`[\s/,]*`member`[\s\S]*`sporades-\*`[\s\S]*reserved/i);
  }
});

test("docs describe doctor diagnostics as read-only coordination", async () => {
  const [roadmap, userGuide] = await Promise.all([
    readProjectFile("docs/ROADMAP.md"),
    readProjectFile("docs/user-guide.md"),
  ]);

  assert.match(userGuide, /## Sporades Doctor/);
  assert.match(userGuide, /sporades doctor --session dev/);
  assert.match(userGuide, /sporades doctor --session container --json/);
  assert.match(userGuide, /sporades doctor --session hosted --host personal --subname team-notes --json/);
  assert.match(userGuide, /sporades doctor --strict --json/);
  assert.match(userGuide, /read-only/i);
  assert.match(userGuide, /does not repair/i);
  assert.match(userGuide, /does not mutate/i);

  for (const command of [
    "sporades security",
    "sporades env",
    "sporades deploy ssh",
    "sporades host health",
    "sporades host stats",
    "sporades host logs",
    "sporades host ssh",
  ]) {
    assert.match(userGuide, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(userGuide, /pass/);
  assert.match(userGuide, /warn/);
  assert.match(userGuide, /fail/);
  assert.match(userGuide, /skip/);
  assert.match(userGuide, /CI/);
  assert.match(userGuide, /AFK agents/);
  assert.match(userGuide, /private keys/i);
  assert.match(userGuide, /full Server env values/i);
  assert.match(userGuide, /full SSH public-key material/i);
  assert.doesNotMatch(userGuide, /sporades doctor repair/);
  assert.doesNotMatch(userGuide, /sporades doctor fix/);

  assert.match(roadmap, /Sporades doctor \| implemented/);
  assert.doesNotMatch(roadmap, /`sporades doctor` \| ready/);
});

test("user guide documents Capsule service reset without blanket Runtime deletion", async () => {
  const userGuide = await readProjectFile("docs/user-guide.md");

  assert.match(userGuide, /sporades dev status --json/);
  assert.match(userGuide, /sporades deploy reset --json/);
  assert.match(userGuide, /does not remove\s+shared third-party service images/);
  assert.doesNotMatch(userGuide, /rm -rf \.sporades/);
});

test("canonical docs describe deferred Hosted Capsule service orchestration contract", async () => {
  const [prd, userGuide, architecture] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/architecture.md"),
  ]);

  assert.match(prd, /first Docker Compose Capsule\s+service implementation is local-only/i);
  assert.match(userGuide, /Hosted Capsule service orchestration is deferred/i);
  assert.match(architecture, /Hosted Capsule service orchestration contract/i);

  for (const required of [
    "service lifecycle",
    "networking",
    "persistence",
    "backup",
    "reset",
    "inspection",
    "failure recovery",
  ]) {
    assert.match(architecture, new RegExp(required, "i"));
  }

  assert.match(architecture, /sporades host/i);
  assert.match(architecture, /new top-level service\s+namespace/i);
  assert.match(architecture, /Portainer/i);
});

test("docs describe MinIO storage services and File reference boundaries", async () => {
  const [prd, userGuide, architecture, runtimeLayout, readme, uploadAdr, fileReferenceAdr, roadmap] = await Promise.all([
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/architecture.md"),
    readProjectFile("docs/runtime-layout.md"),
    readProjectFile("README.md"),
    readProjectFile("docs/adr/0013-high-level-upload-call.md"),
    readProjectFile("docs/adr/0024-file-operations-accept-file-references.md"),
    readProjectFile("docs/ROADMAP.md"),
  ]);

  for (const contents of [prd, userGuide]) {
    assert.match(contents, /"storage":\s*\{\s*"kind": "storage",\s*"engine": "minio"\s*\}/);
    assert.match(contents, /Local filesystem (?:file )?storage remains the default/i);
    assert.match(contents, /files\.storagePath` configures only .*local filesystem/i);
    assert.match(contents, /server-only .*connection env/i);
    assert.match(contents, /must\s+not appear in client bundles or app\s+authoring APIs/i);
  }

  assert.match(userGuide, /path: "\/photos\/profile\.jpg"/);
  assert.match(userGuide, /const defaultBucketFile = await files\.upload\(selectedFile\)/);
  assert.match(userGuide, /Omitting `path`\s+uses the uploaded file name in the Default File bucket/i);
  assert.match(userGuide, /logical `\/default\/upload` File path when no file name exists/i);
  assert.match(userGuide, /Ownership and privacy come from runtime\s+File metadata and ACL behavior, not from the Default File bucket itself/i);
  assert.match(userGuide, /File reference: either\s+the stable File ID or the absolute File path/i);
  assert.match(userGuide, /not a\s+runtime URL, filesystem path, object key, or Object bucket location/i);
  assert.match(userGuide, /not presigned MinIO, S3, or\s+filesystem URLs/i);
  assert.match(userGuide, /File version for cache busting/i);
  assert.match(userGuide, /must not expose filesystem\s+locations, object keys, Object buckets, MinIO connection details, or generated\s+runtime read URLs/i);

  assert.match(prd, /Writing new bytes to an existing\s+live File path overwrites that file, preserves its File ID, and creates a new\s+File version/i);
  assert.match(prd, /Deleting a\s+file frees its File path; a later write to that path creates a new File ID/i);
  assert.match(prd, /Future AWS S3 support should be adapter and configuration wiring/i);
  assert.match(prd, /must not require changes to file runtime\s+call sites, the `files` client SDK, File metadata shape, or app\/client APIs/i);
  assert.match(prd, /Public and private file\s+URLs remain Sporades HTTP routes, not presigned MinIO or S3 URLs/i);
  assert.match(prd, /Local-only Docker Compose Capsule services for declared database and storage\s+service intent/i);
  assert.match(prd, /MinIO-backed\s+S3-compatible file byte storage/i);
  assert.match(prd, /managed\s+external storage backends such as AWS S3/i);
  assert.doesNotMatch(prd, /declared database service\s+intent, shared by Dev sessions/i);
  assert.doesNotMatch(prd, /external database support, and object-storage\s+backends/i);

  assert.match(runtimeLayout, /\.sporades\/services\/storage\//);
  assert.match(runtimeLayout, /bind mount from `\.sporades\/services\/storage\/` to\s+MinIO's `\/data`/);
  assert.match(runtimeLayout, /`files\.storagePath`\s+only changes that local adapter byte directory/i);

  assert.match(architecture, /Local filesystem storage is the default adapter/i);
  assert.match(architecture, /Declaring\s+`services\.storage` with `engine: "minio"`/i);
  assert.match(architecture, /not presigned MinIO or S3 URLs/i);
  assert.match(architecture, /Future AWS S3 support\s+should add adapter and configuration wiring only/i);

  assert.match(readme, /services\.storage\.engine: "minio"/);
  assert.match(readme, /not\s+filesystem paths or presigned MinIO\/S3 URLs/i);
  assert.match(readme, /logical `\/default\/upload` File path when no file name\s+exists/i);
  assert.match(readme, /Default File bucket is only a namespace fallback,\s+not a user bucket or policy boundary/i);
  assert.doesNotMatch(readme, /user in that user's `default` bucket/i);
  assert.doesNotMatch(readme, /\/default\/<generated-id>/i);

  assert.match(uploadAdr, /Status: Superseded in part by ADR-0024/i);
  assert.match(uploadAdr, /Default File bucket is only a\s+logical namespace fallback/i);
  assert.match(uploadAdr, /not a user bucket or policy\s+boundary/i);
  assert.match(uploadAdr, /files\.url\(fileReference\)/);
  assert.doesNotMatch(uploadAdr, /user-scoped `default` bucket/i);
  assert.match(fileReferenceAdr, /replaces the old user-scoped `default` bucket semantics/i);

  assert.match(roadmap, /Managed AWS S3 storage adapter expansion/i);
  assert.match(roadmap, /Local MinIO-backed S3-compatible file byte storage is implemented/i);
  assert.match(roadmap, /extend the existing internal Storage adapter\/config model beyond local MinIO/i);
  assert.doesNotMatch(roadmap, /S3-compatible storage plugin/i);
  assert.doesNotMatch(roadmap, /Allow uploaded bytes to live in S3-compatible object storage/i);
});

test("File reference docs define the trusted multipart ingress contract and operations", async () => {
  const contents = await readProjectFile("docs/reference/files-and-realtime.md");
  assert.match(contents, /claimAuthorities: \["capsule-principal"\]/);
  assert.match(contents, /principalNamespaces/);
  assert.match(contents, /files\.acl\.read/);
  assert.match(contents, /before reading any body bytes/i);
  assert.match(contents, /requestKeyHeader/);
  assert.match(contents, /partKeyHeader/);
  assert.match(contents, /INGRESS_AUTHORITY_DENIED/);
  assert.match(contents, /Capsule startup automatically runs a bounded, deterministic\s+cleanup batch/i);
  assert.match(contents, /There is no\s+public manual ingress-sweeper API/i);
  assert.doesNotMatch(contents, /sweepExpiredFileIngress/);
  assert.match(contents, /Local filesystem and\s+MinIO-backed/i);
  assert.match(contents, /completed receipts remain replayable/i);
  assert.match(contents, /last startxref-linked `%%EOF` to be terminal except for PDF\s+whitespace and printable comment lines/i);
  assert.match(contents, /every candidate\s+evaluated by the shell classifier is parsed before either narrow plain-data\s+allowance/i);
  assert.match(contents, /pinned GNU Bash 5\.2 builtin and reserved-word vocabulary/i);
  assert.match(contents, /bounded current `PATH` search \(at most 128 entries/i);
  assert.match(contents, /classification can therefore depend on the runtime's bounded current `PATH`\s+and filesystem/i);
  assert.doesNotMatch(contents, /pre-accepts only narrowly bounded sentence-shaped prose/i);
  assert.doesNotMatch(contents, /pasted as quoted ticket text/i);
});

test("docs describe Host-generated Sealed Server env custody and lost-key recovery", async () => {
  const [userGuide, architecture, runtimeLayout] = await Promise.all([
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/architecture.md"),
    readProjectFile("docs/runtime-layout.md"),
  ]);

  assert.match(userGuide, /Host private keys never leave the Host server/);
  assert.match(userGuide, /plaintext values never cross the local-to-Host boundary/);
  assert.match(userGuide, /old Host-encrypted envelopes are\s+unrecoverable without that private key/);
  assert.match(userGuide, /sporades host rotate-key/);
  assert.doesNotMatch(userGuide, /sends\s+the matching private key/i);
  assert.doesNotMatch(userGuide, /Host-profile private keys are stored in local\s+Host profile configuration/i);

  assert.match(architecture, /CLI reads public keys and fingerprints, not Host private keys/);
  assert.match(architecture, /re-seal from source-of-truth values/);
  assert.match(runtimeLayout, /inspection reports key fingerprints and availability status without exposing\s+private key material/);
});

test("Host deploy smoke docs import legacy Server env before pushing", async () => {
  const [serverInstallation, hostProvisioning] = await Promise.all([
    readProjectFile("docs/server-installation.md"),
    readProjectFile("docs/agents/host-provisioning.md"),
  ]);

  for (const contents of [serverInstallation, hostProvisioning]) {
    assert.match(contents, /if \[ -f \.\/client_secret_google\.json \]; then\s+sporades auth set google --client-json \.\/client_secret_google\.json --json\s+fi/);
    assert.match(contents, /if \[ -f \.\/\.env\.sporades\.server \]; then\s+sporades env import --file \.env\.sporades\.server --json\s+fi/);
    assert.match(contents, /sporades auth set google --client-json \.\/client_secret_google\.json --json/);
    assert.match(contents, /sporades env import --file \.env\.sporades\.server --json/);
    assert.match(contents, /legacy Server env\s+files?\s+(?:are|is) not pushed directly/i);

    const importIndex = contents.indexOf("sporades env import --file .env.sporades.server --json");
    const pushIndex = contents.indexOf("sporades host push");
    assert(importIndex !== -1);
    assert(pushIndex !== -1);
    assert(importIndex < pushIndex);
  }
});

test("canonical docs publish the bounded Access-key operator surface", async () => {
  const [context, prd, serverReference, api, guide, architecture, navigation, userGuide, roadmap] = await Promise.all([
    readProjectFile("CONTEXT.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("docs/reference/server-runtime.md"),
    readProjectFile("docs/api/types/server.PrivilegedAccessKeysApi.html"),
    readProjectFile("docs/guide/auth.md"),
    readProjectFile("docs/architecture.md"),
    readProjectFile("docs/.vitepress/config.mts"),
    readProjectFile("docs/user-guide.md"),
    readProjectFile("docs/ROADMAP.md"),
  ]);
  for (const contents of [context, prd, serverReference]) {
    assert.match(contents, /running (?:Dev, Container, or Hosted )?Capsule/i);
    assert.match(contents, /cannot issue, rotate, or receive bearer/i);
    assert.match(contents, /--yes/);
    assert.match(contents, /--json.*(?:never|does not).*consent/is);
  }
  assert.match(serverReference, /sporades access-keys revoke-all --user-id/);
  assert.match(serverReference, /Stopped Capsules are rejected/);
  assert.match(api, /revokeAll/);
  assert.doesNotMatch(api, />issue</);
  assert.doesNotMatch(api, />rotate</);
  assert.match(navigation, /Access keys[\s\S]*\/guide\/auth#access-keys-for-named-api-access/);
  assert.match(userGuide, /Give automation scoped Access keys/);
  assert.match(roadmap, /User-owned scoped Access keys \| implemented/);
  assert.match(guide, /account:[\s\S]*body: \{ userId: ctx\.auth\.userId \}/);
  assert.match(guide, /importedRows:[\s\S]*body: \{ userId: ctx\.auth\.userId, access: ctx\.credential\.name \}/);
  for (const contents of [guide, architecture]) {
    assert.match(contents, /do(?:es)? not create|without creating/i);
    assert.match(contents, /ctx\.credential/);
    assert.match(contents, /never|not recoverable/i);
  }
});

test("canonical docs publish first-class Service Users without weakening application authority", async () => {
  const [context, prd, readme, serverReference, decision, declarations] = await Promise.all([
    readProjectFile("CONTEXT.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("README.md"),
    readProjectFile("docs/reference/server-runtime.md"),
    readProjectFile("docs/adr/0051-service-users-are-first-class-runtime-principals.md"),
    readProjectFile("src/types/server.d.ts"),
  ]);
  const canonical = [context, prd, readme, serverReference, decision].join("\n");
  for (const required of [
    "ctx.serviceUsers", "userKind", "Service User", "human Session",
    "no email", "OAuth", "browser Session", "plaintext", "irreversible",
    "Team membership", "resource policy", "intersection", "external secret store",
  ]) assert.match(canonical, new RegExp(required, "i"));
  assert.match(serverReference, /Only a Mutation[\s\S]*ctx\.serviceUsers/);
  assert.match(serverReference, /transaction is a storage mechanism, not authority/i);
  assert.match(serverReference, /Queries[\s\S]*Custom endpoints cannot manage Service Users/);
  assert.match(decision, /Keep a human-owned Access key[\s\S]*inherit their identity/);
  assert.match(declarations, /export type ServiceUsersApi/);
  assert.match(declarations, /serviceUsers: ServiceUsersApi/);
  assert.match(declarations, /userKind\?: "service"/);
  assert.doesNotMatch(declarations.match(/export type PrivilegedContext[\s\S]*?};/)?.[0] ?? "", /serviceUsers: ServiceUsersApi/);
});

test("public docs agree on narrow Checkout, Customer Portal, callback admission, and Stripe event policy interfaces", async () => {
  const [context, prd, readme, projects, server, blankGuide, apiModule, apiCheckoutInput, apiPortalInput, apiWebhookInput, apiVerifiedEvent, apiStripeEvent, apiStripeEventHandler] = await Promise.all([
    readProjectFile("CONTEXT.md"),
    readProjectFile("docs/PRD.md"),
    readProjectFile("README.md"),
    readProjectFile("docs/reference/projects-and-configuration.md"),
    readProjectFile("docs/reference/server-runtime.md"),
    readProjectFile("docs/guide/projects.md"),
    readProjectFile("docs/api/modules/stripe.html"),
    readProjectFile("docs/api/types/stripe.StripeCheckoutSessionInput.html"),
    readProjectFile("docs/api/types/stripe.StripeCustomerPortalSessionInput.html"),
    readProjectFile("docs/api/types/stripe.StripeWebhookVerificationInput.html"),
    readProjectFile("docs/api/types/stripe.VerifiedStripeEvent.html"),
    readProjectFile("docs/api/functions/server.stripeEvent.html"),
    readProjectFile("docs/api/types/server.StripeEventHandler.html"),
  ]);

  for (const contents of [context, prd, readme, projects, server, blankGuide]) {
    assert.match(contents, /built-in[\s\S]{0,160}(?:disabled|dormant)|dormant[\s\S]{0,160}(?:Stripe|payment foundation)/i);
  }
  assert.match(projects, /payments[\s\S]{0,80}stripe[\s\S]{0,80}enabled[\s\S]{0,80}false/i);
  assert.match(projects, /Existing Capsules[\s\S]{0,120}retain their current behavior/i);
  assert.match(projects, /authorizeStripeCheckout/);
  assert.match(projects, /idempotency/i);
  assert.match(projects, /Anonymous Checkout remains off by default/i);
  assert.match(projects, /(?:one-time|`payment`)/i);
  assert.match(projects, /subscription/i);
  assert.match(projects, /verified events[\s\S]{0,120}Capsule policy/i);
  assert.match(projects, /authorizeStripeCustomerPortal/);
  assert.match(projects, /resolveStripeCustomerForPortal/);
  assert.match(projects, /payment\s+methods[\s\S]{0,120}invoices[\s\S]{0,120}cancellations/i);
  assert.match(context, /Customer Portal Session/);
  assert.match(context, /Capsule-owned Customer resolver/);
  assert.match(projects, /Job repeats policy admission[\s\S]{0,160}Customer resolution/);
  assert.match(projects, /exact bounded request bytes[\s\S]{0,160}Stripe-Signature/i);
  assert.match(projects, /URL parsing must preserve the path exactly[\s\S]{0,120}percent-encoded/i);
  assert.match(projects, /idempotent Privileged[\s\S]{0,120}before the route returns `200`/i);
  assert.match(projects, /retained Capsule database[\s\S]{0,120}configured Capsule name[\s\S]{0,120}rename and restart/i);
  assert.match(context, /Verified Stripe event/);
  assert.match(context, /grants no user, Session, Team, Capsule role, or browser authority/);
  assert.match(context, /Stripe-event subscription/);
  assert.match(context, /stripeEvents:\s*stripeEvent/);
  assert.match(prd, /durable Job[\s\S]{0,180}single[\s\S]{0,80}stripeEvents:\s*stripeEvent/i);
  assert.match(prd, /started[\s\S]{0,80}(?:completed|errored)[\s\S]{0,80}finished/);
  assert.match(projects, /paymentStripeEvents/);
  assert.match(projects, /idempotent[\s\S]{0,120}order-independent/i);
  assert.match(projects, /later-arriving older event/i);
  assert.match(projects, /unknown event types[\s\S]{0,120}ignore/i);
  assert.match(projects, /raw provider value[\s\S]{0,160}(?:log|persist)/i);
  assert.match(projects, /npm pack --json[\s\S]{0,200}(?:integrity|shasum)/i);
  assert.match(projects, /packed candidate[\s\S]{0,200}consumer artifact/i);
  assert.match(projects, /does not[\s\S]{0,80}(?:publish|activate)/i);
  assert.match(server, /Stripe event handler[\s\S]{0,160}Privileged server role/i);
  assert.match(server, /no[\s\S]{0,100}(?:subscription|entitlement)[\s\S]{0,100}automatically/i);
  assert.match(server, /operator Job[\s\S]{0,30}inspection[\s\S]{0,120}(?:omits|does not expose)[\s\S]{0,80}payload/i);
  assert.match(server, /STRIPE_PAYMENTS_DISABLED/);
  assert.match(server, /does not expose a[\s\S]{0,80}generic provider request/i);
  assert.match(server, /checkout\.stripe\.com/);
  assert.match(server, /payment[\s\S]{0,80}subscription[\s\S]{0,80}mode/i);
  assert.match(server, /non-retryable/i);
  assert.match(server, /billing\.stripe\.com/);
  assert.match(server, /cannot enqueue the reserved handler by name[\s\S]{0,160}ctx\.privileged\.run/i);
  assert.match(apiModule, /createStripePaymentIntegration/);
  assert.match(apiModule, /StripePaymentsDisabledResult/);
  assert.match(apiModule, /StripeCheckoutSessionInput/);
  assert.match(apiModule, /StripeCustomerPortalSessionInput/);
  assert.match(apiModule, /StripeWebhookVerificationInput/);
  assert.match(apiModule, /VerifiedStripeEvent/);
  assert.match(apiCheckoutInput, /mode/);
  assert.match(apiCheckoutInput, /payment/);
  assert.match(apiCheckoutInput, /subscription/);
  assert.match(apiPortalInput, /customerId/);
  assert.match(apiPortalInput, /returnPath/);
  assert.match(apiPortalInput, /idempotencyKey/);
  assert.match(apiWebhookInput, /bodyBytes/);
  assert.match(apiWebhookInput, /signature/);
  assert.match(apiVerifiedEvent, /providerEventId/);
  assert.match(apiVerifiedEvent, /occurredAt/);
  assert.match(apiVerifiedEvent, /objectId/);
  assert.match(apiVerifiedEvent, /raw/);
  assert.match(apiStripeEvent, /single verified Stripe-event subscription/);
  assert.match(apiStripeEventHandler, /VerifiedStripeEvent/);
  assert.match(apiStripeEventHandler, /PrivilegedContext/);
});
