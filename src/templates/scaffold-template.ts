export function scaffoldFiles(options: { sporadesDependency?: any; template?: any; framework?: any; name?: any; }) {
  const templateOptions = resolveTemplateOptions(options.template);
  const framework = options.framework ?? templateOptions.framework;
  const renderOptions = { ...options, name: options.name, framework };
  const packageName = options.name;
  const sporadesDependency = options.sporadesDependency ?? "sporades";
  const frameworkDependencies =
    framework === "react"
      ? {
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        }
      : {
          preact: "^10.25.0",
        };
  const frameworkDevDependencies =
    framework === "react"
      ? {
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
        }
      : {};
  const templateFiles = templateOptions.files(renderOptions);

  return {
    "sporades.json": `${JSON.stringify(
      {
        name: options.name,
        template: options.template,
        client: { framework },
        auth: templateOptions.auth,
        security: {
          cors: {
            allowedOrigins: [],
          },
          csp: {
            mode: "report-only",
          },
        },
        deploy: { port: 4000 },
        dev: { port: null },
      },
      null,
      2,
    )}\n`,
    "package.json": `${JSON.stringify(
      {
        name: packageName,
        private: true,
        type: "module",
        scripts: {
          dev: "sporades dev",
          deploy: "sporades deploy",
        },
        dependencies: frameworkDependencies,
        devDependencies: {
          ...frameworkDevDependencies,
          sporades: sporadesDependency,
          typescript: "^5.8.0",
        },
      },
      null,
      2,
    )}\n`,
    "AGENTS.md": agentsTemplate(options.template),
    "CLAUDE.md": agentsTemplate(options.template),
    ".gitignore": "node_modules/\n.sporades/\n.env*.local\n",
    ".env.sporades.server": templateOptions.serverEnv,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(options.name)}</title>${options.template === "campfire" ? `
    <script src="https://cdn.tailwindcss.com"></script>` : ""}
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/client.js"></script>
  </body>
</html>
`,
    ...templateFiles,
  };
}

function resolveTemplateOptions(template: any) {
  switch (template) {
    case "todo":
      return {
        framework: "react",
        auth: { mode: "anonymous" },
        serverEnv: "# Server-only environment variables for Sporades.\n",
        files: todoTemplateFiles,
      };
    case "guestbook":
      return {
        framework: "react",
        auth: { mode: "anonymous" },
        serverEnv: "# Server-only environment variables for Sporades.\n",
        files: guestbookTemplateFiles,
      };
    case "photo-library":
      return {
        framework: "react",
        auth: {
          providers: {
            anonymous: true,
            google: {
              clientIdEnv: "GOOGLE_CLIENT_ID",
              clientSecretEnv: "GOOGLE_CLIENT_SECRET",
            },
          },
        },
        serverEnv:
          "# Server-only environment variables for Sporades.\nGOOGLE_CLIENT_ID=replace-with-google-client-id\nGOOGLE_CLIENT_SECRET=replace-with-google-client-secret\n",
        files: photoLibraryTemplateFiles,
      };
    case "campfire":
      return {
        framework: "react",
        auth: { providers: { anonymous: true, email: true } },
        serverEnv: "# Server-only environment variables for Sporades.\n",
        files: campfireTemplateFiles,
      };
    case "blank":
    default:
      return {
        framework: "react",
        auth: { mode: "anonymous" },
        serverEnv: "# Server-only environment variables for Sporades.\n",
        files: blankTemplateFiles,
      };
  }
}

function blankTemplateFiles(options: { name: any; framework: any; }) {
  return {
    "README.md": `# ${options.name}\n\nA blank Sporades capsule.\n`,
    "server/index.ts": `import { capsule } from "sporades/server";

export default capsule({
  name: ${JSON.stringify(options.name)},
  schema: {},
  queries: {},
  mutations: {},
});
`,
    "client/index.tsx": blankClientTemplate(options.framework),
    "shared/types.ts": `export {};
`,
  };
}

function todoTemplateFiles(options: { name: any; framework: any; }) {
  return {
    "README.md": `# ${options.name}\n\nA Sporades todo capsule.\n`,
    "server/index.ts": `import { Boolean, capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: ${JSON.stringify(options.name)},

  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all(),
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });
    }),
  },
});
`,
    "client/index.tsx": todoClientTemplate(options.framework),
    "shared/types.ts": `export type Todo = {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
};
`,
  };
}

function guestbookTemplateFiles(options: { name: any; framework: any; }) {
  return {
    "README.md": `# ${options.name}

A Sporades guestbook capsule.

Trusted author fields come from \`ctx.auth\` on the server, not from client-submitted input. Anonymous sessions can sign the guestbook, and Google-linked sessions display richer author metadata when configured with \`sporades auth set google\`.
`,
    "server/index.ts": `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: ${JSON.stringify(options.name)},

  schema: {
    entries: table({
      body: String(),
      authorId: String(),
      authorName: String(),
      authorPicture: String(),
    }),
  },

  queries: {
    entries: query((ctx) =>
      ctx.db.entries
        .orderBy("createdAt", "desc")
        .limit(50)
        .all(),
    ),
  },

  mutations: {
    sign: mutation((ctx, body) => {
      const trimmed = body.trim();
      if (!trimmed) {
        throw new Error("Write a message before signing.");
      }
      if (trimmed.length > 280) {
        throw new Error("Guestbook messages must be 280 characters or fewer.");
      }

      ctx.db.entries.insert({
        body: trimmed,
        authorId: ctx.auth.userId,
        authorName: ctx.auth.displayName,
        authorPicture: ctx.auth.picture ?? "",
      });
    }),
  },
});
`,
    "client/index.tsx": guestbookClientTemplate(options.framework),
    "shared/types.ts": `export type GuestbookEntry = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  authorPicture: string;
  createdAt: string;
  updatedAt: string;
};
`,
  };
}

