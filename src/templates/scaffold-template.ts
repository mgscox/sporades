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
    <title>${escapeHtml(options.name)}</title>
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
    "server/index.ts": `import { Boolean, capsule, mutation, Number, query, String, table } from "sporades/server";

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
