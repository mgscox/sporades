import { readFile } from "node:fs/promises";
import { createStripeTeamBillingFake } from "../testing/stripe.js";
/** Standalone local test harness; does not resolve Capsule or Host configuration. */
export async function runStripeFake(args) {
    let cataloguePath;
    let target;
    let port = 0;
    let json = false;
    let stdin = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--json")
            json = true;
        else if (arg === "--webhook-secret-stdin")
            stdin = true;
        else if (["--catalogue", "--webhook-target", "--port"].includes(arg)) {
            const value = args[++index];
            if (!value || value.startsWith("--"))
                throw new Error(`Missing ${arg} value.`);
            if (arg === "--catalogue")
                cataloguePath = value;
            else if (arg === "--webhook-target")
                target = value;
            else {
                if (!/^\d+$/.test(value))
                    throw new Error("Invalid fake port.");
                port = Number(value);
            }
        }
        else
            throw new Error(`Unknown stripe-fake option: ${arg}`);
    }
    if (!cataloguePath || !target || !stdin)
        throw new Error("stripe-fake requires --catalogue, --webhook-target and --webhook-secret-stdin.");
    if (process.stdin.isTTY)
        throw new Error("Pipe the fixture webhook secret to stdin.");
    let secret = "";
    for await (const chunk of process.stdin) {
        secret += chunk.toString();
        if (secret.length > 4096)
            throw new Error("Fixture webhook secret is too long.");
    }
    const fake = await createStripeTeamBillingFake({ catalogue: JSON.parse(await readFile(cataloguePath, "utf8")),
        webhookTarget: target, webhookSecret: secret.trim(), port });
    const data = { origin: fake.origin, controlOrigin: fake.controlOrigin };
    process.stdout.write(json ? `${JSON.stringify({ ok: true, data, error: null })}\n` : `Stripe fake: ${fake.origin}\nControl: ${fake.controlOrigin}\n`);
    await new Promise((resolve) => {
        const stop = () => { void fake.close().finally(() => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); }); };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
}
//# sourceMappingURL=stripe-fake.js.map