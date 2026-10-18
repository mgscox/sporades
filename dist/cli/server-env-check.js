import path from "node:path";
import { parseServerEnv, readServerEnvFile } from "../bundle-pipeline.js";
import { readKeyPair, readSealedServerEnv, sealedServerEnvPaths, unsealServerEnv } from "../sealed-server-env.js";
/** Same sealed-first local source as the Bundle pipeline; shell env is excluded. */
export async function readProjectServerEnv(projectDir) {
    const paths = sealedServerEnvPaths(projectDir);
    const envelope = await readSealedServerEnv(paths);
    if (!envelope)
        return parseServerEnv(await readServerEnvFile(path.join(projectDir, ".env.sporades.server")));
    const keyPair = await readKeyPair(paths);
    if (!keyPair)
        throw new Error("Sealed Server env key unavailable.");
    return unsealServerEnv(envelope, keyPair.privateKey);
}
//# sourceMappingURL=server-env-check.js.map