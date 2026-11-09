/** Parsed sporades.json configuration, validated by the Bundle pipeline. */
export type BundleConfig = Record<string, unknown>;

/** Supported output for copying a Capsule into a container build context. */
export type BundleResult = {
  paths: {
    /** Absolute path to the published, self-contained server Bundle. */
    serverBundle: string;
  };
  staticFiles: {
    /** Absolute path to the normalized public tree, including index.html. */
    publicDir: string;
  };
  /** Call in a finally block after copying the Bundle's public tree. */
  releasePublicTreeLease(): Promise<void>;
};

/**
 * Build a Capsule with the standard Bundle pipeline and publish its output in
 * <projectDir>/.sporades/build. This is a Node.js build-time API; it does not
 * start a Container session. Pass an absolute project directory and the parsed
 * sporades.json configuration. Always release the public-tree lease in finally.
 */
export declare function createBundle(projectDir: string, config: BundleConfig): Promise<BundleResult>;
