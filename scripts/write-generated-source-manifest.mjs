import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeGeneratedSourceManifest } from "./generated-source-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await writeGeneratedSourceManifest(repoRoot);
