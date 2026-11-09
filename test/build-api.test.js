import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseNpmPackJson } from "../scripts/npm-pack-json.mjs";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));

test("the packed sporades/build API supports the container template with public types", async () => {
  const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(manifest.exports["./build"], {
    types: "./src/types/build.d.ts",
    default: "./dist/build.js",
  });
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-build-api-"));
  try {
    const packed = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], {
      cwd: repo,
      env: { ...process.env, npm_config_cache: path.join(dir, "npm-cache") },
    });
    const [{ filename }] = parseNpmPackJson(packed.stdout);
    const modules = path.join(dir, "node_modules");
    await mkdir(modules);
    await run("tar", ["-xzf", path.join(dir, filename), "-C", modules]);
    const installed = path.join(modules, "sporades");
    await rename(path.join(modules, "package"), installed);
    // Reuse installed dependencies while testing only the package's shipped files.
    await symlink(path.join(repo, "node_modules"), path.join(installed, "node_modules"), "dir");
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await mkdir(path.join(dir, "server"));
    await mkdir(path.join(dir, "client"));
    await mkdir(path.join(dir, "public"));
    await writeFile(path.join(dir, "server/index.ts"), 'import { capsule } from "sporades/server"; export default capsule({ name: "build-api", schema: {} });');
    await writeFile(path.join(dir, "client/index.ts"), 'document.body.dataset.bundle = "ready";');
    await writeFile(path.join(dir, "index.html"), '<!doctype html><html><body><script type="module" src="/client.js"></script></body></html>');
    await writeFile(path.join(dir, "public/robots.txt"), "User-agent: *\n");
    await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ name: "build-api", client: { framework: "vanilla" } }));
    await writeFile(path.join(dir, "build.mjs"), `
      import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
      import { createBundle } from "sporades/build";
      const bundle = await createBundle(process.cwd(), JSON.parse(await readFile("sporades.json", "utf8")));
      try {
        await mkdir(".sporades/container", { recursive: true });
        await writeFile(".sporades/container/server.mjs", await readFile(bundle.paths.serverBundle));
        await cp(bundle.staticFiles.publicDir, ".sporades/container/public", { recursive: true });
      } finally {
        await bundle.releasePublicTreeLease();
      }
    `);
    await run(process.execPath, ["build.mjs"], { cwd: dir });
    assert.match(await readFile(path.join(dir, ".sporades/container/server.mjs"), "utf8"), /build-api/);
    assert.match(await readFile(path.join(dir, ".sporades/container/public/index.html"), "utf8"), /client\.js/);
    assert.match(await readFile(path.join(dir, ".sporades/container/public/client.js"), "utf8"), /ready/);
    assert.equal(await readFile(path.join(dir, ".sporades/container/public/robots.txt"), "utf8"), "User-agent: *\n");
    await writeFile(path.join(dir, "build.mts"), `
      import { createBundle, type BundleConfig, type BundleResult } from "sporades/build";
      import { createBundle as generated } from "./node_modules/sporades/dist/build.js";
      const publicParity: typeof createBundle = generated;
      const generatedParity: typeof generated = createBundle;
      const config: BundleConfig = { name: "build-api", client: { framework: "vanilla" } };
      const bundle: BundleResult = await createBundle(".", config);
      const server: string = bundle.paths.serverBundle;
      const publicDir: string = bundle.staticFiles.publicDir;
      const released: void = await bundle.releasePublicTreeLease();
      // @ts-expect-error The project directory is a string.
      createBundle(123, config);
      // @ts-expect-error Internal pipeline switches are not part of this API.
      createBundle(".", config, { publishLegacy: false });
    `);
    await run(process.execPath, [path.join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "build.mts"], { cwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
