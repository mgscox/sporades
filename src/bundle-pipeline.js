import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createClientRuntimeSource } from "./templates/client-runtime-template.js";
import { createServerBundleSource } from "./templates/server-bundle-template.js";

const FRAMEWORK_BUNDLE_CONFIG = {
  react: {
    jsxImportSource: "react",
    jsxRuntimeImport: "react/jsx-runtime",
  },
  preact: {
    jsxImportSource: "preact",
    jsxRuntimeImport: "preact/jsx-runtime",
  },
};

export async function createBundle(projectDir, config) {
  const frameworkBundleConfig = readFrameworkBundleConfig(config.client?.framework ?? "react");
  const buildDir = path.join(projectDir, ".sporades", "build");
  await mkdir(buildDir, { recursive: true });

  const paths = {
    config: path.join(projectDir, "sporades.json"),
    serverEntry: path.join(projectDir, "server", "index.ts"),
    clientEntry: path.join(projectDir, "client", "index.tsx"),
    indexHtml: path.join(projectDir, "index.html"),
    serverEnv: path.join(projectDir, ".env.sporades.server"),
    serverBundle: path.join(buildDir, "server.mjs"),
    clientBundle: path.join(buildDir, "client.js"),
  };
  const serverEnvFile = await readServerEnvFile(paths.serverEnv);
  const serverEnv = parseServerEnv(serverEnvFile);
  validateAuthConfig(config, serverEnv);

  const [serverSource, clientSource] = await Promise.all([
    readRequiredFile(paths.serverEntry, "Missing capsule entry: server/index.ts", "Run `sporades create` to scaffold a new project."),
    readRequiredFile(paths.clientEntry, "Missing client entry: client/index.tsx", "Run `sporades create` to scaffold a new project."),
    readRequiredFile(paths.indexHtml, "Missing HTML shell: index.html", "Restore index.html or run `sporades create`."),
  ]);

  const clientBundle = await bundleClientSource(clientSource, {
    clientSourcePath: paths.clientEntry,
    frameworkBundleConfig,
  });

  await Promise.all([
    writeFile(
      paths.serverBundle,
      createServerBundleSource({ config, serverEnv, serverSource }),
    ),
    writeFile(paths.clientBundle, clientBundle),
  ]);

  return {
    paths,
    buildDir,
    serverRuntime: {
      source: serverSource,
      env: serverEnv,
    },
    staticFiles: {
      indexHtml: paths.indexHtml,
      clientBundle: paths.clientBundle,
    },
    containerMounts: {
      files: [
        { host: paths.serverBundle, container: "/app/server.mjs", mode: "ro" },
        { host: paths.clientBundle, container: "/app/client.js", mode: "ro" },
        { host: paths.indexHtml, container: "/app/index.html", mode: "ro" },
        { host: paths.config, container: "/app/sporades.json", mode: "ro" },
      ],
      serverEnv: serverEnvFile.exists
        ? { host: paths.serverEnv, container: "/app/.env.sporades.server", mode: "ro" }
        : null,
    },
  };
}

export async function readServerEnvFile(envPath) {
  try {
    const raw = await readFile(envPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
      throw commandError("Invalid server env file.", ".env.sporades.server must be 64KB or smaller.");
    }
    return { exists: true, raw };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, raw: "" };
    }
    throw error;
  }
}

export function parseServerEnv(envFile) {
  const values = {};
  for (const [index, line] of envFile.raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      throw commandError("Invalid server env file.", `Fix line ${index + 1} in .env.sporades.server to use KEY=value.`);
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw commandError("Invalid server env file.", `Fix invalid key ${key} in .env.sporades.server.`);
    }
    if (key.startsWith("SPORADES_")) {
      throw commandError("Invalid server env file.", "Remove reserved SPORADES_ keys from .env.sporades.server.");
    }
    values[key] = parseEnvValue(trimmed.slice(equalsIndex + 1).trim());
  }
  if (Object.keys(values).length > 64) {
    throw commandError("Invalid server env file.", ".env.sporades.server can contain at most 64 keys.");
  }
  return values;
}

function parseEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function authStatus(config, serverEnv) {
  const authConfig = config.auth ?? { mode: "anonymous" };
  const google = authConfig.google ?? {};
  const clientIdEnv = google.clientIdEnv ?? null;
  const clientSecretEnv = google.clientSecretEnv ?? null;
  return {
    mode: authConfig.mode ?? "anonymous",
    google: {
      configured: Boolean(clientIdEnv && clientSecretEnv && serverEnv[clientIdEnv] && serverEnv[clientSecretEnv]),
      clientIdEnv,
      clientSecretEnv,
    },
  };
}

function validateAuthConfig(config, serverEnv) {
  const status = authStatus(config, serverEnv);
  if (status.mode !== "google") {
    return;
  }
  if (!status.google.configured) {
    throw commandError(
      "Google OAuth is not fully configured.",
      "Run `sporades auth set google --client-id <id> --client-secret <secret>` or `sporades auth set google --client-json <path>`.",
    );
  }
}

async function readRequiredFile(filePath, message, hint) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw commandError(message, hint);
    }
    throw error;
  }
}

function readFrameworkBundleConfig(framework) {
  const frameworkBundleConfig = FRAMEWORK_BUNDLE_CONFIG[framework];
  if (!frameworkBundleConfig) {
    throw commandError(`Unsupported framework: ${framework}`, "Use one of: react, preact.");
  }
  return frameworkBundleConfig;
}

async function bundleClientSource(clientSource, options) {
  const { build } = await import("esbuild");

  try {
    const result = await build({
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      logLevel: "silent",
      sourcemap: "inline",
      jsx: "automatic",
      jsxImportSource: options.frameworkBundleConfig.jsxImportSource,
      stdin: {
        contents: clientSource,
        sourcefile: options.clientSourcePath,
        resolveDir: path.dirname(options.clientSourcePath),
        loader: "tsx",
      },
      plugins: [sporadesClientPlugin()],
    });

    return [
      "// Sporades client bundle",
      `// JSX import source: ${options.frameworkBundleConfig.jsxImportSource}`,
      `// JSX runtime import: ${options.frameworkBundleConfig.jsxRuntimeImport}`,
      'console.log("Sporades client bundle loaded");',
      "",
      result.outputFiles[0].text,
    ].join("\n");
  } catch (error) {
    const message = error.errors?.[0]?.text ?? error.message;
    throw commandError(`Client bundle failed: ${message}`, "Fix client/index.tsx and save again.");
  }
}

function sporadesClientPlugin() {
  return {
    name: "sporades-client",
    setup(build) {
      build.onResolve({ filter: /^sporades\/client$/ }, () => ({
        path: "sporades/client",
        namespace: "sporades-runtime",
      }));
      build.onLoad({ filter: /^sporades\/client$/, namespace: "sporades-runtime" }, () => ({
        loader: "js",
        contents: createClientRuntimeSource(),
      }));
    },
  };
}

function commandError(message, hint) {
  const error = new Error(message);
  error.hint = hint;
  return error;
}