function photoLibraryTemplateFiles(options: { name: any; framework: any; }) {
  return {
    "README.md": `# ${options.name}

A Sporades photo library capsule.

Uploads use \`files.upload()\` from \`sporades/client\`, then store the returned File metadata through a normal Capsule mutation. Anonymous uploads are public immediately; Google-linked uploads are private unless you choose to publish them.

Google is enabled in \`sporades.json\` with placeholder server env values so the Capsule starts immediately. Replace them with real OAuth credentials via \`sporades auth set google\` before using real Google sign-in.
`,
    "server/index.ts": `import { Boolean, capsule, job, mutation, Number, query, schedule, String, table } from "sporades/server";

export default capsule({
  name: ${JSON.stringify(options.name)},

  schema: {
    photos: table({
      title: String(),
      fileId: String(),
      fileName: String(),
      fileType: String(),
      fileSize: Number(),
      filePath: String(),
      fileVersion: String(),
      imageUrl: String(),
      publicUrlId: String(),
      ownerId: String(),
      ownerName: String(),
      isPublic: Boolean().default(false),
    }),
  },

  queries: {
    publicPhotos: query((ctx) =>
      ctx.db.photos
        .where("isPublic", true)
        .orderBy("createdAt", "desc")
        .all()
        .filter((photo) => photo.imageUrl),
    ),
    personalPhotos: query((ctx) => {
      if (ctx.auth.provider !== "google") {
        return [];
      }

      return ctx.db.photos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
        .map((photo) => ({
          ...photo,
          status: photo.isPublic ? "public" : "private",
        }));
    }),
  },

  jobs: {
    timestampPhotoNames: job((ctx) => {
      const time = new globalThis.Date().toISOString().slice(11, 16);
      for (const photo of ctx.db.photos.all()) {
        const title = globalThis.String(photo.title).replace(/^\\d{2}:\\d{2}\\s+/, "");
        const fileName = globalThis.String(photo.fileName).replace(/^\\d{2}:\\d{2}\\s+/, "");
        ctx.db.photos.update(photo.id, {
          title: \`\${time} \${title}\`,
          fileName: \`\${time} \${fileName}\`,
        });
      }
    }),
  },

  schedules: {
    timestampPhotoNames: schedule({
      expression: "* * * * *",
      job: "timestampPhotoNames",
    }),
  },

  mutations: {
    recordPhoto: mutation((ctx, input) => {
      const file = input?.file;
      if (!file?.id || !file?.name || !file?.type || typeof file?.size !== "number") {
        throw new Error("Upload an image before saving the photo.");
      }
      if (!file.type.startsWith("image/")) {
        throw new Error("Photo uploads must be image files.");
      }

      const title = globalThis.String(input.title ?? file.name).trim() || file.name;
      const isPublic = ctx.auth.provider === "google" ? globalThis.Boolean(input.isPublic) : true;
      const imageUrl = isPublic ? globalThis.String(input.publicUrl?.url ?? "") : "";
      const publicUrlId = isPublic ? globalThis.String(input.publicUrl?.id ?? "") : "";
      if (isPublic && !imageUrl) {
        throw new Error("Public photos need a public file URL.");
      }

      ctx.db.photos.insert({
        title,
        fileId: file.id,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        filePath: file.path ?? "",
        fileVersion: file.version ?? "",
        imageUrl,
        publicUrlId,
        ownerId: ctx.auth.userId,
        ownerName: ctx.auth.displayName,
        isPublic,
      });
    }),
  },
});
`,
    "client/index.tsx": photoLibraryClientTemplate(options.framework),
    "shared/types.ts": `export type Photo = {
  id: string;
  title: string;
  fileId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath: string;
  fileVersion: string;
  imageUrl: string;
  publicUrlId: string;
  ownerId: string;
  ownerName: string;
  isPublic: boolean;
  status?: "public" | "private";
  createdAt: string;
  updatedAt: string;
};
`,
  };
}

function campfireTemplateFiles(options: { name: any; framework: any; }) {
  return {
    "README.md": `# ${options.name}

Campfire is the complete Sporades User journey tracker exemplar: realtime chat, durable reactions, and consented ephemeral activity for the four Musketeers.

## Run the campfire

\`\`\`sh
npm install
npm run dev
\`\`\`

Open the URL and choose **Prepare demo fixtures**. This explicit development-only action uses ordinary public email sign-up and creates Athos (\`athos@campfire.example\`), Porthos (\`porthos@campfire.example\`), Aramis (\`aramis@campfire.example\`), and d'Artagnan (\`dartagnan@campfire.example\`). Their shared demo password is shown in the UI. Repeating preparation is safe. Never expose these known credentials in a public Container session or Hosted Capsule; building, starting, deploying, and hosting never seed them automatically.

Use separate browser contexts (for example, a normal and private window) so each Musketeer has an independent Session token. The switcher signs out then signs in through public email auth.

Channels, messages, and reactions are durable Capsule data. “What's happening” is ephemeral, latest-only Journey state: it is off until each page explicitly consents, typing expires naturally, and reload/auth transitions retire consent. Draft text, message text, raw URLs, query strings, emails, passwords, message IDs, and keystrokes are never shared.

Tailwind is loaded from its browser CDN under Sporades' current fixed client-Bundle contract, so the browser needs network access. A production Capsule can compile Tailwind once first-class CSS assets are available. Shadcn/UI-style component source belongs to this Capsule and needs no Shadcn CLI after generation.
`,
    "server/index.ts": campfireServerTemplate(options.name),
    "client/index.tsx": campfireClientTemplate(options.framework),
    "client/journey-typing.ts": `export function createTypingPublisher(publish, clock = {}) {
  const now = clock.now ?? (() => Date.now());
  const setTimer = clock.setTimer ?? ((fn, delay) => setTimeout(fn, delay));
  const clearTimer = clock.clearTimer ?? ((id) => clearTimeout(id));
  let activeChannel = null, lastPublishedAt = -Infinity, throttleTimer = null, renewTimer = null;
  const clear = (name) => { if (name !== null) clearTimer(name); };
  const publishTyping = () => {
    throttleTimer = null;
    if (!activeChannel) return;
    publish({ status: "typing", metadata: { channel: activeChannel }, ttlSeconds: 4 });
    lastPublishedAt = now();
    clear(renewTimer);
    renewTimer = setTimer(publishTyping, 2500);
  };
  return {
    input(value, channel) {
      if (!value) { this.stop(channel); return; }
      activeChannel = channel;
      const remaining = 750 - (now() - lastPublishedAt);
      if (remaining <= 0) publishTyping();
      else if (throttleTimer === null) throttleTimer = setTimer(publishTyping, remaining);
    },
    stop(channel) {
      activeChannel = null;
      clear(throttleTimer); clear(renewTimer); throttleTimer = renewTimer = null;
      publish({ status: "reading", metadata: { channel }, ttlSeconds: 12 });
    },
    dispose() { activeChannel = null; clear(throttleTimer); clear(renewTimer); throttleTimer = renewTimer = null; },
  };
}
`,
    "client/components/ui/button.tsx": `export function Button({ className = "", ...props }) {
  return <button className={\`rounded-md px-3 py-2 font-semibold focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50 \${className}\`} {...props} />;
}
`,
    "client/components/ui/card.tsx": `export function Card({ className = "", ...props }) { return <article className={\`rounded-lg border border-amber-900/40 bg-[#211710] \${className}\`} {...props} />; }
`,
    "client/components/ui/avatar.tsx": `export function Avatar({ label, className = "" }) { return <span role="img" aria-label={label} className={\`inline-grid h-8 w-8 place-items-center rounded-full bg-amber-800 font-bold \${className}\`}>{label.slice(0, 2)}</span>; }
`,
    "client/components/ui/badge.tsx": `export function Badge({ className = "", ...props }) { return <span className={\`inline-flex rounded-full bg-amber-950 px-2 py-1 text-xs font-semibold \${className}\`} {...props} />; }
`,
    "client/components/ui/switch.tsx": `export function Switch({ label, ...props }) { return <label className="flex cursor-pointer items-center gap-3"><input type="checkbox" role="switch" {...props} /><span>{label}</span></label>; }
`,
    "client/components/ui/input.tsx": `export function Input({ className = "", ...props }) { return <input className={\`rounded-md border border-amber-900 bg-[#211710] px-4 py-3 focus:outline-none focus:ring-2 focus:ring-amber-400 \${className}\`} {...props} />; }
`,
    "client/components/ui/separator.tsx": `export function Separator({ className = "" }) { return <hr aria-hidden="true" className={\`border-0 border-t border-amber-900/40 \${className}\`} />; }
`,
    "client/components/ui/scroll-area.tsx": `export function ScrollArea({ className = "", ...props }) { return <div tabIndex={0} className={\`overflow-auto focus:outline-none focus:ring-2 focus:ring-amber-400 \${className}\`} {...props} />; }
`,
    "shared/types.ts": `export type ReactionKind = "up" | "down";
export type CampfireChannel = "general" | "ideas" | "random" | "protect-the-crown";
`,
  };
}

