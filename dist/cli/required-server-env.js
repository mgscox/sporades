import path from "node:path";
import { parseServerEnv, readServerEnvFile } from "../bundle-pipeline.js";
import { readKeyPair, readSealedServerEnv, sealedServerEnvPaths, unsealServerEnv } from "../sealed-server-env.js";
/** Same sealed-first precedence as the Bundle pipeline; process env is never Capsule env. */
export async function readRequiredServerEnvValues(projectDir, sealedOnly = false) {
    try {
        const paths = sealedServerEnvPaths(projectDir);
        const envelope = await readSealedServerEnv(paths);
        if (!envelope)
            return sealedOnly ? {} : parseServerEnv(await readServerEnvFile(path.join(projectDir, ".env.sporades.server")));
        const keys = await readKeyPair(paths);
        if (!keys)
            throw new Error("missing key");
        return unsealServerEnv(envelope, keys.privateKey);
    }
    catch {
        throw Object.assign(new Error("Required Server env values are unavailable."), {
            code: "SERVER_ENV_UNAVAILABLE",
            hint: "Restore the local Sealed Server env key and envelope, or explicitly re-import source-of-truth values with sporades env import.",
        });
    }
}
//# sourceMappingURL=required-server-env.js.map