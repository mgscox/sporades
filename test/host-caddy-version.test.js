import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { MINIMUM_CADDY_VERSION, caddyVersionSupported, parseCaddyVersion } from "../dist/cli/host-caddy-version.js";
import { renderHostMetricsCaddyfile } from "../dist/cli/host-metrics.js";
import { installFakeCaddyUserCommands, installFakeDocker, runHostHelper, withTempDir } from "./support/host-fixture.js";

const host = (remoteRoot) => ({ alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot });

async function bootstrapWithCaddy(dir, version, extraEnv = {}) {
  const remoteRoot = path.join(dir, "remote-root");
  await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
  const operatorCaddyfile = "unrelated.example.dev {\n  respond \"still here\"\n}\n";
  await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), operatorCaddyfile);
  const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_NETWORK_INSPECT_STATUS: "1" } });
  const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
  const env = {
    ...docker.env,
    ...caddyUser.env,
    ...(version === undefined ? {} : { FAKE_CADDY_VERSION: version }),
    ...extraEnv,
    PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
  };
  const result = await runHostHelper({ action: "host.bootstrap", host: host(remoteRoot), capsule: null, bootstrap: {} }, { cwd: dir, env });
  return { result, remoteRoot, docker, operatorCaddyfile, env };
}

test("Caddy version parsing accepts upstream and distro output and compares against the minimum", () => {
  assert.equal(MINIMUM_CADDY_VERSION, "2.9.1");
  assert.equal(parseCaddyVersion("v2.11.9 h1:rXBDLjCDmSwYYsoPq/cSfWaPCE2ZZtXUK6KWDeuCDbc=\n"), "2.11.9");
  assert.equal(parseCaddyVersion("2.6.2\n"), "2.6.2");
  assert.equal(parseCaddyVersion("v2.10.0-beta.3 h1:abc="), "2.10.0");
  assert.equal(parseCaddyVersion("(devel)"), null);
  assert.equal(parseCaddyVersion(""), null);
  for (const version of ["2.9.1", "2.9.2", "2.10.0", "2.11.9", "3.0.0"]) assert.equal(caddyVersionSupported(version), true, version);
  for (const version of ["2.6.2", "2.8.4", "2.9.0", "1.99.99"]) assert.equal(caddyVersionSupported(version), false, version);
});

test("host bootstrap refuses the distro Caddy 2.6.2 before changing the Host", async () => {
  await withTempDir(async (dir) => {
    const { result, remoteRoot, docker, operatorCaddyfile } = await bootstrapWithCaddy(dir, "2.6.2");
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false, result.stdout);
    assert.match(output.error.message, /Caddy 2\.6\.2 is older than the minimum supported version 2\.9\.1/);
    assert.match(output.error.hint, /official Caddy apt repository/);
    assert.match(output.error.hint, /docs\/server-installation\.md/);
    assert.match(output.error.hint, /sporades host bootstrap/);
    assert.equal(await readFile(path.join(remoteRoot, "caddy", "Caddyfile"), "utf8"), operatorCaddyfile);
    assert.deepEqual(await docker.caddyCalls().catch(() => []), [], "no validate or reload against an unsupported Caddy");
    assert.deepEqual((await docker.calls().catch(() => [])).filter((call) => call.args[0] === "network" && call.args[1] === "create"), []);
  });
});

test("host bootstrap refuses a Caddy whose version cannot be determined", async () => {
  await withTempDir(async (dir) => {
    for (const [version, extraEnv] of [["(devel)", {}], ["v2.11.9", { FAKE_CADDY_VERSION_STATUS: "1" }]]) {
      const { result } = await bootstrapWithCaddy(path.join(dir, String(Object.keys(extraEnv).length)), version, extraEnv);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, false, result.stdout);
      assert.match(output.error.message, /Could not determine the installed Caddy version/);
      assert.match(output.error.hint, /2\.9\.1 or newer/);
    }
  });
});

test("host bootstrap accepts the minimum and current Caddy versions", async () => {
  await withTempDir(async (dir) => {
    for (const version of ["v2.9.1 h1:fake=", undefined]) {
      const { result } = await bootstrapWithCaddy(path.join(dir, version ? "minimum" : "current"), version);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).data.bootstrapped, true);
    }
  });
});

test("host stats reports the Caddy version and flags an outdated one without failing", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    await mkdir(remoteRoot, { recursive: true });
    const docker = await installFakeDocker(dir);
    const stats = async (env) => JSON.parse((await runHostHelper({ action: "host.stats", host: host(remoteRoot), capsule: null }, { cwd: dir, env: { ...docker.env, ...env } })).stdout);
    assert.deepEqual((await stats({})).data.services.caddy, { available: true, version: "2.11.9", minimumVersion: "2.9.1", supported: true });
    assert.deepEqual((await stats({ FAKE_CADDY_VERSION: "2.6.2" })).data.services.caddy, { available: true, version: "2.6.2", minimumVersion: "2.9.1", supported: false });
  });
});