function campfireServerTemplate(name: string) {
  return `import { capsule, mutation, query, String, table } from "sporades/server";

const channels = ["general", "ideas", "random", "protect-the-crown"];
const fixtureNames = { athos: "Athos", porthos: "Porthos", aramis: "Aramis", dartagnan: "d'Artagnan" };

export default capsule({
  name: ${JSON.stringify(name)},
  journey: { enabled: true, ttlSeconds: 12, capture: { navigation: false, focus: false, interactions: false } },
  schema: {
    channels: table({ slug: String(), name: String() }),
    profiles: table({ userId: String(), key: String(), name: String() }),
    messages: table({ channel: String(), body: String(), authorId: String(), authorName: String() }),
    reactions: table({ identity: String(), messageId: String(), userId: String(), kind: String() }),
  },
  queries: {
    channels: query((ctx) => ctx.db.channels.orderBy("createdAt", "asc").all()),
    messagesGeneral: query((ctx) => ctx.db.messages.where("channel", "general").orderBy("createdAt", "asc").limit(100).all()),
    messagesIdeas: query((ctx) => ctx.db.messages.where("channel", "ideas").orderBy("createdAt", "asc").limit(100).all()),
    messagesRandom: query((ctx) => ctx.db.messages.where("channel", "random").orderBy("createdAt", "asc").limit(100).all()),
    messagesProtectTheCrown: query((ctx) => ctx.db.messages.where("channel", "protect-the-crown").orderBy("createdAt", "asc").limit(100).all()),
    reactions: query((ctx) => ctx.db.reactions.all()),
    profiles: query((ctx) => ctx.db.profiles.all()),
  },
  mutations: {
    seedCampfire: mutation((ctx) => {
      const created = [], alreadyPresent = [], failed = [];
      const ensure = (type, key, exists, create) => { try { if (exists()) alreadyPresent.push({ type, key }); else { create(); created.push({ type, key }); } } catch (error) { failed.push({ type, key, message: error instanceof Error ? error.message : "Unknown seed failure." }); } };
      for (const slug of channels) ensure("channel", slug, () => ctx.db.channels.where("slug", slug).all().length > 0, () => ctx.db.channels.insert({ slug, name: slug }));
      ensure("message", "general-welcome", () => ctx.db.messages.where("channel", "general").all().length > 0, () => ctx.db.messages.insert({ channel: "general", body: "The Queen requires discretion.", authorId: "fixture:athos", authorName: fixtureNames.athos }));
      ensure("message", "ideas-welcome", () => ctx.db.messages.where("channel", "ideas").all().length > 0, () => ctx.db.messages.insert({ channel: "ideas", body: "And refreshments.", authorId: "fixture:porthos", authorName: fixtureNames.porthos }));
      ensure("message", "random-welcome", () => ctx.db.messages.where("channel", "random").all().length > 0, () => ctx.db.messages.insert({ channel: "random", body: "Mostly discretion.", authorId: "fixture:aramis", authorName: fixtureNames.aramis }));
      ensure("message", "crown-prompt", () => ctx.db.messages.where("channel", "protect-the-crown").all().length > 0, () => ctx.db.messages.insert({ channel: "protect-the-crown", body: "Is the crown adequately protected? 👍 All for one · 👎 One more guard, perhaps", authorId: "fixture:dartagnan", authorName: fixtureNames.dartagnan }));
      return { created, alreadyPresent, failed };
    }),
    registerFixture: mutation((ctx, key: any) => {
      if (!Object.prototype.hasOwnProperty.call(fixtureNames, key)) throw new Error("Unknown Musketeer.");
      if (!ctx.db.profiles.where("userId", ctx.auth.userId).all().length) ctx.db.profiles.insert({ userId: ctx.auth.userId, key, name: fixtureNames[key] });
    }),
    sendMessage: mutation((ctx, input: any) => {
      const channel = globalThis.String(input?.channel ?? "");
      const body = globalThis.String(input?.body ?? "").trim();
      if (!channels.includes(channel)) throw new Error("Choose a Campfire channel.");
      if (!body) throw new Error("Write a message before sending.");
      if (body.length > 500) throw new Error("Messages must be 500 characters or fewer.");
      return ctx.db.messages.insert({ channel, body, authorId: ctx.auth.userId, authorName: ctx.auth.displayName });
    }),
    toggleReaction: mutation((ctx, input: any) => {
      const kind = input?.kind;
      if (kind !== "up" && kind !== "down") throw new Error("Choose thumbs up or thumbs down.");
      if (!ctx.db.messages.where("id", input?.messageId).all().length) throw new Error("Message not found.");
      const identity = input.messageId + ":" + ctx.auth.userId + ":" + kind;
      const existing = ctx.db.reactions.where("identity", identity).all()[0];
      if (existing) { ctx.db.reactions.delete(existing.id); return { active: false }; }
      ctx.db.reactions.insert({ identity, messageId: input.messageId, userId: ctx.auth.userId, kind });
      return { active: true };
    }),
  },
});
`;
}

