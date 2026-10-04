import { inspectAdmissionHealth } from "../admission-evidence.js";
// Executed inside the already-bound container. The probe capability stays in its env.
export const ADMISSION_INSPECTION_SCRIPT = String.raw `const admissionInspection = true;
try {
  const response = await fetch("http://127.0.0.1:4000/__sporades/health/runtime", {
    headers: { "x-sporades-host-probe": process.env.SPORADES_RUNTIME_PROBE_TOKEN || "" }, signal: AbortSignal.timeout(1000), redirect: "error"
  });
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length;
    if (bytes > 65536) { await reader.cancel(); throw new Error(); } chunks.push(Buffer.from(chunk.value)); }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(JSON.stringify({ admissionPolicy: body?.data?.runtime?.admissionPolicy ?? null }));
} catch { process.stdout.write(JSON.stringify({ admissionPolicy: null })); }`;
export async function readAdmissionInspection(response) {
    const reader = response.body?.getReader();
    if (!reader)
        return null;
    const chunks = [];
    let bytes = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            bytes += chunk.value.length;
            if (bytes > 65_536) {
                await reader.cancel();
                return null;
            }
            chunks.push(Buffer.from(chunk.value));
        }
        return inspectAdmissionHealth(JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data?.runtime?.admissionPolicy);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=admission-inspection.js.map