const BEGIN = "# BEGIN Sporades Host metrics";
const END = "# END Sporades Host metrics";
const listener = `${BEGIN}\nhttp://172.30.0.1:20190 {\n bind 172.30.0.1\n metrics /metrics\n}\n${END}\n`;

test("Host metrics use the global Caddy metrics option instead of the deprecated servers option", () => {
  const site = "apps.example {\n respond \"ok\"\n}\n";
  const fresh = renderHostMetricsCaddyfile(site, "172.30.0.1");
  assert.equal(fresh, `{\n${BEGIN}\nmetrics\n${END}\n}\n${site}\n${listener}`);
  assert.doesNotMatch(fresh, /servers/);
  assert.equal(renderHostMetricsCaddyfile(fresh, "172.30.0.1"), fresh, "idempotent");

  const withOptions = renderHostMetricsCaddyfile(`{\n email ops@example.dev\n servers {\n  timeouts {\n   read_body 15s\n  }\n }\n}\n${site}`, "172.30.0.1");
  assert.equal(withOptions, `{\n email ops@example.dev\n servers {\n  timeouts {\n   read_body 15s\n  }\n }\n${BEGIN}\nmetrics\n${END}\n}\n${site}\n${listener}`);
  assert.equal(renderHostMetricsCaddyfile(withOptions, "172.30.0.1"), withOptions, "idempotent with operator options");
});

test("Host metrics migrate the legacy managed servers block and respect operator metrics options", () => {
  const site = "apps.example {\n respond \"ok\"\n}\n";
  const legacy = `{\n${BEGIN}\nservers {\n metrics\n}\n${END}\n}\n${site}\n${listener}`;
  assert.equal(renderHostMetricsCaddyfile(legacy, "172.30.0.1"), `{\n${BEGIN}\nmetrics\n${END}\n}\n${site}\n${listener}`);

  const legacyNested = `{\n servers {\n${BEGIN}\nmetrics\n${END}\n  timeouts {\n   read_body 15s\n  }\n }\n}\n${site}\n${listener}`;
  const migrated = renderHostMetricsCaddyfile(legacyNested, "172.30.0.1");
  assert.equal(migrated, `{\n servers {\n  timeouts {\n   read_body 15s\n  }\n }\n${BEGIN}\nmetrics\n${END}\n}\n${site}\n${listener}`);

  for (const operator of [`{\n metrics {\n  per_host\n }\n}\n${site}`, `{\n servers {\n  metrics\n }\n}\n${site}`]) {
    assert.equal(renderHostMetricsCaddyfile(operator, "172.30.0.1"), `${operator}\n${listener}`, "operator-owned metrics are left alone");
  }
});

test("Host metrics reconciliation refuses an outdated Caddy and preserves the Caddyfile", async (t) => {
  await mkdir(path.resolve(".sporades"), { recursive: true });
  const root = await mkdtemp(path.resolve(".sporades/host-caddy-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin); await mkdir(path.join(root, "caddy")); await mkdir(path.join(root, "telemetry"), { mode: 0o700 });
  const caddyfile = "apps.example {\n respond \"ok\"\n}\n";
  await writeFile(path.join(root, "caddy/Caddyfile"), caddyfile);
  await writeFile(path.join(bin, "docker"), `#!/bin/sh
if [ "$1" = network ] && [ "$2" = inspect ]; then
 echo '[{"Labels":{"com.sporades.host-metrics":"true"},"Internal":true,"IPAM":{"Config":[{"Gateway":"127.0.0.1"}]}}]'
elif [ "$1" = container ] && [ "$2" = inspect ]; then echo '[]'; fi
`, { mode: 0o755 });
  await writeFile(path.join(bin, "caddy"), "#!/bin/sh\nif [ \"$1\" = version ]; then echo 2.6.2; fi\n", { mode: 0o755 });
  await writeFile(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const savedPath = process.env.PATH, savedUmask = process.umask(0o022);
  process.env.PATH = bin + path.delimiter + savedPath;
  try {
    const { configureHostMetrics } = await import("../dist/cli/host-metrics.js");
    await assert.rejects(configureHostMetrics(root, "apps.example", "enable"), (error) => {
      assert.match(error.message, /Caddy 2\.6\.2 is older than the minimum supported version 2\.9\.1/);
      assert.match(error.hint, /official Caddy apt repository/);
      return true;
    });
    assert.equal(await readFile(path.join(root, "caddy/Caddyfile"), "utf8"), caddyfile);
  } finally { process.env.PATH = savedPath; process.umask(savedUmask); }
});