function campfireClientTemplate(framework: string) {
  const preact = framework === "preact";
  const imports = preact
    ? `import { render } from "preact";\nimport { useEffect, useState } from "preact/hooks";`
    : `import { useEffect, useState } from "react";\nimport { createRoot } from "react-dom/client";`;
  const mount = preact ? `render(<App />, document.getElementById("app")!);` : `createRoot(document.getElementById("app")!).render(<App />);`;
  const change = preact ? "onInput" : "onChange";
  const klass = preact ? "class" : "className";
  return `${imports}
import { auth, createHooks, journey } from "sporades/client";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Avatar } from "./components/ui/avatar";
import { Badge } from "./components/ui/badge";
import { Switch } from "./components/ui/switch";
import { Input } from "./components/ui/input";
import { Separator } from "./components/ui/separator";
import { ScrollArea } from "./components/ui/scroll-area";
import { createTypingPublisher } from "./journey-typing";

const { useAuth, useMutation, useQuery } = createHooks({ useState, useEffect });
const musketeers = [
  { key: "athos", name: "Athos", email: "athos@campfire.example", monogram: "A", tone: "bg-slate-600" },
  { key: "porthos", name: "Porthos", email: "porthos@campfire.example", monogram: "P", tone: "bg-rose-800" },
  { key: "aramis", name: "Aramis", email: "aramis@campfire.example", monogram: "Ar", tone: "bg-indigo-800" },
  { key: "dartagnan", name: "d'Artagnan", email: "dartagnan@campfire.example", monogram: "dA", tone: "bg-amber-800" },
];
const fixedChannels = ["general", "ideas", "random", "protect-the-crown"];
const demoPassword = "all-for-one-campfire";

function App() {
  const session = useAuth();
  const [channel, setChannel] = useState("general");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [sharing, setSharing] = useState(false);
  const [activities, setActivities] = useState([]);
  const [typingPublisher] = useState(() => createTypingPublisher((state) => journey.set(state)));
  const messageQuery = { general: "messagesGeneral", ideas: "messagesIdeas", random: "messagesRandom", "protect-the-crown": "messagesProtectTheCrown" }[channel];
  const messages = useQuery(messageQuery);
  const reactions = useQuery("reactions");
  const profiles = useQuery("profiles");
  const sendMessage = useMutation("sendMessage");
  const toggleReaction = useMutation("toggleReaction");
  const seedCampfire = useMutation("seedCampfire");
  const registerFixture = useMutation("registerFixture");

  useEffect(() => journey.subscribe((event) => {
    setActivities((current) => applyJourneyEvent(current, event));
  }).unsubscribe, []);
  useEffect(() => () => typingPublisher.dispose(), []);

  async function prepareFixtures() {
    setNotice("Preparing development-only fixtures…");
    for (const person of musketeers) {
      const result = await auth.signUp("email", { email: person.email, password: demoPassword, name: person.name });
      if (result.error && !/already|exists|registered/i.test(result.error.message)) { setNotice(\`Could not prepare \${person.name}: \${result.error.message}\`); return; }
      if (!result.error) await registerFixture.run(person.key);
      await auth.signOut();
    }
    const seeded = await seedCampfire.run();
    setNotice(seeded.error ? seeded.error.message : seeded.data.failed.length ? \`Fixture preparation failed for \${seeded.data.failed.map((item) => item.key).join(", ")}.\` : \`Fixtures ready: \${seeded.data.created.length} created, \${seeded.data.alreadyPresent.length} already present.\`);
  }

  async function switchTo(person) {
    if (sharing) { await journey.disable(); setSharing(false); }
    await auth.signOut();
    const result = await auth.signIn("email", { email: person.email, password: demoPassword });
    setNotice(result.error ? result.error.message : \`Signed in as \${person.name}. Activity sharing remains off.\`);
  }

  async function setShare(enabled) {
    if (enabled) {
      const result = await journey.enable({ capture: { navigation: false, focus: false, interactions: false } });
      if (result.error) { setNotice(result.error.message); return; }
      setSharing(true);
      await journey.set({ status: "reading", metadata: { channel }, ttlSeconds: 12 });
    } else { typingPublisher.dispose(); await journey.disable(); setSharing(false); }
  }

  async function chooseChannel(next) {
    typingPublisher.dispose();
    setChannel(next);
    if (sharing) await journey.set({ status: "reading", metadata: { channel: next }, ttlSeconds: 12 });
  }

  async function compose(value) {
    setDraft(value);
    if (sharing) typingPublisher.input(value, channel);
  }

  async function submit(event) {
    event.preventDefault();
    const result = await sendMessage.run({ channel, body: draft });
    if (result.error) { setNotice(result.error.message); return; }
    setDraft("");
    if (sharing) typingPublisher.stop(channel);
  }

  return <main ${klass}="min-h-screen bg-[#120d0a] text-amber-50 lg:grid lg:grid-cols-[240px_1fr_300px]">
    <aside ${klass}="border-r border-amber-900/40 bg-[#1b120d] p-5">
      <p ${klass}="text-xs font-bold uppercase tracking-[.28em] text-amber-500">Sporades exemplar</p><h1 ${klass}="mb-8 mt-2 text-3xl font-black">🔥 Campfire</h1>
      <nav aria-label="Channels" ${klass}="space-y-2">{fixedChannels.map((slug) => <button type="button" ${klass}={\`block w-full rounded-md px-3 py-2 text-left \${channel === slug ? "bg-amber-700 text-white" : "hover:bg-amber-950"}\`} onClick={() => chooseChannel(slug)}><Badge># {slug}</Badge></button>)}</nav>
      <Separator ${klass}="my-8"/><div><Button ${klass}="w-full bg-amber-700" type="button" onClick={prepareFixtures}>Prepare demo fixtures</Button><p ${klass}="mt-2 text-xs text-amber-200/70">Development-only. Never enable known credentials publicly.</p></div>
    </aside>
    <section ${klass}="flex min-h-screen flex-col"><header ${klass}="border-b border-amber-900/40 p-5"><h2 ${klass}="text-xl font-bold"># {channel}</h2><p role="status" ${klass}="text-sm text-amber-300">{notice}</p></header>
      <ScrollArea ${klass}="flex-1 space-y-4 p-5">{(messages.data ?? []).map((message) => <Message key={message.id} message={message} session={session} toggle={toggleReaction} reactions={reactions.data ?? []} />)}</ScrollArea>
      <form ${klass}="border-t border-amber-900/40 p-5" onSubmit={submit}><label ${klass}="sr-only" htmlFor="message">Message</label><div ${klass}="flex gap-2"><Input id="message" maxLength={500} ${klass}="min-w-0 flex-1" value={draft} placeholder={\`Message #\${channel}\`} ${change}={(event) => compose(event.currentTarget.value)} /><Button ${klass}="bg-amber-700" type="submit">Send</Button></div></form>
    </section>
    <aside ${klass}="border-l border-amber-900/40 bg-[#1b120d] p-5"><h2 ${klass}="text-lg font-bold">What's happening</h2><div ${klass}="mt-4"><Switch label="Share my activity" checked={sharing} onChange={(event) => setShare(event.currentTarget.checked)} /></div><p ${klass}="mt-2 text-xs text-amber-200/70">Shares only reading/typing and channel. Never drafts, messages, URLs, query strings, emails, passwords, message IDs, or keystrokes.</p>
      <ul ${klass}="mt-5 space-y-3">{activities.map((activity) => <li key={activity.sessionId} ${klass}="rounded-md bg-amber-950/60 p-3">{personName(activity.userId, profiles.data ?? [])} is {activity.status} #{activity.metadata?.channel ?? "campfire"}</li>)}</ul>
      <h3 ${klass}="mt-8 font-bold">Switch Musketeer</h3><div ${klass}="mt-3 grid gap-2">{musketeers.map((person) => <Button type="button" ${klass}=\"flex items-center gap-2 bg-stone-800 text-left\" onClick={() => switchTo(person)}><span ${klass}={\`grid h-7 w-7 place-items-center rounded-full \${person.tone}\`}>{person.monogram}</span>{person.name}</Button>)}</div>
    </aside>
  </main>;
}

function Message({ message, session, toggle, reactions }) {
  const rows = reactions.filter((row) => row.messageId === message.id);
  return <Card ${klass}="p-4"><div ${klass}="flex items-baseline gap-3"><Avatar label={message.authorName}/><strong>{message.authorName}</strong><time ${klass}="text-xs text-amber-300/60">{new Date(message.createdAt).toLocaleString()}</time></div><p ${klass}="my-3 whitespace-pre-wrap">{message.body}</p><div ${klass}="flex gap-2">{[["up", "👍"], ["down", "👎"]].map(([kind, emoji]) => { const mine = rows.some((row) => row.kind === kind && row.userId === session.auth?.userId); const total = rows.filter((row) => row.kind === kind).length; return <button type="button" aria-label={\`\${kind === "up" ? "Thumbs up" : "Thumbs down"}: \${total}; \${mine ? "active" : "inactive"}\`} aria-pressed={mine} ${klass}="rounded-full border border-amber-800 px-3 py-1" onClick={() => toggle.run({ messageId: message.id, kind })}>{emoji} {total}</button>; })}</div></Card>;
}

function applyJourneyEvent(current, event) {
  const data = event?.data ?? event;
  if (data?.type === "snapshot") return data.states ?? [];
  if (data?.type === "removed" || data?.type === "expired") return current.filter((item) => item.sessionId !== data.state?.sessionId);
  const state = data?.state;
  if (!state) return current;
  return [...current.filter((item) => item.sessionId !== state.sessionId), state];
}
function personName(userId, profiles) { return profiles.find((profile) => profile.userId === userId)?.name ?? "A Musketeer"; }
${mount}
`;
}

