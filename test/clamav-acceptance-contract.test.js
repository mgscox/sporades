import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("real ClamAV acceptance probes use the exact runtime-owned 256-bit credential", async () => {
  const [containerSource, devSource] = await Promise.all([
    readFile(new URL("./fixtures/clamav-runtime-smoke.mjs", import.meta.url), "utf8"),
    readFile(new URL("./clamav-dev.acceptance.test.js", import.meta.url), "utf8"),
  ]);

  assert.match(containerSource, /randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(containerSource, /database\.runtimeProbeToken = runtimeProbeToken/);
  assert.match(containerSource, /"x-sporades-host-probe": runtimeProbeToken/);
  assert.doesNotMatch(containerSource, /"x-sporades-host-probe": "acceptance"/);

  assert.match(devSource, /dev-session\.json/);
  assert.match(devSource, /assert\.match\(runtimeProbeToken, \/\^\[a-f0-9\]\{64\}\$\//);
  assert.match(devSource, /waitHealthy\(url, runtimeProbeToken\)/);
  assert.match(devSource, /"x-sporades-host-probe": runtimeProbeToken/);
  assert.doesNotMatch(devSource, /"x-sporades-host-probe": "dev-clamav-acceptance"/);
});
