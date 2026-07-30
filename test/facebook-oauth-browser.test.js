import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const enabled = process.env.SPORADES_REAL_FACEBOOK_BROWSER === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stdout}\n${stderr}`)));
  });
}

function waitForStarted(child) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Dev start timed out: ${stderr}`)), 15_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const payload = JSON.parse(line);
          if (payload.data?.event === "started") {
            clearTimeout(timeout);
            resolve(payload.data);
          }
        } catch {
          // Ignore non-protocol process output.
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Dev exited ${code}: ${stderr}`));
    });
  });
}

test("real browser clicks the generated Facebook control and performs a top-level protocol redirect", { skip: !enabled }, async () => {
  const { chromium } = await import("playwright").catch(() => {
    throw new Error("Install Playwright and its Chromium binary before running SPORADES_REAL_FACEBOOK_BROWSER=1 npm test.");
  });
  const root = await mkdtemp(path.join(tmpdir(), "sporades-facebook-browser-"));
  let dev;
  let receiver;
  let browser;
  try {
    await run(process.execPath, [
      cliPath, "create", path.join(root, "capsule"), "--framework", "react", "--template", "todo",
      "--no-install", "--no-git", "--json",
    ]);
    const projectDir = path.join(root, "capsule");
    await run("npm", ["install", "--ignore-scripts"], { cwd: projectDir });
    await run(process.execPath, [
      cliPath, "auth", "set", "facebook", "--client-id", "browser-app-id",
      "--client-secret", "browser-app-secret", "--graph-version", "v23.0", "--json",
    ], { cwd: projectDir });
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    let observedAuthorizationUrl;
    receiver = createServer((request, response) => {
      observedAuthorizationUrl = new URL(request.url, `http://${request.headers.host}`);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Facebook authorization receiver</title><h1>Authorization received</h1>");
    });
    await new Promise((resolve, reject) => {
      receiver.once("error", reject);
      receiver.listen(0, "127.0.0.1", resolve);
    });
    const receiverOrigin = `http://127.0.0.1:${receiver.address().port}`;
    dev = spawn(process.execPath, [cliPath, "dev", "--json"], {
      cwd: projectDir,
      env: {
        ...process.env,
        SPORADES_FACEBOOK_AUTH_URL: `${receiverOrigin}/v23.0/dialog/oauth`,
        SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = await waitForStarted(dev);

    const chromePath = process.env.SPORADES_FACEBOOK_BROWSER_EXECUTABLE ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const executablePath = await access(chromePath).then(() => chromePath).catch(() => undefined);
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    await page.goto(started.url);
    const control = page.getByRole("button", { name: "Sign in with Facebook" });
    await control.waitFor();
    await Promise.all([
      page.waitForURL(`${receiverOrigin}/**`),
      control.click(),
    ]);
    assert.equal(page.url(), observedAuthorizationUrl.toString());
    assert.equal(observedAuthorizationUrl.pathname, "/v23.0/dialog/oauth");
    assert.equal(observedAuthorizationUrl.searchParams.get("client_id"), "browser-app-id");
    assert.equal(observedAuthorizationUrl.searchParams.get("scope"), "public_profile,email");
    assert.equal(observedAuthorizationUrl.searchParams.get("response_type"), "code");
    assert.equal(
      observedAuthorizationUrl.searchParams.get("redirect_uri"),
      `${started.url}/__sporades/auth/facebook/callback`,
    );
    assert.match(observedAuthorizationUrl.searchParams.get("state"), /^[A-Za-z0-9_-]{40,}$/);
    assert.doesNotMatch(page.url(), /browser-app-secret|access_token/i);
    const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
    assert.doesNotMatch(clientBundle, /connect\.facebook\.net|FB\.init|browser-app-secret|access_token/i);
  } finally {
    await browser?.close();
    if (dev && dev.exitCode === null) {
      dev.kill("SIGTERM");
      await new Promise((resolve) => dev.once("exit", resolve));
    }
    if (receiver) await new Promise((resolve) => receiver.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