function blankClientTemplate(framework: string) {
  if (framework === "preact") {
    return `import { render } from "preact";

function App() {
  return (
    <main>
      <h1>Blank Sporades Capsule</h1>
      <p>Start building in server/index.ts and client/index.tsx.</p>
    </main>
  );
}

render(<App />, document.getElementById("app")!);
`;
  }

  return `import { createRoot } from "react-dom/client";

function App() {
  return (
    <main>
      <h1>Blank Sporades Capsule</h1>
      <p>Start building in server/index.ts and client/index.tsx.</p>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
`;
}

function todoClientTemplate(framework: string) {
  if (framework === "preact") {
    return `import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { auth, createHooks } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });

function App() {
  const session = useAuth();
  const todos = useQuery("todos");
  const addTodo = useMutation("addTodo");
  const [text, setText] = useState("");

  return (
    <main>
      <h1>Sporades Todos</h1>
      {session.providers.google?.enabled && session.providers.google?.configured && !session.isAuthenticated() ? (
        <button type="button" onClick={() => auth.signIn("google")}>
          Sign in with Google
        </button>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) {
            addTodo.run(text.trim());
            setText("");
          }
        }}
      >
        <input value={text} onInput={(event) => setText(event.currentTarget.value)} />
        <button type="submit">Add todo</button>
      </form>
      <ul>
        {(todos.data ?? []).map((todo) => (
          <li key={todo.id}>{todo.text}</li>
        ))}
      </ul>
    </main>
  );
}

render(<App />, document.getElementById("app")!);
`;
  }

  return `import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { auth, createHooks } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });

function App() {
  const session = useAuth();
  const todos = useQuery("todos");
  const addTodo = useMutation("addTodo");
  const [text, setText] = useState("");

  return (
    <main>
      <h1>Sporades Todos</h1>
      {session.providers.google?.enabled && session.providers.google?.configured && !session.isAuthenticated() ? (
        <button type="button" onClick={() => auth.signIn("google")}>
          Sign in with Google
        </button>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) {
            addTodo.run(text.trim());
            setText("");
          }
        }}
      >
        <input value={text} onChange={(event) => setText(event.currentTarget.value)} />
        <button type="submit">Add todo</button>
      </form>
      <ul>
        {(todos.data ?? []).map((todo) => (
          <li key={todo.id}>{todo.text}</li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
`;
}

