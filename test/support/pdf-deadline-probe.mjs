import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { mock } from "node:test";

const { bytes: encodedBytes, timeouts, wallClock, expiryMode } = JSON.parse(process.argv[2]);
const bytes = Buffer.from(encodedBytes, "base64");
const actualWallNow = Date.now;
const wallOrigin = actualWallNow();
let wallReads = 0;
Date.now = wallClock === "frozen" ? () => wallOrigin
  : wallClock === "backward" ? () => wallOrigin - (++wallReads * 1_000_000_000)
  : () => wallOrigin + (++wallReads * 1_000_000_000);

// Gate the real cold import, rather than assuming it takes more than 1 ms or
// finishes (including worker startup) within 2 s on a loaded machine. Only the
// deadline clock/timer is controlled; PDF.js and pdf-lib still inspect real bytes.
let releaseImport;
let importStarted;
let lazyImports = 0;
const started = new Promise(resolve => { importStarted = resolve; });
const gate = new Promise(resolve => { releaseImport = resolve; });
globalThis.__pdfDeadlineProbe = { gate, started() { lazyImports += 1; importStarted(); } };
const actualPdfJsUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const gatedModuleUrl = `data:text/javascript,${encodeURIComponent(`
globalThis.__pdfDeadlineProbe.started();
await globalThis.__pdfDeadlineProbe.gate;
const pdfjs = await import(${JSON.stringify(actualPdfJsUrl)});
export const getDocument = pdfjs.getDocument;
`)}`;
// Use the same isolated generated-runtime seam as the transient-import test.
// Keeping the copy beside dist dependencies also supports Node 22.13, which
// predates synchronous module-loader hooks. Each probe owns and removes its copy.
const runtimeUrl = new URL(`../../dist/.pdf-deadline-runtime-${randomUUID()}.mjs`, import.meta.url);

try {
  const source = await readFile(new URL("../../dist/file-ingress-runtime.js", import.meta.url), "utf8");
  const importExpression = 'import("pdfjs-dist/legacy/build/pdf.mjs")';
  assert.ok(source.includes(importExpression), "generated runtime must retain the lazy PDF.js import seam");
  await writeFile(runtimeUrl, source.replace(importExpression, `import(${JSON.stringify(gatedModuleUrl)})`));
  const { validatePdfIngress } = await import(runtimeUrl.href);
  mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0n;
  let importHooks = 0;
  let expiredHooks = 0;
  const pending = timeouts.map(timeoutMs => validatePdfIngress(bytes, {
    timeoutMs,
    monotonicNow: () => now,
    beforePdfJsImport() { importHooks += 1; },
    beforeOperatorList() { expiredHooks += 1; },
  }));
  await started;
  now = 1_000_000n;
  // Exercise both timer cancellation while loading and the post-load monotonic
  // checkpoint when a timer has not run yet. No real-time sleep decides expiry.
  let expiredBeforeRelease = [];
  if (expiryMode === "timer") {
    mock.timers.tick(1);
    expiredBeforeRelease = await Promise.all(pending.filter((_result, index) => timeouts[index] === 1));
  }
  releaseImport();
  const results = await Promise.all(pending);
  let retryHooks = 0;
  const retry = await validatePdfIngress(bytes, {
    timeoutMs: 2000,
    monotonicNow: () => now,
    beforeOperatorList() { retryHooks += 1; },
  });
  console.log(JSON.stringify({ results, expiredBeforeRelease, expiredHooks, importHooks, lazyImports, retry, retryHooks }));
} finally {
  mock.timers.reset();
  Date.now = actualWallNow;
  delete globalThis.__pdfDeadlineProbe;
  await rm(runtimeUrl, { force: true });
}
