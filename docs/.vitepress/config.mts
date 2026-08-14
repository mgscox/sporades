import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Sporades",
  description: "Build, run, inspect, and host full-stack Sporades Capsules.",
  base: "/sporades/",
  cleanUrls: true,
  markdown: {
    html: false,
  },
  ignoreDeadLinks: [/^\/api\//],
  head: [
    ["meta", { name: "theme-color", content: "#0f766e" }],
    ["link", { rel: "icon", href: "/sporades/favicon.svg", type: "image/svg+xml" }],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/user-guide" },
      { text: "Architecture", link: "/architecture" },
      { text: "API", link: "https://mgscox.github.io/sporades/api/" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "User guide", link: "/user-guide" },
          { text: "Build your first Capsule", link: "/guide/getting-started" },
          { text: "Projects and frameworks", link: "/guide/projects" },
        ],
      },
      {
        text: "Build",
        items: [
          { text: "Server", link: "/guide/server" },
          { text: "Client", link: "/guide/client" },
          { text: "Authentication", link: "/guide/auth" },
          { text: "Files", link: "/guide/files" },
          { text: "Realtime features", link: "/guide/realtime" },
          { text: "Jobs and schedules", link: "/guide/background-work" },
          { text: "Mail", link: "/guide/mail" },
          { text: "Configuration", link: "/guide/configuration" },
        ],
      },
      {
        text: "Operate",
        items: [
          { text: "Local operations", link: "/guide/local-operations" },
          { text: "Hosting", link: "/guide/hosting" },
          { text: "Troubleshooting", link: "/guide/troubleshooting" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Feature reference index", link: "/guide/reference" },
          { text: "Projects and configuration", link: "/reference/projects-and-configuration" },
          { text: "Server runtime", link: "/reference/server-runtime" },
          { text: "Built-in Teams", link: "/reference/teams" },
          { text: "Jobs and schedules", link: "/reference/jobs-and-schedules" },
          { text: "Client, auth, and preferences", link: "/reference/client-auth-and-preferences" },
          { text: "Files and realtime", link: "/reference/files-and-realtime" },
          { text: "Operations and hosting", link: "/reference/operations-and-hosting" },
          { text: "Architecture", link: "/architecture" },
          { text: "Runtime layout", link: "/runtime-layout" },
          { text: "Host server installation", link: "/server-installation" },
          { text: "SDK documentation", link: "/sdk-documentation" },
          { text: "API reference", link: "https://mgscox.github.io/sporades/api/" },
        ],
      },
      {
        text: "Project",
        items: [
          { text: "Product requirements", link: "/PRD" },
          { text: "Roadmap", link: "/ROADMAP" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/mgscox/sporades" },
    ],
    search: { provider: "local" },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 Sporades contributors",
    },
  },
});
