import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";
const execute = promisify(execFile);
// Runs inside the Capsule: the token never crosses stdout or leaves the Host.
const probe = `try {
  const response = await fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/__sporades/health/runtime', { headers: { 'x-sporades-host-probe': process.env.SPORADES_RUNTIME_PROBE_TOKEN || '' }, signal: AbortSignal.timeout(1000) });
  const body = await response.json();
  process.stdout.write(response.status === 200 && body?.ok === true && body?.data?.runtime?.ready === true ? '1' : '0');
} catch { process.stdout.write('0'); }`;
/** Bounded, best-effort local readiness reporting on the existing private relay.
 * This is called only by the background inventory worker, never by a request or
 * Capsule lifecycle path. No runtime readiness detail or credential is emitted.
 */
export async function reportHostAvailability(input, relayPort = 4318) {
    try {
        const { stdout } = await execute("docker", ["inspect", "--format", "{{json .}}", "sporades-telemetry-relay"], { timeout: 1000, maxBuffer: 1024 * 1024 });
        const relay = JSON.parse(stdout);
        if (relay.Config?.Labels?.["com.sporades.host-telemetry-relay"] !== "true")
            return false;
        const address = relay.NetworkSettings?.Networks?.[input.network]?.IPAddress;
        if (isIP(address) !== 4)
            return false;
        const started = Date.now();
        const timeUnixNano = String(BigInt(started) * 1000000n);
        const attribute = (key, value) => ({ key, value: { stringValue: value } });
        const dataPoints = [];
        const active = input.capsules.filter(capsule => ["running", "failed"].includes(capsule.state));
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(4, active.length) }, async () => {
            while (index < active.length && Date.now() - started < 20_000) {
                const capsule = active[index++];
                const [domain, subname] = capsule.id.split("/");
                const name = `sporades-${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${subname}`;
                let ready = "0";
                try {
                    const result = await execute("docker", ["exec", name, "node", "--input-type=module", "--eval", probe], { timeout: 1750, maxBuffer: 1024 });
                    if (result.stdout === "1")
                        ready = "1";
                }
                catch { /* Missing, stopped or unresponsive process is unready. */ }
                dataPoints.push({ timeUnixNano, asInt: ready, attributes: [attribute("host", input.host), attribute("service.name", capsule.id)] });
            }
        }));
        const metrics = [
            { name: "sporades.host.relay.contact", gauge: { dataPoints: [{ timeUnixNano, asInt: "1", attributes: [attribute("host", input.host)] }] } },
            { name: "sporades.capsule.local.ready", gauge: { dataPoints } },
        ];
        const response = await fetch(`http://${address}:${relayPort}/v1/metrics`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ scope: { name: "sporades.host.availability" }, metrics }] }] }), signal: AbortSignal.timeout(1500) });
        await response.body?.cancel();
        return response.ok;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=host-availability.js.map