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
      { text: "API", link: "/api/" },
    ],
    sidebar: [
      {
        text: "Documentation",
        items: [
          { text: "User guide", link: "/user-guide" },
          { text: "Architecture", link: "/architecture" },
          { text: "Runtime layout", link: "/runtime-layout" },
          { text: "Host server installation", link: "/server-installation" },
          { text: "Product requirements", link: "/PRD" },
          { text: "Roadmap", link: "/ROADMAP" },
          { text: "API reference", link: "/api/" },
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