function guestbookClientTemplate(framework: string) {
  if (framework === "preact") {
    return `import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { auth, createHooks } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });
const maxLength = 280;

function App() {
  const session = useAuth();
  const entries = useQuery("entries");
  const sign = useMutation("sign");
  const [body, setBody] = useState("");
  const [authError, setAuthError] = useState("");
  const remaining = maxLength - body.length;

  async function signInWithGoogle() {
    setAuthError("");
    const result = await auth.signIn("google");
    if (result.error) {
      setAuthError(result.error.message);
    }
  }

  async function signOut() {
    setAuthError("");
    const result = await auth.signOut();
    if (result.error) {
      setAuthError(result.error.message);
    }
  }

  async function submit(event: Event) {
    event.preventDefault();
    const message = body.trim();
    if (!message || message.length > maxLength) return;
    const result = await sign.run(message);
    if (!result.error) setBody("");
  }

  return (
    <main class="shell">
      <style>{styles}</style>
      <section class="intro">
        <div>
          <p class="eyebrow">Sporades guestbook</p>
          <h1>Leave a note from this island.</h1>
        </div>
        <div class="auth-panel">
          <span>{session.auth?.displayName ?? "Anonymous"}</span>
          {!session.isAuthenticated() ? (
            <button type="button" onClick={signInWithGoogle}>
              Sign in with Google
            </button>
          ) : (
            <button class="secondary-button" type="button" onClick={signOut}>
              Sign out
            </button>
          )}
          {authError ? <p class="error">{authError}</p> : null}
        </div>
      </section>

      <form class="composer" onSubmit={submit}>
        <textarea
          value={body}
          maxLength={maxLength}
          placeholder="Write something kind, sharp, or strangely memorable."
          onInput={(event) => setBody(event.currentTarget.value)}
        />
        <div class="composer-row">
          <span class={remaining < 0 ? "over" : ""}>{remaining} characters left</span>
          <button type="submit" disabled={!body.trim() || sign.loading}>
            Sign guestbook
          </button>
        </div>
        {sign.error ? <p class="error">{sign.error.message}</p> : null}
      </form>

      <section class="entries">
        {(entries.data ?? []).map((entry) => (
          <article class="entry" key={entry.id}>
            {entry.authorPicture ? <img src={entry.authorPicture} alt="" /> : <span class="author-badge">{initials(entry.authorName)}</span>}
            <div>
              <div class="entry-meta">
                <strong>{entry.authorName}</strong>
                <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
              </div>
              <p>{entry.body}</p>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";
}

render(<App />, document.getElementById("app")!);

const styles = \`
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; background: #f6f3ed; color: #25211b; }
  .shell { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
  .intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
  .eyebrow { margin: 0 0 8px; color: #7a4b28; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; }
  h1 { margin: 0; max-width: 620px; font-size: clamp(2rem, 6vw, 4.8rem); line-height: 0.95; }
  .auth-panel { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; min-width: 220px; }
  button { border: 0; border-radius: 8px; background: #176b61; color: white; cursor: pointer; font: inherit; font-weight: 700; min-height: 42px; padding: 0 16px; }
  .secondary-button { background: #51483d; }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  .composer { background: white; border: 1px solid #ded6ca; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  textarea { width: 100%; min-height: 116px; box-sizing: border-box; resize: vertical; border: 1px solid #cfc6b8; border-radius: 8px; padding: 12px; font: inherit; }
  .composer-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 12px; }
  .over, .error { color: #a33b28; }
  .entries { display: grid; gap: 12px; }
  .entry { display: grid; grid-template-columns: 48px 1fr; gap: 14px; background: white; border: 1px solid #ded6ca; border-radius: 8px; padding: 14px; }
  .entry img, .author-badge { width: 48px; height: 48px; border-radius: 50%; }
  .author-badge { display: grid; place-items: center; background: #25211b; color: white; font-weight: 800; }
  .entry-meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
  time { color: #73695b; font-size: 0.88rem; }
  .entry p { margin: 8px 0 0; white-space: pre-wrap; }
  @media (max-width: 680px) { .intro, .composer-row { display: grid; } .auth-panel { justify-content: flex-start; } }
\`;
`;
  }

  return `import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { auth, createHooks } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });
const maxLength = 280;

function App() {
  const session = useAuth();
  const entries = useQuery("entries");
  const sign = useMutation("sign");
  const [body, setBody] = useState("");
  const [authError, setAuthError] = useState("");
  const remaining = maxLength - body.length;

  async function signInWithGoogle() {
    setAuthError("");
    const result = await auth.signIn("google");
    if (result.error) {
      setAuthError(result.error.message);
    }
  }

  async function signOut() {
    setAuthError("");
    const result = await auth.signOut();
    if (result.error) {
      setAuthError(result.error.message);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = body.trim();
    if (!message || message.length > maxLength) return;
    const result = await sign.run(message);
    if (!result.error) setBody("");
  }

  return (
    <main className="shell">
      <style>{styles}</style>
      <section className="intro">
        <div>
          <p className="eyebrow">Sporades guestbook</p>
          <h1>Leave a note from this island.</h1>
        </div>
        <div className="auth-panel">
          <span>{session.auth?.displayName ?? "Anonymous"}</span>
          {!session.isAuthenticated() ? (
            <button type="button" onClick={signInWithGoogle}>
              Sign in with Google
            </button>
          ) : (
            <button className="secondary-button" type="button" onClick={signOut}>
              Sign out
            </button>
          )}
          {authError ? <p className="error">{authError}</p> : null}
        </div>
      </section>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={body}
          maxLength={maxLength}
          placeholder="Write something kind, sharp, or strangely memorable."
          onChange={(event) => setBody(event.currentTarget.value)}
        />
        <div className="composer-row">
          <span className={remaining < 0 ? "over" : ""}>{remaining} characters left</span>
          <button type="submit" disabled={!body.trim() || sign.loading}>
            Sign guestbook
          </button>
        </div>
        {sign.error ? <p className="error">{sign.error.message}</p> : null}
      </form>

      <section className="entries">
        {(entries.data ?? []).map((entry) => (
          <article className="entry" key={entry.id}>
            {entry.authorPicture ? <img src={entry.authorPicture} alt="" /> : <span className="author-badge">{initials(entry.authorName)}</span>}
            <div>
              <div className="entry-meta">
                <strong>{entry.authorName}</strong>
                <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
              </div>
              <p>{entry.body}</p>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";
}

createRoot(document.getElementById("app")!).render(<App />);

const styles = \`
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; background: #f6f3ed; color: #25211b; }
  .shell { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
  .intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
  .eyebrow { margin: 0 0 8px; color: #7a4b28; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; }
  h1 { margin: 0; max-width: 620px; font-size: clamp(2rem, 6vw, 4.8rem); line-height: 0.95; }
  .auth-panel { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; min-width: 220px; }
  button { border: 0; border-radius: 8px; background: #176b61; color: white; cursor: pointer; font: inherit; font-weight: 700; min-height: 42px; padding: 0 16px; }
  .secondary-button { background: #51483d; }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  .composer { background: white; border: 1px solid #ded6ca; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  textarea { width: 100%; min-height: 116px; box-sizing: border-box; resize: vertical; border: 1px solid #cfc6b8; border-radius: 8px; padding: 12px; font: inherit; }
  .composer-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 12px; }
  .over, .error { color: #a33b28; }
  .entries { display: grid; gap: 12px; }
  .entry { display: grid; grid-template-columns: 48px 1fr; gap: 14px; background: white; border: 1px solid #ded6ca; border-radius: 8px; padding: 14px; }
  .entry img, .author-badge { width: 48px; height: 48px; border-radius: 50%; }
  .author-badge { display: grid; place-items: center; background: #25211b; color: white; font-weight: 800; }
  .entry-meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
  time { color: #73695b; font-size: 0.88rem; }
  .entry p { margin: 8px 0 0; white-space: pre-wrap; }
  @media (max-width: 680px) { .intro, .composer-row { display: grid; } .auth-panel { justify-content: flex-start; } }
\`;
`;
}

