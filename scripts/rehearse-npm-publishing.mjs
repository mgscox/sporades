// Optional, isolated service rehearsal. Install verdaccio@7.0.2 in a temporary
// prefix, then pass that prefix as argv[2]. No public registry writes or OIDC.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { publishNpmRelease } from "./publish-npm-release.mjs";
import { parseNpmPackJson } from "./npm-pack-json.mjs";

const prefix = path.resolve(process.argv[2]);
const require = createRequire(path.join(prefix, "package.json"));
assert.equal(JSON.parse(await readFile(path.join(prefix, "node_modules/verdaccio/package.json"), "utf8")).version, "7.0.2");
const { runServer } = require("verdaccio");
const exec = promisify(execFile);
const dir = await mkdtemp(path.join(tmpdir(), "sporades-registry-rehearsal-"));
let server;
try {
  const configFile = path.join(dir, "config.yaml");
  await writeFile(configFile, `storage: ${dir}/storage\nauth:\n  htpasswd:\n    file: ${dir}/htpasswd\nuplinks: {}\npackages:\n  sporades:\n    access: $all\n    publish: $authenticated\nlog: {type: stdout, format: json, level: fatal}\n`);
  const app = await runServer(configFile);
  server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const registry = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, NPM_CONFIG_USERCONFIG: path.join(dir, "npmrc"), NPM_CONFIG_CACHE: path.join(dir, "cache") };
  for (const key of Object.keys(env)) if (/^(?:NODE_AUTH_TOKEN|NPM_TOKEN|npm_config_.*auth.*)$/i.test(key)) delete env[key];
  await writeFile(env.NPM_CONFIG_USERCONFIG, "");
  const npm = args => exec("npm", args, { cwd: dir, env, maxBuffer: 10 * 1024 * 1024 });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "sporades", version: "99.0.0", files: ["index.js"] }));
  await writeFile(path.join(dir, "index.js"), "export const synthetic = true;\n");
  const pack = (await npm(["pack", "--json", "--ignore-scripts"])).stdout;
  const [artifact] = parseNpmPackJson(pack);
  const args = ["publish", `./${artifact.filename}`, "--access", "public", "--ignore-scripts", "--provenance=false", `--registry=${registry}`, "--fetch-retries=0"];
  await assert.rejects(npm(args), error => /ENEEDAUTH|E401/.test(error.stderr));
  assert.equal((await fetch(`${registry}/sporades`)).status, 404);
  const registration = await fetch(`${registry}/-/user/org.couchdb.user:rehearsal`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "rehearsal", password: "synthetic-local-only-password", email: "rehearsal@example.test", type: "user", roles: [] }),
  });
  assert.equal(registration.status, 201);
  const { token } = await registration.json();
  await writeFile(env.NPM_CONFIG_USERCONFIG, `//127.0.0.1:${server.address().port}/:_authToken=${token}\n`, { mode: 0o600 });
  // Run the actual publication orchestration; only redirect its endpoint and
  // disable provenance, which requires real GitHub OIDC and cannot be emulated.
  const run = args => npm(args.map(arg => arg.startsWith("--registry=") ? `--registry=${registry}` : arg === "--provenance" ? "--provenance=false" : arg));
  assert.equal(await publishNpmRelease("v99.0.0", pack, { run }), "published");
  const metadata = await (await fetch(`${registry}/sporades`)).json();
  assert.deepEqual(Object.keys(metadata.versions), ["99.0.0"]);
  assert.equal(metadata.versions["99.0.0"].dist.integrity, artifact.integrity);
  const downloaded = Buffer.from(await (await fetch(metadata.versions["99.0.0"].dist.tarball)).arrayBuffer());
  assert.deepEqual(downloaded, await readFile(path.join(dir, artifact.filename)));
  await assert.rejects(npm(args), error => /EPUBLISHCONFLICT|E409|E403|cannot publish over/i.test(error.stderr));
  await assert.rejects(publishNpmRelease("v99.0.0", pack, { run }), /provenance/);
  assert.deepEqual(Object.keys((await (await fetch(`${registry}/sporades`)).json()).versions), ["99.0.0"]);
  console.log("PASS: denied anonymous publish, authenticated publish/read/download, duplicate rejection, and fail-closed retry without provenance. GitHub OIDC remains unverified.");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
