import { createBundle as createProjectBundle } from "./bundle-pipeline.js";
import type { BundleConfig, BundleResult } from "../src/types/build.js";

export type { BundleConfig, BundleResult } from "../src/types/build.js";

export function createBundle(projectDir: string, config: BundleConfig): Promise<BundleResult> {
  return createProjectBundle(projectDir, config);
}