function photoLibraryClientTemplate(framework: string) {
  if (framework === "preact") {
    return `import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { auth, createHooks, files } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });

function App() {
  const session = useAuth();
  const publicPhotos = useQuery("publicPhotos");
  const personalPhotos = useQuery("personalPhotos");
  const recordPhoto = useMutation("recordPhoto");
  const updatePhotoIsPublic = useMutation("updatePhotoIsPublic");
  const updatePhotoImageUrl = useMutation("updatePhotoImageUrl");
  const updatePhotoPublicUrlId = useMutation("updatePhotoPublicUrlId");
  const [title, setTitle] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [publish, setPublish] = useState(false);
  const [message, setMessage] = useState("");
  const isGoogleUser = session.auth?.provider === "google";

  async function signInWithGoogle() {
    setMessage("");
    const result = await auth.signIn("google");
    if (result.error) setMessage(result.error.message);
  }

  async function signOut() {
    setMessage("");
    const result = await auth.signOut();
    if (result.error) setMessage(result.error.message);
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (!selectedFile) return;
    setMessage("Uploading...");
    try {
      const file = await files.upload(selectedFile);
      const shouldPublish = !session.isAuthenticated() || publish;
      const publicUrl = shouldPublish ? await files.publicUrl(file.id, { noExpiry: true }) : null;
      const result = await recordPhoto.run({
        title,
        file,
        isPublic: shouldPublish,
        publicUrl,
      });
      if (result.error) {
        setMessage(result.error.message);
        return;
      }
      setTitle("");
      setSelectedFile(null);
      setPublish(false);
      setMessage(shouldPublish ? "Photo added to the public gallery." : "Photo saved privately.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed.");
    }
  }

  async function makePublic(photo) {
    setMessage("");
    try {
      const publicUrl = await files.publicUrl(photo.fileId, { noExpiry: true });
      await updatePhotoImageUrl.run(photo.id, publicUrl.url);
      await updatePhotoPublicUrlId.run(photo.id, publicUrl.id);
      await updatePhotoIsPublic.run(photo.id, true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not publish photo.");
    }
  }

  async function makePrivate(photo) {
    setMessage("");
    try {
      if (photo.publicUrlId) await files.revokePublicUrl(photo.publicUrlId);
      await updatePhotoIsPublic.run(photo.id, false);
      await updatePhotoImageUrl.run(photo.id, "");
      await updatePhotoPublicUrlId.run(photo.id, "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not hide photo.");
    }
  }

  const gallery = publicPhotos.data ?? [];
  const mine = isGoogleUser ? personalPhotos.data ?? [] : [];

  return (
    <main class="shell">
      <style>{styles}</style>
      <header class="topbar">
        <div>
          <p class="eyebrow">Sporades Storage</p>
          <h1>Photo Library</h1>
        </div>
        <div class="auth-panel">
          <span>{session.auth?.displayName ?? "Anonymous"}</span>
          {isGoogleUser ? (
            <button class="secondary-button" type="button" onClick={signOut}>
              Sign out
            </button>
          ) : (
            <button type="button" onClick={signInWithGoogle}>
              Sign in with Google
            </button>
          )}
        </div>
      </header>

      <form class="uploader" onSubmit={submit}>
        <input value={title} placeholder="Caption" onInput={(event) => setTitle(event.currentTarget.value)} />
        <input
          type="file"
          accept="image/*"
          onChange={(event) => setSelectedFile(event.currentTarget.files?.[0] ?? null)}
        />
        <label class={session.isAuthenticated() ? "check" : "check muted"}>
          <input
            type="checkbox"
            checked={!session.isAuthenticated() || publish}
            disabled={!session.isAuthenticated()}
            onChange={(event) => setPublish(event.currentTarget.checked)}
          />
          {session.isAuthenticated() ? "Publish to gallery" : "Anonymous uploads are public"}
        </label>
        <button type="submit" disabled={!selectedFile || recordPhoto.loading}>
          Upload photo
        </button>
        {message ? <p class="message">{message}</p> : null}
      </form>

      <section>
        <h2>Public gallery</h2>
        <div class="grid">
          {gallery.map((photo) => (
            <article class="photo" key={photo.id}>
              <img src={photo.imageUrl} alt={photo.title} />
              <div>
                <strong>{photo.title}</strong>
                <span>{photo.ownerName}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      {isGoogleUser ? (
        <section>
          <h2>My library</h2>
          <div class="list">
            {mine.map((photo) => (
              <article class="library-row" key={photo.id}>
                <div>
                  <strong>{photo.title}</strong>
                  <span>{photo.status}</span>
                </div>
                {photo.isPublic ? (
                  <button class="secondary-button" type="button" onClick={() => makePrivate(photo)}>
                    Make private
                  </button>
                ) : (
                  <button type="button" onClick={() => makePublic(photo)}>
                    Make public
                  </button>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

render(<App />, document.getElementById("app")!);

const styles = \`
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; background: #f7f7f2; color: #20231f; }
  .shell { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 40px 0; }
  .topbar { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
  .eyebrow { margin: 0 0 6px; color: #35605a; font-size: 0.78rem; font-weight: 800; text-transform: uppercase; }
  h1 { margin: 0; font-size: clamp(2.2rem, 7vw, 5rem); line-height: 0.95; }
  h2 { margin: 32px 0 14px; font-size: 1.1rem; }
  .auth-panel, .uploader, .check, .library-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .auth-panel { justify-content: flex-end; }
  .uploader { border: 1px solid #d8ddd2; background: white; border-radius: 8px; padding: 14px; }
  input:not([type="checkbox"]) { min-height: 40px; border: 1px solid #cfd7cc; border-radius: 8px; padding: 0 10px; font: inherit; }
  button { border: 0; border-radius: 8px; min-height: 40px; padding: 0 14px; background: #245f73; color: white; font: inherit; font-weight: 800; cursor: pointer; }
  .secondary-button { background: #4d5148; }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  .muted { color: #677065; }
  .message { flex-basis: 100%; margin: 0; color: #8a3f2d; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  .photo { border: 1px solid #d8ddd2; border-radius: 8px; background: white; overflow: hidden; }
  .photo img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: #dfe5dc; }
  .photo div, .library-row { padding: 12px; }
  .photo strong, .photo span, .library-row strong, .library-row span { display: block; }
  .photo span, .library-row span { color: #687266; font-size: 0.9rem; margin-top: 3px; }
  .list { display: grid; gap: 10px; }
  .library-row { justify-content: space-between; border: 1px solid #d8ddd2; border-radius: 8px; background: white; }
  @media (max-width: 700px) { .topbar { display: grid; } .auth-panel { justify-content: flex-start; } }
\`;
`;
  }

  return `import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { auth, createHooks, files } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });

function App() {
  const session = useAuth();
  const publicPhotos = useQuery("publicPhotos");
  const personalPhotos = useQuery("personalPhotos");
  const recordPhoto = useMutation("recordPhoto");
  const updatePhotoIsPublic = useMutation("updatePhotoIsPublic");
  const updatePhotoImageUrl = useMutation("updatePhotoImageUrl");
  const updatePhotoPublicUrlId = useMutation("updatePhotoPublicUrlId");
  const [title, setTitle] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [publish, setPublish] = useState(false);
  const [message, setMessage] = useState("");
  const isGoogleUser = session.auth?.provider === "google";

  async function signInWithGoogle() {
    setMessage("");
    const result = await auth.signIn("google");
    if (result.error) setMessage(result.error.message);
  }

  async function signOut() {
    setMessage("");
    const result = await auth.signOut();
    if (result.error) setMessage(result.error.message);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) return;
    setMessage("Uploading...");
    try {
      const file = await files.upload(selectedFile);
      const shouldPublish = !session.isAuthenticated() || publish;
      const publicUrl = shouldPublish ? await files.publicUrl(file.id, { noExpiry: true }) : null;
      const result = await recordPhoto.run({
        title,
        file,
        isPublic: shouldPublish,
        publicUrl,
      });
      if (result.error) {
        setMessage(result.error.message);
        return;
      }
      setTitle("");
      setSelectedFile(null);
      setPublish(false);
      setMessage(shouldPublish ? "Photo added to the public gallery." : "Photo saved privately.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed.");
    }
  }

  async function makePublic(photo) {
    setMessage("");
    try {
      const publicUrl = await files.publicUrl(photo.fileId, { noExpiry: true });
      await updatePhotoImageUrl.run(photo.id, publicUrl.url);
      await updatePhotoPublicUrlId.run(photo.id, publicUrl.id);
      await updatePhotoIsPublic.run(photo.id, true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not publish photo.");
    }
  }

  async function makePrivate(photo) {
    setMessage("");
    try {
      if (photo.publicUrlId) await files.revokePublicUrl(photo.publicUrlId);
      await updatePhotoIsPublic.run(photo.id, false);
      await updatePhotoImageUrl.run(photo.id, "");
      await updatePhotoPublicUrlId.run(photo.id, "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not hide photo.");
    }
  }

  const gallery = publicPhotos.data ?? [];
  const mine = isGoogleUser ? personalPhotos.data ?? [] : [];

  return (
    <main className="shell">
      <style>{styles}</style>
      <header className="topbar">
        <div>
          <p className="eyebrow">Sporades Storage</p>
          <h1>Photo Library</h1>
        </div>
        <div className="auth-panel">
          <span>{session.auth?.displayName ?? "Anonymous"}</span>
          {isGoogleUser ? (
            <button className="secondary-button" type="button" onClick={signOut}>
              Sign out
            </button>
          ) : (
            <button type="button" onClick={signInWithGoogle}>
              Sign in with Google
            </button>
          )}
        </div>
      </header>

      <form className="uploader" onSubmit={submit}>
        <input value={title} placeholder="Caption" onChange={(event) => setTitle(event.currentTarget.value)} />
        <input
          type="file"
          accept="image/*"
          onChange={(event) => setSelectedFile(event.currentTarget.files?.[0] ?? null)}
        />
        <label className={session.isAuthenticated() ? "check" : "check muted"}>
          <input
            type="checkbox"
            checked={!session.isAuthenticated() || publish}
            disabled={!session.isAuthenticated()}
            onChange={(event) => setPublish(event.currentTarget.checked)}
          />
          {session.isAuthenticated() ? "Publish to gallery" : "Anonymous uploads are public"}
        </label>
        <button type="submit" disabled={!selectedFile || recordPhoto.loading}>
          Upload photo
        </button>
        {message ? <p className="message">{message}</p> : null}
      </form>

      <section>
        <h2>Public gallery</h2>
        <div className="grid">
          {gallery.map((photo) => (
            <article className="photo" key={photo.id}>
              <img src={photo.imageUrl} alt={photo.title} />
              <div>
                <strong>{photo.title}</strong>
                <span>{photo.ownerName}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      {isGoogleUser ? (
        <section>
          <h2>My library</h2>
          <div className="list">
            {mine.map((photo) => (
              <article className="library-row" key={photo.id}>
                <div>
                  <strong>{photo.title}</strong>
                  <span>{photo.status}</span>
                </div>
                {photo.isPublic ? (
                  <button className="secondary-button" type="button" onClick={() => makePrivate(photo)}>
                    Make private
                  </button>
                ) : (
                  <button type="button" onClick={() => makePublic(photo)}>
                    Make public
                  </button>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);

const styles = \`
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; background: #f7f7f2; color: #20231f; }
  .shell { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 40px 0; }
  .topbar { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
  .eyebrow { margin: 0 0 6px; color: #35605a; font-size: 0.78rem; font-weight: 800; text-transform: uppercase; }
  h1 { margin: 0; font-size: clamp(2.2rem, 7vw, 5rem); line-height: 0.95; }
  h2 { margin: 32px 0 14px; font-size: 1.1rem; }
  .auth-panel, .uploader, .check, .library-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .auth-panel { justify-content: flex-end; }
  .uploader { border: 1px solid #d8ddd2; background: white; border-radius: 8px; padding: 14px; }
  input:not([type="checkbox"]) { min-height: 40px; border: 1px solid #cfd7cc; border-radius: 8px; padding: 0 10px; font: inherit; }
  button { border: 0; border-radius: 8px; min-height: 40px; padding: 0 14px; background: #245f73; color: white; font: inherit; font-weight: 800; cursor: pointer; }
  .secondary-button { background: #4d5148; }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  .muted { color: #677065; }
  .message { flex-basis: 100%; margin: 0; color: #8a3f2d; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  .photo { border: 1px solid #d8ddd2; border-radius: 8px; background: white; overflow: hidden; }
  .photo img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: #dfe5dc; }
  .photo div, .library-row { padding: 12px; }
  .photo strong, .photo span, .library-row strong, .library-row span { display: block; }
  .photo span, .library-row span { color: #687266; font-size: 0.9rem; margin-top: 3px; }
  .list { display: grid; gap: 10px; }
  .library-row { justify-content: space-between; border: 1px solid #d8ddd2; border-radius: 8px; background: white; }
  @media (max-width: 700px) { .topbar { display: grid; } .auth-panel { justify-content: flex-start; } }
\`;
`;
}

