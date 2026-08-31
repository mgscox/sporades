import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the packed package exposes the complete server and client Access-key contract", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-packed-access-keys-"));
  try {
    const packed = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], {
      cwd: repoRoot,
      env: { ...process.env, npm_config_cache: path.join(dir, "npm-cache") },
    });
    const [{ filename }] = JSON.parse(packed.stdout);
    const modules = path.join(dir, "consumer", "node_modules");
    await mkdir(modules, { recursive: true });
    await run("tar", ["-xzf", path.join(dir, filename), "-C", modules]);
    await rename(path.join(modules, "package"), path.join(modules, "sporades"));
    await writeFile(path.join(dir, "consumer", "package.json"), JSON.stringify({ type: "module" }));
    const packedClientTypes = await readFile(path.join(modules, "sporades", "src", "types", "client.d.ts"), "utf8");
    const packedServerTypes = await readFile(path.join(modules, "sporades", "src", "types", "server.d.ts"), "utf8");
    assert.match(packedClientTypes, /AccessKeyErrorCode[\s\S]*"TRANSPORT_CLOSED"/);
    assert.match(packedClientTypes, /AccessKeyRevocationCause[\s\S]*"service-user-administrator"[\s\S]*"service-user-disabled"/);
    assert.match(packedServerTypes, /@deprecated Use requireUserAuth/);
    assert.match(packedServerTypes, /CredentialProvenance/);
    assert.match(packedServerTypes, /PrivilegedAccessKeysApi/);
    const probe = path.join(dir, "consumer", "probe.mjs");
    await writeFile(probe, [
      'import { accessKeys } from "sporades/client";',
      'import { requireAuth, requireUserAuth } from "sporades/server";',
      'const names = Object.keys(accessKeys).sort();',
      'if (JSON.stringify(names) !== JSON.stringify(["delete", "issue", "list", "revoke", "rotate"])) process.exit(1);',
      'if (typeof requireAuth !== "function" || typeof requireUserAuth !== "function") process.exit(2);',
    ].join("\n"));
    const result = await run(process.execPath, [probe]);
    assert.equal(result.stderr, "");
    const typeProbe = path.join(dir, "consumer", "probe.ts");
    await writeFile(typeProbe, `
import { endpoint, requireAuth, requireUserAuth, type AccessKeyRevocationCause, type AccessKeyStatus,
  type CredentialProvenance } from "sporades/server";
import { accessKeys, type AccessKeySummary, type AccessKeyErrorCode,
  type AccessKeyRevocationCause as ClientAccessKeyRevocationCause } from "sporades/client";
endpoint({ method: "GET", path: "/probe" }, requireAuth({ credentials: ["access-key"] as const, scopes: ["requests:read"] },
  (ctx) => { const kind: "access-key" = ctx.credential.kind; return { kind, path: ctx.request.path }; }));
declare const inlineContext: { auth: Parameters<typeof requireUserAuth>[0]["auth"] };
requireUserAuth(inlineContext);
requireAuth(inlineContext);
const status: AccessKeyStatus = "active";
const cause: AccessKeyRevocationCause = "operator";
const administratorCause: ClientAccessKeyRevocationCause = "service-user-administrator";
const disabledCause: AccessKeySummary["revocationCause"] = "service-user-disabled";
// @ts-expect-error unknown revocation causes must remain rejected by the public client contract
const unknownCause: AccessKeySummary["revocationCause"] = "invented-service-user-cause";
const provenance: CredentialProvenance = { kind: "access-key", id: "key-id", name: "automation" };
const futureSafeCode: string = "FUTURE_CODE" satisfies string;
const knownCode: AccessKeyErrorCode = "TRANSPORT_CLOSED";
const list: Promise<unknown> = accessKeys.list({ status });
declare const summary: AccessKeySummary;
void [cause, administratorCause, disabledCause, unknownCause, provenance, futureSafeCode, knownCode, list, summary];
`);
    await run(process.execPath, [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict",
      "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", typeProbe], {
      cwd: path.join(dir, "consumer"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
