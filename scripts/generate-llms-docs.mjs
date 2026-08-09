import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const SPORADES_LLMS_SECTIONS = [
  {
    heading: "Start",
    entries: [
      { title: "User guide", path: "user-guide.md", description: "Orientation and task-led documentation map." },
      { title: "Build your first Capsule", path: "guide/getting-started.md", description: "Todo walkthrough from scaffold to local Container." },
      { title: "Projects and frameworks", path: "guide/projects.md", description: "Project layout, templates, frameworks, and client toolchains." },
    ],
  },
  {
    heading: "Build",
    entries: [
      { title: "Server", path: "guide/server.md", description: "Schema, queries, mutations, authorization, middleware, and endpoints." },
      { title: "Client", path: "guide/client.md", description: "Subscribed queries, mutations, auth state, and framework adapters." },
      { title: "Authentication", path: "guide/auth.md", description: "Anonymous sessions, email auth, Google OAuth, and local identities." },
      { title: "Files", path: "guide/files.md", description: "Private uploads, File references, publication, replacement, and deletion." },
      { title: "Realtime", path: "guide/realtime.md", description: "App messages and consented transient User Journey state." },
      { title: "Jobs and Schedules", path: "guide/background-work.md", description: "Durable background work, actors, recurrence, and inspection." },
      { title: "Configuration", path: "guide/configuration.md", description: "Capsule config, security, Sealed Server env, preferences, and local services." },
    ],
  },
  {
    heading: "Operate",
    entries: [
      { title: "Local operations", path: "guide/local-operations.md", description: "Dev and Container inspection, diagnostics, and lifecycle commands." },
      { title: "Hosting", path: "guide/hosting.md", description: "Publish and operate Capsules on a configured Host server." },
      { title: "Troubleshooting", path: "guide/troubleshooting.md", description: "Failure classification and safe recovery sequence." },
      { title: "Host server installation", path: "server-installation.md", description: "Provision and bootstrap a Linux Host server." },
    ],
  },
  {
    heading: "Reference",
    entries: [
      { title: "Feature reference index", path: "guide/reference.md", description: "Compatibility index and topic map for exhaustive lookup." },
      { title: "Projects and configuration reference", path: "reference/projects-and-configuration.md", description: "Capsule creation, project layout, configuration, security policy, database services, and Dev sessions." },
      { title: "Server runtime reference", path: "reference/server-runtime.md", description: "Tables, queries, mutations, authorization, Server env, mail, middleware, actors, and endpoints." },
      { title: "Jobs and schedules reference", path: "reference/jobs-and-schedules.md", description: "Durable background work, Schedule behavior, and CLI inspection." },
      { title: "Client, authentication, and preferences reference", path: "reference/client-auth-and-preferences.md", description: "Subscribed client state, authentication workflows, provider configuration, and preferences." },
      { title: "Files and realtime reference", path: "reference/files-and-realtime.md", description: "File operations, App messages, and consented transient User Journey state." },
      { title: "Operations and hosting reference", path: "reference/operations-and-hosting.md", description: "Inspection, Container sessions, Hosted Capsules, Doctor, workflows, and troubleshooting." },
      { title: "SDK documentation", path: "sdk-documentation.md", description: "Map of conceptual guides, generated API reference, and source comments." },
    ],
  },
  {
    heading: "Optional",
    entries: [
      { title: "Architecture", path: "architecture.md", description: "Runtime model, ownership, transport, storage, hosting, and security boundaries." },
      { title: "Runtime layout", path: "runtime-layout.md", description: "Generated files, persistent state, mounts, and Host paths." },
      { title: "Generated API reference", url: "https://mgscox.github.io/sporades/api/", description: "TypeDoc reference for the public client and server SDK." },
    ],
  },
];

export async function generateLlmsDocumentation({
  docsDir,
  outputDir,
  siteUrl,
  sections = SPORADES_LLMS_SECTIONS,
}) {
  const normalizedSiteUrl = siteUrl.replace(/\/$/, "");
  const manifest = [
    "# Sporades",
    "",
    "> Sporades is a CLI-first platform for building, running, inspecting, and hosting full-stack web Capsules.",
    "",
    "Use the Start section for orientation, then choose Build or Operate by task. Links point to release-matched Markdown sources. The Optional section contains exhaustive or implementation-oriented material that can be skipped for smaller context.",
  ];

  for (const section of sections) {
    manifest.push("", `## ${section.heading}`, "");
    for (const entry of section.entries) {
      if (entry.path) {
        const source = path.join(docsDir, entry.path);
        const destination = path.join(outputDir, "llms", entry.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);
      }
      const url = entry.url ?? `${normalizedSiteUrl}/llms/${entry.path}`;
      manifest.push(`- [${entry.title}](${url}): ${entry.description}`);
    }
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "llms.txt"), `${manifest.join("\n")}\n`, "utf8");
}