function agentsTemplate(template: any) {
  return `# Sporades App Instructions

This directory is for a Sporades app. Sporades is a CLI-first tool for building and running full-stack web apps.

Template: ${template}

## Rules

- Server code goes in \`server/\`, client code in \`client/\`, shared code in \`shared/\`.
- Use \`sporades/server\` only from \`server/*.ts\`.
- Use \`sporades/client\` only from \`client/*.tsx\`.
- Data is accessed through queries. Changes go through mutations.
- Use endpoints only for HTTP integrations that cannot use queries, mutations, or app messages.
- No file-based routing. Use the router included in the scaffold template.
- All imports must be from Sporades, the configured framework, or relative paths.
- Do not use Node built-ins in client code.
- Auth is available via \`ctx.auth\` on the server, \`useAuth()\` on the client.
- Server env vars: define in \`.env.sporades.server\`, access via \`ctx.env\`.
- Keep \`shared/\` free of DOM, Node, env, and Sporades runtime imports.

## Commands

\`\`\`sh
sporades dev
sporades deploy
sporades logs
sporades db list
sporades db dump
\`\`\`

## Structure

- \`server/index.ts\` - schema, queries, mutations
- \`client/index.tsx\` - UI entrypoint
- \`shared/\` - pure TypeScript shared by client and server
- \`index.html\` - HTML shell (user-owned)
- \`sporades.json\` - project configuration
`;
}

function escapeHtml(value: string) {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (char) => replacements[char] ?? char);
}
