export function scaffoldFiles(options) {
    const templateOptions = resolveTemplateOptions(options.template);
    const framework = options.framework ?? templateOptions.framework;
    const toolchain = options.toolchain ?? (["solid", "vue", "svelte"].includes(framework) ? "vite" : "esbuild");
    const renderOptions = { ...options, name: options.name, framework, toolchain };
    const packageName = options.name;
    const sporadesDependency = options.sporadesDependency ?? "sporades";
    const frameworkDependencies = framework === "react"
        ? {
            react: "^19.0.0",
            "react-dom": "^19.0.0",
        }
        : framework === "preact" ? {
            preact: "^10.25.0",
        } : framework === "vue" ? {
            vue: "^3.5.13",
        } : framework === "svelte" ? {
            svelte: "^5.0.0",
        } : framework === "solid" ? {
            "solid-js": "^1.9.0",
        } : {};
    const frameworkDevDependencies = framework === "react"
        ? {
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
        }
        : framework === "vue" ? {
            "@vitejs/plugin-vue": "^5.2.4",
            "@vue/compiler-sfc": "^3.5.13",
        } : framework === "svelte" ? {
            "@sveltejs/vite-plugin-svelte": "^5.1.1",
        } : framework === "solid" ? {
            "vite-plugin-solid": "^2.11.0",
        } : {};
    const baseTemplateFiles = framework === "vanilla" ? vanillaTemplateFiles(renderOptions) : templateOptions.files(renderOptions);
    const templateFiles = framework === "vue"
        ? vueTemplateFiles(renderOptions, baseTemplateFiles)
        : framework === "svelte"
            ? svelteTemplateFiles(renderOptions, baseTemplateFiles)
            : framework === "solid"
                ? solidTemplateFiles(renderOptions, baseTemplateFiles)
                : toolchain === "vite" && framework !== "vanilla"
                    ? viteTemplateFiles(baseTemplateFiles, framework)
                    : baseTemplateFiles;
    return {
        "sporades.json": `${JSON.stringify({
            name: options.name,
            template: options.template,
            client: { framework, toolchain },
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
        }, null, 2)}\n`,
        "package.json": `${JSON.stringify({
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
        }, null, 2)}\n`,
        "AGENTS.md": agentsTemplate(options.template, framework, toolchain),
        "CLAUDE.md": agentsTemplate(options.template, framework, toolchain),
        ".gitignore": "node_modules/\n.sporades/\n.env*.local\n",
        ".env.sporades.server": templateOptions.serverEnv,
        "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(options.name)}</title>${options.template === "campfire" && !["vue", "svelte"].includes(framework) ? `
    <script src="https://cdn.tailwindcss.com"></script>` : ""}
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="${toolchain === "vite" ? `/client/${framework === "vue" || framework === "svelte" ? "index.ts" : "index.tsx"}` : "/client.js"}"></script>
  </body>
</html>
`,
        ...templateFiles,
    };
}
function solidTemplateFiles(options, files) {
    const sharedFiles = Object.fromEntries(Object.entries(files).filter(([file]) => file !== "client/index.tsx"));
    return {
        ...sharedFiles,
        "README.md": `${sharedFiles["README.md"] ?? ""}\n## SolidJS client\n\nThe browser renders from \`client/index.tsx\`; author native Solid JSX in \`client/App.tsx\` and bind Sporades state through the Solid primitives in \`client/sporades.ts\`.\n`,
        "tsconfig.json": `${JSON.stringify({ compilerOptions: {
                target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true,
                jsx: "preserve", jsxImportSource: "solid-js", lib: ["ES2022", "DOM", "DOM.Iterable"], types: ["vite/client"], skipLibCheck: true,
            } }, null, 2)}\n`,
        "client/index.tsx": `import { render } from "solid-js/web";\nimport App from "./App";\nimport "./styles.css";\n\nrender(() => <App />, document.getElementById("app")!);\n`,
        "client/sporades.ts": `import { createSignal, onCleanup } from "solid-js";\nimport { createSolidPrimitives } from "sporades/client";\n\nexport const { createAuth, createMutation, createQuery } = createSolidPrimitives({ createSignal, onCleanup });\n`,
        "client/App.tsx": options.template === "todo" ? solidTodoAppTemplate() : solidBlankAppTemplate(),
        "client/styles.css": `:root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #15211d; background: #f2f7f4; }\nbody { margin: 0; }\nmain { width: min(42rem, calc(100% - 2rem)); margin: 5rem auto; }\n.mark { width: 2rem; height: 2rem; }\n`,
        "client/sporades-mark.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#2c8c69"/></svg>\n`,
    };
}
function solidBlankAppTemplate() {
    return `import { Show } from "solid-js";\nimport { createAuth } from "./sporades";\nimport mark from "./sporades-mark.svg";\n\nexport default function App() {\n  const session = createAuth();\n  return (\n    <main>\n      <img class="mark" src={mark} alt="" />\n      <h1>Blank Sporades Capsule</h1>\n      <Show when={!session.state().loading} fallback={<p>Connecting…</p>}>\n        <p>Start building in server/index.ts and client/App.tsx.</p>\n      </Show>\n    </main>\n  );\n}\n`;
}
function solidTodoAppTemplate() {
    return `import { createSignal, For, Show } from "solid-js";\nimport { auth } from "sporades/client";\nimport type { Todo } from "../shared/types";\nimport { createAuth, createMutation, createQuery } from "./sporades";\nimport mark from "./sporades-mark.svg";\n\nexport default function App() {\n  const session = createAuth();\n  const todos = createQuery<Todo[]>("todos");\n  const addTodo = createMutation("addTodo");\n  const [text, setText] = createSignal("");\n\n  async function submit(event: SubmitEvent) {\n    event.preventDefault();\n    const value = text().trim();\n    if (!value) return;\n    const result = await addTodo.run(value);\n    if (!result.error) setText("");\n  }\n\n  return (\n    <main>\n      <header><img class="mark" src={mark} alt="" /><h1>Sporades Todos</h1></header>\n      <Show when={session.state().providers.google?.enabled && !session.isAuthenticated()}>\n        <button type="button" onClick={() => auth.signIn("google")}>Sign in with Google</button>\n      </Show>\n      <form onSubmit={submit}>\n        <input aria-label="Todo" value={text()} onInput={(event) => setText(event.currentTarget.value)} />\n        <button disabled={addTodo.state().loading}>Add</button>\n      </form>\n      <Show when={!todos().loading} fallback={<p>Loading…</p>}>\n        <Show when={!todos().error} fallback={<p role="alert">{todos().error?.message}</p>}>\n          <ul><For each={todos().data ?? []}>{(todo) => <li>{todo.text}</li>}</For></ul>\n        </Show>\n      </Show>\n    </main>\n  );\n}\n`;
}
function svelteTemplateFiles(options, files) {
    const sharedFiles = Object.fromEntries(Object.entries(files).filter(([file]) => !file.endsWith(".tsx")));
    const apps = {
        todo: svelteTodoAppTemplate,
        guestbook: svelteGuestbookAppTemplate,
        "photo-library": sveltePhotoLibraryAppTemplate,
        campfire: svelteCampfireAppTemplate,
    };
    const readme = `${sharedFiles["README.md"] ?? ""}\n## Svelte client\n\nThe browser mounts from \`client/index.ts\`; author the native component in \`client/App.svelte\` and bind Sporades state through the stores in \`client/sporades.ts\`.\n`.replace(/Tailwind is loaded from its browser CDN[^\n]+\n/, "Campfire's Svelte component owns its CSS and needs no browser CDN or React component package.\n");
    return {
        ...sharedFiles,
        "README.md": readme,
        "client/index.ts": `import { mount } from "svelte";\nimport App from "./App.svelte";\n\nmount(App, { target: document.getElementById("app")! });\n`,
        "client/sporades.ts": `import { createSvelteStores } from "sporades/client";\n\nexport const { authStore, mutationStore, queryStore } = createSvelteStores();\n`,
        "client/App.svelte": (apps[options.template] ?? svelteBlankAppTemplate)(),
        "client/sporades-mark.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#ff3e00"/></svg>\n`,
    };
}
function svelteBlankAppTemplate() {
    return `<script lang="ts">
  import { authStore } from "./sporades";
  import mark from "./sporades-mark.svg";
  const session = authStore();
</script>

<main>
  <img class="mark" src={mark} alt="" />
  <h1>Blank Sporades Capsule</h1>
  {#if $session.loading}<p>Connecting…</p>{:else}<p>Start building in server/index.ts and client/App.svelte.</p>{/if}
</main>

<style>
  main { max-width: 42rem; margin: 4rem auto; font-family: system-ui, sans-serif; }
  .mark { width: 2rem; height: 2rem; }
</style>
`;
}
function svelteTodoAppTemplate() {
    return `<script lang="ts">
  import { auth } from "sporades/client";
  import { authStore, mutationStore, queryStore } from "./sporades";
  import mark from "./sporades-mark.svg";
  const session = authStore();
  const todos = queryStore("todos");
  const addTodo = mutationStore("addTodo");
  let text = "";
  async function submit() {
    const value = text.trim();
    if (!value) return;
    const result = await addTodo.run(value);
    if (!result.error) text = "";
  }
</script>

<main>
  <header><img class="mark" src={mark} alt="" /><h1>Sporades Todos</h1></header>
  {#if $session.providers.google?.enabled && !$session.isAuthenticated()}<button type="button" onclick={() => auth.signIn("google")}>Sign in with Google</button>{/if}
  <form onsubmit={(event) => { event.preventDefault(); submit(); }}><input bind:value={text} aria-label="Todo" /><button disabled={$addTodo.loading}>Add</button></form>
  {#if $todos.loading}<p>Loading…</p>{:else if $todos.error}<p role="alert">{$todos.error.message}</p>{:else}<ul>{#each $todos.data ?? [] as todo (todo.id)}<li>{todo.text}</li>{/each}</ul>{/if}
</main>

<style>
  main { max-width: 42rem; margin: 3rem auto; font-family: system-ui, sans-serif; }
  header, form { display: flex; gap: .75rem; align-items: center; }
  .mark { width: 2rem; height: 2rem; }
  li { margin-block: .5rem; }
</style>
`;
}
function svelteGuestbookAppTemplate() {
    return `<script lang="ts">
  import { auth } from "sporades/client";
  import { authStore, mutationStore, queryStore } from "./sporades";
  import mark from "./sporades-mark.svg";
  const session = authStore();
  const entries = queryStore("entries");
  const sign = mutationStore("sign");
  const maxLength = 280;
  let body = "";
  let authError = "";
  async function signIn() { authError = ""; const result = await auth.signIn("google"); if (result.error) authError = result.error.message; }
  async function signOut() { authError = ""; const result = await auth.signOut(); if (result.error) authError = result.error.message; }
  async function submit() { const message = body.trim(); if (!message || message.length > maxLength) return; const result = await sign.run(message); if (!result.error) body = ""; }
  function initials(name: string) { return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?"; }
</script>

<main class="shell">
  <section class="intro"><div><img class="mark" src={mark} alt="" /><p class="eyebrow">Sporades guestbook</p><h1>Leave a note from this island.</h1></div><div class="auth-panel"><span>{$session.auth?.displayName ?? "Anonymous"}</span>{#if !$session.isAuthenticated()}<button type="button" onclick={signIn}>Sign in with Google</button>{:else}<button class="secondary" type="button" onclick={signOut}>Sign out</button>{/if}{#if authError}<p class="error">{authError}</p>{/if}</div></section>
  <form onsubmit={(event) => { event.preventDefault(); submit(); }}><textarea bind:value={body} maxlength={maxLength} placeholder="Write something kind, sharp, or strangely memorable."></textarea><div class="row"><span>{maxLength - body.length} characters left</span><button disabled={!body.trim() || $sign.loading}>Sign guestbook</button></div>{#if $sign.error}<p class="error">{$sign.error.message}</p>{/if}</form>
  {#if $entries.loading}<p>Loading…</p>{:else if $entries.error}<p class="error" role="alert">{$entries.error.message}</p>{:else}<section class="entries">{#each $entries.data ?? [] as entry (entry.id)}<article><span class="badge">{entry.authorPicture ? "" : initials(entry.authorName)}</span>{#if entry.authorPicture}<img src={entry.authorPicture} alt="" />{/if}<div><strong>{entry.authorName}</strong><time datetime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time><p>{entry.body}</p></div></article>{/each}</section>{/if}
</main>
<style>
  :global(body){margin:0;background:#f6f3ed;color:#25211b;font-family:system-ui,sans-serif}.shell{width:min(920px,calc(100% - 32px));margin:auto;padding:48px 0}.intro,.row,.auth-panel{display:flex;justify-content:space-between;gap:16px;align-items:center}.mark{width:2rem}.eyebrow{color:#7a4b28;font-weight:700}h1{font-size:clamp(2rem,6vw,4.8rem);margin:0}form,article{background:white;border:1px solid #ded6ca;border-radius:8px;padding:16px;margin-top:24px}textarea{width:100%;min-height:116px;box-sizing:border-box}button{border:0;border-radius:8px;background:#176b61;color:white;padding:12px 16px;font-weight:700}.secondary{background:#51483d}.entries{display:grid;gap:12px}.entries article{display:grid;grid-template-columns:48px 1fr;gap:14px}.badge{display:grid;place-items:center;background:#25211b;color:white;border-radius:50%;width:48px;height:48px}.error{color:#a33b28}time{margin-left:10px;color:#73695b}
</style>
`;
}
function sveltePhotoLibraryAppTemplate() {
    return `<script lang="ts">
  import { auth, files } from "sporades/client";
  import { authStore, mutationStore, queryStore } from "./sporades";
  import mark from "./sporades-mark.svg";
  const session = authStore();
  const publicPhotos = queryStore("publicPhotos"); const personalPhotos = queryStore("personalPhotos");
  const recordPhoto = mutationStore("recordPhoto"); const updatePhotoIsPublic = mutationStore("updatePhotoIsPublic"); const updatePhotoImageUrl = mutationStore("updatePhotoImageUrl"); const updatePhotoPublicUrlId = mutationStore("updatePhotoPublicUrlId");
  let title = "", selectedFile: File | null = null, publish = false, message = "";
  $: isGoogleUser = $session.auth?.provider === "google";
  async function signIn() { message = ""; const result = await auth.signIn("google"); if (result.error) message = result.error.message; }
  async function signOut() { message = ""; const result = await auth.signOut(); if (result.error) message = result.error.message; }
  async function requireMutation(store: any,...args: any[]){const result=await store.run(...args);if(result.error)throw result.error;return result;}
  async function submit() { if (!selectedFile) return; message = "Uploading..."; try { const file = await files.upload(selectedFile); const shouldPublish = !$session.isAuthenticated() || publish; const publicUrl = shouldPublish ? await files.publicUrl(file.id,{noExpiry:true}) : null; const result = await recordPhoto.run({title,file,isPublic:shouldPublish,publicUrl}); if (result.error) { message=result.error.message; return; } title="";selectedFile=null;publish=false;message=shouldPublish?"Photo added to the public gallery.":"Photo saved privately."; } catch(error){message=error instanceof Error?error.message:"Upload failed.";} }
  async function makePublic(photo: any){ try{const publicUrl=await files.publicUrl(photo.fileId,{noExpiry:true});await requireMutation(updatePhotoImageUrl,photo.id,publicUrl.url);await requireMutation(updatePhotoPublicUrlId,photo.id,publicUrl.id);await requireMutation(updatePhotoIsPublic,photo.id,true);}catch(error){message=error instanceof Error?error.message:"Could not publish photo.";} }
  async function makePrivate(photo: any){ try{if(photo.publicUrlId)await files.revokePublicUrl(photo.publicUrlId);await requireMutation(updatePhotoIsPublic,photo.id,false);await requireMutation(updatePhotoImageUrl,photo.id,"");await requireMutation(updatePhotoPublicUrlId,photo.id,"");}catch(error){message=error instanceof Error?error.message:"Could not hide photo.";} }
</script>
<main class="shell"><header><div><img class="mark" src={mark} alt=""/><p>Sporades Storage</p><h1>Photo Library</h1></div><div><span>{$session.auth?.displayName??"Anonymous"}</span>{#if isGoogleUser}<button onclick={signOut}>Sign out</button>{:else}<button onclick={signIn}>Sign in with Google</button>{/if}</div></header>
<form onsubmit={(event)=>{event.preventDefault();submit();}}><input bind:value={title} placeholder="Caption"/><input type="file" accept="image/*" onchange={(event)=>selectedFile=event.currentTarget.files?.[0]??null}/><label><input type="checkbox" bind:checked={publish} disabled={!$session.isAuthenticated()}/>{$session.isAuthenticated()?"Publish to gallery":"Anonymous uploads are public"}</label><button disabled={!selectedFile||$recordPhoto.loading}>Upload photo</button>{#if message}<p>{message}</p>{/if}</form>
<section><h2>Public gallery</h2><div class="grid">{#each $publicPhotos.data??[] as photo(photo.id)}<article><img src={photo.imageUrl} alt={photo.title}/><strong>{photo.title}</strong><span>{photo.ownerName}</span></article>{/each}</div></section>
{#if isGoogleUser}<section><h2>My library</h2>{#each $personalPhotos.data??[] as photo(photo.id)}<article class="library"><div><strong>{photo.title}</strong><span>{photo.status}</span></div>{#if photo.isPublic}<button onclick={()=>makePrivate(photo)}>Make private</button>{:else}<button onclick={()=>makePublic(photo)}>Make public</button>{/if}</article>{/each}</section>{/if}</main>
<style>:global(body){margin:0;background:#f7f7f2;font-family:system-ui,sans-serif}.shell{width:min(1080px,calc(100% - 32px));margin:auto;padding:40px 0}header,header div,form,.library{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.mark{width:2rem}h1{font-size:clamp(2.2rem,7vw,5rem);margin:0}form,.library{background:white;border:1px solid #d8ddd2;border-radius:8px;padding:14px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}.grid article{background:white}.grid img{width:100%;aspect-ratio:4/3;object-fit:cover}button{background:#245f73;color:white;border:0;border-radius:8px;padding:12px}</style>
`;
}
function svelteCampfireAppTemplate() {
    return `<script lang="ts">
  import { onMount } from "svelte";
  import { auth, journey, preferences } from "sporades/client";
  import { authStore, mutationStore, queryStore } from "./sporades";
  import { createTypingPublisher } from "./journey-typing";
  import mark from "./sporades-mark.svg";
  const session=authStore(), profiles=queryStore("profiles"), general=queryStore("messagesGeneral"), ideas=queryStore("messagesIdeas"), random=queryStore("messagesRandom"), crown=queryStore("messagesProtectTheCrown");
  const sendMessage=mutationStore("sendMessage"),toggleReaction=mutationStore("toggleReaction"),seedCampfire=mutationStore("seedCampfire"),registerFixture=mutationStore("registerFixture");
  const musketeers=[{key:"athos",name:"Athos",email:"athos@campfire.example"},{key:"porthos",name:"Porthos",email:"porthos@campfire.example"},{key:"aramis",name:"Aramis",email:"aramis@campfire.example"},{key:"dartagnan",name:"d'Artagnan",email:"dartagnan@campfire.example"}];
  const channels=["general","ideas","random","protect-the-crown"],password="all-for-one-campfire";
  let channel="general",draft="",notice="",sharing=false,activities:any[]=[],fixturesPrepared=false,fixturePreparationActive=false;
  $: messages=channel==="general"?$general:channel==="ideas"?$ideas:channel==="random"?$random:$crown;
  $: if(!fixturesPrepared&&Array.isArray($profiles.data)){fixturesPrepared=true;if(isLocalDemoOrigin())void prepareFixtures(musketeers.filter((person)=>!new Set(($profiles.data??[]).map((profile:any)=>profile.key)).has(person.key)));}
  const typingPublisher=createTypingPublisher((state)=>journey.set(state));
  let generation=0,owner:number|null=null,tail=Promise.resolve(),previousUserId:string|undefined;
  const current=(value:number,userId:string)=>value===generation&&$session.auth?.userId===userId;
  async function lane<T>(action:()=>Promise<T>){const before=tail;let release=()=>{};tail=new Promise<void>((resolve)=>release=resolve);await before;try{return await action();}finally{release();}}
  async function retire(expected:number|null=null){typingPublisher.dispose();sharing=false;if(owner===null||(expected!==null&&owner!==expected))return;owner=null;const result=await journey.disable();if(result?.error)notice=result.error.message;}
  async function enable(value:number,userId:string,expose=true){const result=await journey.enable({capture:{navigation:false,focus:false,interactions:false}});if(result.error){notice=result.error.message;return false;}owner=value;if(!current(value,userId)){await retire(value);return false;}const published=await journey.set({status:"reading",metadata:{channel},ttlSeconds:12});if(published?.error){notice=published.error.message;await retire(value);return false;}if(!current(value,userId)){await retire(value);return false;}if(expose)sharing=true;return true;}
  async function authChanged(userId:string|undefined,oldUserId:string|undefined){const value=++generation;await lane(async()=>{if(oldUserId&&oldUserId!==userId)await retire();if(!userId||$session.auth?.isGuest||fixturePreparationActive||!current(value,userId))return;const stored=await preferences.get();if(!current(value,userId)||stored.error||stored.data.preferences.campfireShareActivity!==true)return;if(await enable(value,userId)&&current(value,userId))notice="Activity sharing restored for this Musketeer.";});}
  function isLocalDemoOrigin(hostname=window.location.hostname){return["localhost","127.0.0.1","::1"].includes(hostname);}
  async function prepareFixtures(people=musketeers){fixturePreparationActive=true;++generation;await lane(()=>retire());for(const person of people){let result=await auth.signUp("email",{email:person.email,password,name:person.name});if(result.error&&/already|exists|registered/i.test(result.error.message))result=await auth.signIn("email",{email:person.email,password});if(result.error){notice="Could not prepare "+person.name+": "+result.error.message;fixturePreparationActive=false;return;}const registered=await registerFixture.run(person.key);if(registered.error){notice=registered.error.message;fixturePreparationActive=false;return;}await lane(()=>retire());await auth.signOut();}fixturePreparationActive=false;const seeded=await seedCampfire.run();notice=seeded.error?seeded.error.message:"Development-only fixtures ready.";}
  async function setShare(enabled:boolean){const userId=$session.auth?.userId,value=++generation;sharing=false;if(!userId){notice="Sign in before sharing activity.";return;}await lane(async()=>{if(!current(value,userId))return;if(enabled){if(!await enable(value,userId,false)||!current(value,userId)){await retire(value);return;}}else{await retire();if(!current(value,userId))return;}const saved=await preferences.update({campfireShareActivity:enabled});if(saved?.error){notice=saved.error.message;if(enabled)await retire(value);return;}if(!current(value,userId)){if(enabled)await retire(value);return;}sharing=enabled;});}
  async function choose(next:string){typingPublisher.dispose();channel=next;if(sharing)await journey.set({status:"reading",metadata:{channel:next},ttlSeconds:12});}
  function compose(){if(sharing)typingPublisher.input(draft,channel);}
  async function submit(){const result=await sendMessage.run({channel,body:draft});if(result.error){notice=result.error.message;return;}draft="";if(sharing){typingPublisher.dispose();await journey.set({status:"posted",metadata:{channel},ttlSeconds:8});}}
  async function react(messageId:string,kind:string){const result=await toggleReaction.run({messageId,kind});if(result.error){notice=result.error.message;return;}if(sharing)await journey.set({status:kind==="up"?"liked":"disliked",metadata:{channel},ttlSeconds:8});}
  async function switchTo(person:any){++generation;await lane(()=>retire());await auth.signOut();const result=await auth.signIn("email",{email:person.email,password});notice=result.error?result.error.message:"Signed in as "+person.name+". Restoring activity preference…";}
  function apply(event:any){const data=event?.data??event;if(data?.type==="snapshot")return data.states??[];if(data?.type==="removed"||data?.type==="expired")return activities.filter((item)=>item.sessionId!==data.state?.sessionId);return data?.state?[...activities.filter((item)=>item.sessionId!==data.state.sessionId),data.state]:activities;}
  function activityText(item:any){const name=($profiles.data??[]).find((profile:any)=>profile.userId===item.userId)?.name??"A Musketeer",place=item.metadata?.channel??"campfire";return item.status==="posted"?name+" posted a message in #"+place:item.status==="liked"?name+" liked a message in #"+place:item.status==="disliked"?name+" disliked a message in #"+place:name+" is "+item.status+" #"+place;}
  function reactionCount(message:any,kind:string){return Object.keys(message.reactions??{}).filter((key)=>key.endsWith(":"+kind)).length;}
  onMount(()=>{const stopAuth=session.subscribe((state)=>{const userId=state.auth?.userId;if(userId!==previousUserId){const old=previousUserId;previousUserId=userId;void authChanged(userId,old);}});const stopJourney=journey.subscribe((event)=>activities=apply(event)).unsubscribe;return()=>{stopAuth();stopJourney();++generation;void lane(()=>retire());};});
</script>
<main class="campfire"><aside><img class="mark" src={mark} alt=""/><h1>🔥 Campfire</h1><nav>{#each channels as slug}<button class:active={channel===slug} onclick={()=>choose(slug)}># {slug}</button>{/each}</nav><p>Development-only Musketeer identities. Never expose known credentials publicly.</p></aside>
<section class="conversation"><header><h2># {channel}</h2><p role="status">{notice}</p></header><div class="messages">{#each messages.data??[] as message(message.id)}<article><strong>{message.authorName}</strong><time>{new Date(message.createdAt).toLocaleString()}</time><p>{message.body}</p><button disabled={$toggleReaction.loading} aria-label={"Thumbs up: "+reactionCount(message,"up")} onclick={()=>react(message.id,"up")}>👍 {reactionCount(message,"up")}</button><button disabled={$toggleReaction.loading} aria-label={"Thumbs down: "+reactionCount(message,"down")} onclick={()=>react(message.id,"down")}>👎 {reactionCount(message,"down")}</button></article>{/each}</div><form onsubmit={(event)=>{event.preventDefault();submit();}}><input id="message" bind:value={draft} oninput={compose} placeholder={"Message #"+channel}/><button disabled={$sendMessage.loading||!draft.trim()}>Send</button></form></section>
<aside><h2>What's happening</h2><label><input type="checkbox" bind:checked={sharing} onchange={(event)=>setShare(event.currentTarget.checked)}/>Share my activity</label><p>Shares reading, typing, posting, likes, dislikes, and channel. Never drafts, messages, URLs, query strings, emails, passwords, message IDs, or keystrokes.</p><ul>{#each activities as item(item.sessionId)}<li>{activityText(item)}</li>{/each}</ul><h3>Switch Musketeer</h3>{#each musketeers as person(person.key)}<button onclick={()=>switchTo(person)}>{person.name}</button>{/each}</aside></main>
<style>:global(body){margin:0;background:#120d0a;color:#fff7ed;font-family:system-ui,sans-serif}.campfire{min-height:100vh;display:grid;grid-template-columns:240px minmax(0,1fr) 300px}.campfire>aside,.conversation>header,.conversation>form{padding:20px;background:#1b120d}.mark{width:2rem}nav,.campfire>aside{display:grid;align-content:start;gap:9px}button,input{border:1px solid #92400e;border-radius:7px;padding:9px 12px;background:#29211d;color:inherit}.active{background:#b45309}.conversation{display:flex;flex-direction:column}.messages{flex:1;padding:20px;display:grid;align-content:start;gap:14px}.messages article{padding:16px;border:1px solid #78350f;border-radius:9px}.messages time{margin-left:10px;color:#fde68a99}.conversation form{display:flex;gap:8px}.conversation input{flex:1}@media(max-width:900px){.campfire{grid-template-columns:1fr}}</style>
`;
}
function vueTemplateFiles(options, files) {
    const sharedFiles = Object.fromEntries(Object.entries(files).filter(([file]) => !file.endsWith(".tsx")));
    const apps = {
        todo: vueTodoAppTemplate,
        guestbook: vueGuestbookAppTemplate,
        "photo-library": vuePhotoLibraryAppTemplate,
        campfire: vueCampfireAppTemplate,
    };
    const app = apps[options.template] ?? vueBlankAppTemplate;
    const readme = `${sharedFiles["README.md"] ?? ""}
## Vue client

The browser UI mounts from \`client/index.ts\` and is authored as a native Vue Single-File Component in \`client/App.vue\`. Styles are scoped by Vue and the Capsule uses the Sporades Vue composables from \`client/sporades.ts\`.
`.replace(/Tailwind is loaded from its browser CDN[^\n]+\n/, "Campfire's Vue Single-File Component owns its scoped CSS and needs no browser CDN or React component package.\n");
    return {
        ...sharedFiles,
        "README.md": readme,
        "client/index.ts": `import { createApp } from "vue";\nimport App from "./App.vue";\n\ncreateApp(App).mount("#app");\n`,
        "client/sporades.ts": `import { onScopeDispose, reactive } from "vue";\nimport { createVueComposables } from "sporades/client";\n\nexport const { useAuth, useMutation, useQuery } = createVueComposables({ reactive, onScopeDispose });\n`,
        "client/App.vue": app(),
        "client/sporades-mark.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#42b883"/></svg>\n`,
    };
}
function vueBlankAppTemplate() {
    return `<script setup lang="ts">
import { useAuth } from "./sporades";

const session = useAuth();
</script>

<template>
  <main>
    <img class="mark" src="./sporades-mark.svg" alt="" />
    <h1>Blank Sporades Capsule</h1>
    <p v-if="session.loading">Connecting…</p>
    <p v-else>Start building in server/index.ts and client/App.vue.</p>
  </main>
</template>

<style scoped>
main { max-width: 42rem; margin: 4rem auto; font-family: system-ui, sans-serif; }
.mark { width: 2rem; height: 2rem; }
</style>
`;
}
function vueTodoAppTemplate() {
    return `<script setup lang="ts">
import { ref } from "vue";
import { auth } from "sporades/client";
import { useAuth, useMutation, useQuery } from "./sporades";

const session = useAuth();
const todos = useQuery("todos");
const addTodo = useMutation("addTodo");
const text = ref("");

async function submit() {
  const value = text.value.trim();
  if (!value) return;
  const result = await addTodo.run(value);
  if (!result.error) text.value = "";
}
</script>

<template>
  <main>
    <header><img class="mark" src="./sporades-mark.svg" alt="" /><h1>Sporades Todos</h1></header>
    <button v-if="session.providers.google?.enabled && !session.isAuthenticated()" type="button" @click="auth.signIn('google')">Sign in with Google</button>
    <form @submit.prevent="submit"><input v-model="text" aria-label="Todo" /><button :disabled="addTodo.loading">Add</button></form>
    <p v-if="todos.loading">Loading…</p>
    <p v-else-if="todos.error" role="alert">{{ todos.error.message }}</p>
    <ul v-else><li v-for="todo in todos.data ?? []" :key="todo.id">{{ todo.text }}</li></ul>
  </main>
</template>

<style scoped>
main { max-width: 42rem; margin: 3rem auto; font-family: system-ui, sans-serif; }
header, form { display: flex; gap: .75rem; align-items: center; }
.mark { width: 2rem; height: 2rem; }
li { margin-block: .5rem; }
</style>
`;
}
function vueGuestbookAppTemplate() {
    return `<script setup lang="ts">
import { computed, ref } from "vue";
import { auth } from "sporades/client";
import { useAuth, useMutation, useQuery } from "./sporades";

const maxLength = 280;
const session = useAuth();
const entries = useQuery("entries");
const sign = useMutation("sign");
const body = ref("");
const authError = ref("");
const remaining = computed(() => maxLength - body.value.length);

async function signInWithGoogle() {
  authError.value = "";
  const result = await auth.signIn("google");
  if (result.error) authError.value = result.error.message;
}

async function signOut() {
  authError.value = "";
  const result = await auth.signOut();
  if (result.error) authError.value = result.error.message;
}

async function submit() {
  const message = body.value.trim();
  if (!message || message.length > maxLength) return;
  const result = await sign.run(message);
  if (!result.error) body.value = "";
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}
</script>

<template>
  <main class="shell">
    <section class="intro">
      <div><img class="mark" src="./sporades-mark.svg" alt="" /><p class="eyebrow">Sporades guestbook</p><h1>Leave a note from this island.</h1></div>
      <div class="auth-panel">
        <span>{{ session.auth?.displayName ?? "Anonymous" }}</span>
        <button v-if="!session.isAuthenticated()" type="button" @click="signInWithGoogle">Sign in with Google</button>
        <button v-else class="secondary-button" type="button" @click="signOut">Sign out</button>
        <p v-if="authError" class="error">{{ authError }}</p>
      </div>
    </section>
    <form class="composer" @submit.prevent="submit">
      <textarea v-model="body" :maxlength="maxLength" placeholder="Write something kind, sharp, or strangely memorable." />
      <div class="composer-row"><span>{{ remaining }} characters left</span><button :disabled="!body.trim() || sign.loading">Sign guestbook</button></div>
      <p v-if="sign.error" class="error">{{ sign.error.message }}</p>
    </form>
    <p v-if="entries.loading">Loading…</p>
    <p v-else-if="entries.error" class="error" role="alert">{{ entries.error.message }}</p>
    <section v-else class="entries">
      <article v-for="entry in entries.data ?? []" :key="entry.id" class="entry">
        <img v-if="entry.authorPicture" :src="entry.authorPicture" alt="" />
        <span v-else class="author-badge">{{ initials(entry.authorName) }}</span>
        <div><div class="entry-meta"><strong>{{ entry.authorName }}</strong><time :datetime="entry.createdAt">{{ new Date(entry.createdAt).toLocaleString() }}</time></div><p>{{ entry.body }}</p></div>
      </article>
    </section>
  </main>
</template>

<style scoped>
:global(body) { margin: 0; background: #f6f3ed; color: #25211b; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.shell { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
.intro, .composer-row, .auth-panel, .entry-meta { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.eyebrow { color: #7a4b28; font-size: .8rem; font-weight: 700; text-transform: uppercase; }
.mark { width: 2rem; height: 2rem; }
h1 { margin: 0; font-size: clamp(2rem, 6vw, 4.8rem); line-height: .95; }
button { border: 0; border-radius: 8px; background: #176b61; color: white; min-height: 42px; padding: 0 16px; font: inherit; font-weight: 700; }
.secondary-button { background: #51483d; }
.composer, .entry { background: white; border: 1px solid #ded6ca; border-radius: 8px; padding: 16px; margin-top: 24px; }
textarea { width: 100%; min-height: 116px; box-sizing: border-box; padding: 12px; font: inherit; }
.entries { display: grid; gap: 12px; }.entry { display: grid; grid-template-columns: 48px 1fr; gap: 14px; margin-top: 0; }
.entry img, .author-badge { width: 48px; height: 48px; border-radius: 50%; }.author-badge { display: grid; place-items: center; background: #25211b; color: white; }
.error { color: #a33b28; } time { color: #73695b; font-size: .88rem; }
@media (max-width: 680px) { .intro, .composer-row { display: grid; }.auth-panel { justify-content: flex-start; } }
</style>
`;
}
function vuePhotoLibraryAppTemplate() {
    return `<script setup lang="ts">
import { computed, ref } from "vue";
import { auth, files } from "sporades/client";
import { useAuth, useMutation, useQuery } from "./sporades";

const session = useAuth();
const publicPhotos = useQuery("publicPhotos");
const personalPhotos = useQuery("personalPhotos");
const recordPhoto = useMutation("recordPhoto");
const updatePhotoIsPublic = useMutation("updatePhotoIsPublic");
const updatePhotoImageUrl = useMutation("updatePhotoImageUrl");
const updatePhotoPublicUrlId = useMutation("updatePhotoPublicUrlId");
const title = ref("");
const selectedFile = ref<File | null>(null);
const publish = ref(false);
const message = ref("");
const isGoogleUser = computed(() => session.auth?.provider === "google");

function selectFile(event: Event) { selectedFile.value = (event.currentTarget as HTMLInputElement).files?.[0] ?? null; }
async function signInWithGoogle() { message.value = ""; const result = await auth.signIn("google"); if (result.error) message.value = result.error.message; }
async function signOut() { message.value = ""; const result = await auth.signOut(); if (result.error) message.value = result.error.message; }

async function submit() {
  if (!selectedFile.value) return;
  message.value = "Uploading...";
  try {
    const file = await files.upload(selectedFile.value);
    const shouldPublish = !session.isAuthenticated() || publish.value;
    // Google-authenticated uploads stay private unless the user explicitly opts in.
    const publicUrl = shouldPublish ? await files.publicUrl(file.id, { noExpiry: true }) : null;
    const result = await recordPhoto.run({ title: title.value, file, isPublic: shouldPublish, publicUrl });
    if (result.error) { message.value = result.error.message; return; }
    title.value = ""; selectedFile.value = null; publish.value = false;
    message.value = shouldPublish ? "Photo added to the public gallery." : "Photo saved privately.";
  } catch (error) { message.value = error instanceof Error ? error.message : "Upload failed."; }
}

async function makePublic(photo: any) {
  message.value = "";
  try {
    const publicUrl = await files.publicUrl(photo.fileId, { noExpiry: true });
    await updatePhotoImageUrl.run(photo.id, publicUrl.url);
    await updatePhotoPublicUrlId.run(photo.id, publicUrl.id);
    await updatePhotoIsPublic.run(photo.id, true);
  } catch (error) { message.value = error instanceof Error ? error.message : "Could not publish photo."; }
}

async function makePrivate(photo: any) {
  message.value = "";
  try {
    if (photo.publicUrlId) await files.revokePublicUrl(photo.publicUrlId);
    await updatePhotoIsPublic.run(photo.id, false);
    await updatePhotoImageUrl.run(photo.id, "");
    await updatePhotoPublicUrlId.run(photo.id, "");
  } catch (error) { message.value = error instanceof Error ? error.message : "Could not hide photo."; }
}
</script>

<template>
  <main class="shell">
    <header class="topbar"><div><img class="mark" src="./sporades-mark.svg" alt="" /><p class="eyebrow">Sporades Storage</p><h1>Photo Library</h1></div><div class="auth-panel"><span>{{ session.auth?.displayName ?? "Anonymous" }}</span><button v-if="isGoogleUser" class="secondary-button" @click="signOut">Sign out</button><button v-else @click="signInWithGoogle">Sign in with Google</button></div></header>
    <form class="uploader" @submit.prevent="submit">
      <input v-model="title" placeholder="Caption" /><input type="file" accept="image/*" @change="selectFile" />
      <label :class="session.isAuthenticated() ? 'check' : 'check muted'"><input v-model="publish" type="checkbox" :checked="!session.isAuthenticated() || publish" :disabled="!session.isAuthenticated()" />{{ session.isAuthenticated() ? "Publish to gallery" : "Anonymous uploads are public" }}</label>
      <button :disabled="!selectedFile || recordPhoto.loading">Upload photo</button><p v-if="message" class="message">{{ message }}</p>
    </form>
    <section><h2>Public gallery</h2><p v-if="publicPhotos.error" role="alert">{{ publicPhotos.error.message }}</p><div class="grid"><article v-for="photo in publicPhotos.data ?? []" :key="photo.id" class="photo"><img :src="photo.imageUrl" :alt="photo.title" /><div><strong>{{ photo.title }}</strong><span>{{ photo.ownerName }}</span></div></article></div></section>
    <section v-if="isGoogleUser"><h2>My library</h2><div class="list"><article v-for="photo in personalPhotos.data ?? []" :key="photo.id" class="library-row"><div><strong>{{ photo.title }}</strong><span>{{ photo.status }}</span></div><button v-if="photo.isPublic" class="secondary-button" @click="makePrivate(photo)">Make private</button><button v-else @click="makePublic(photo)">Make public</button></article></div></section>
  </main>
</template>

<style scoped>
:global(body) { margin: 0; background: #f7f7f2; color: #20231f; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.shell { width: min(1080px, calc(100% - 32px)); margin: auto; padding: 40px 0; }.topbar, .auth-panel, .uploader, .check, .library-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.eyebrow { color: #35605a; font-size: .78rem; font-weight: 800; text-transform: uppercase; }h1 { margin: 0; font-size: clamp(2.2rem, 7vw, 5rem); }button { border: 0; border-radius: 8px; min-height: 40px; padding: 0 14px; background: #245f73; color: white; font: inherit; font-weight: 800; }.secondary-button { background: #4d5148; }
.mark { width: 2rem; height: 2rem; }
.uploader, .library-row { border: 1px solid #d8ddd2; background: white; border-radius: 8px; padding: 14px; }.message { flex-basis: 100%; color: #8a3f2d; }.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }.photo { border: 1px solid #d8ddd2; border-radius: 8px; background: white; overflow: hidden; }.photo img { width: 100%; aspect-ratio: 4/3; object-fit: cover; }.photo div { padding: 12px; }.photo strong, .photo span, .library-row strong, .library-row span { display: block; }.list { display: grid; gap: 10px; }.muted { color: #677065; }
@media (max-width: 700px) { .topbar { display: grid; } }
</style>
`;
}
function vueCampfireAppTemplate() {
    return `<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { auth, journey, preferences } from "sporades/client";
import { useAuth, useMutation, useQuery } from "./sporades";
import { createTypingPublisher } from "./journey-typing";

const musketeers = [
  { key: "athos", name: "Athos", email: "athos@campfire.example" },
  { key: "porthos", name: "Porthos", email: "porthos@campfire.example" },
  { key: "aramis", name: "Aramis", email: "aramis@campfire.example" },
  { key: "dartagnan", name: "d'Artagnan", email: "dartagnan@campfire.example" },
];
const fixedChannels = ["general", "ideas", "random", "protect-the-crown"];
const demoPassword = "all-for-one-campfire";
const session = useAuth();
const channel = ref("general");
const draft = ref("");
const notice = ref("");
const sharing = ref(false);
const activities = ref<any[]>([]);
const fixturesPrepared = ref(false);
const profiles = useQuery("profiles");
const channelQueries = {
  general: useQuery("messagesGeneral"), ideas: useQuery("messagesIdeas"), random: useQuery("messagesRandom"),
  "protect-the-crown": useQuery("messagesProtectTheCrown"),
};
const messages = computed(() => channelQueries[channel.value as keyof typeof channelQueries]);
const sendMessage = useMutation("sendMessage");
const toggleReaction = useMutation("toggleReaction");
const seedCampfire = useMutation("seedCampfire");
const registerFixture = useMutation("registerFixture");
const typingPublisher = createTypingPublisher((state) => journey.set(state));
let activityRestoreGeneration = 0;
let fixturePreparationActive = false;
let unsubscribe = () => {};
let activityActionTail = Promise.resolve();
let activityOwnerGeneration: number | null = null;

function restoreIsCurrent(generation: number, userId: string) {
  return generation === activityRestoreGeneration && session.auth?.userId === userId;
}

async function runActivityAction<T>(action: () => Promise<T>) {
  const predecessor = activityActionTail;
  let releaseAction: () => void = () => {};
  activityActionTail = new Promise<void>((resolve) => { releaseAction = resolve; });
  await predecessor;
  try { return await action(); } finally { releaseAction(); }
}

async function retireOwnedActivity(expectedOwner: number | null = null) {
  typingPublisher.dispose();
  sharing.value = false;
  if (activityOwnerGeneration === null || (expectedOwner !== null && activityOwnerGeneration !== expectedOwner)) return;
  activityOwnerGeneration = null;
  const result = await journey.disable();
  if (result?.error) notice.value = result.error.message;
}

function isLocalDemoOrigin(hostname = window.location.hostname) { return ["localhost", "127.0.0.1", "::1"].includes(hostname); }
function applyJourneyEvent(current: any[], event: any) {
  const data = event?.data ?? event;
  if (data?.type === "snapshot") return data.states ?? [];
  if (data?.type === "removed" || data?.type === "expired") return current.filter((item) => item.sessionId !== data.state?.sessionId);
  if (!data?.state) return current;
  return [...current.filter((item) => item.sessionId !== data.state.sessionId), data.state];
}
function activityText(activity: any) {
  const name = (profiles.data ?? []).find((profile: any) => profile.userId === activity.userId)?.name ?? "A Musketeer";
  const place = activity.metadata?.channel ?? "campfire";
  if (activity.status === "posted") return name + " posted a message in #" + place;
  if (activity.status === "liked") return name + " liked a message in #" + place;
  if (activity.status === "disliked") return name + " disliked a message in #" + place;
  return name + " is " + activity.status + " #" + place;
}
function reactionCount(message: any, kind: string) { return Object.keys(message.reactions ?? {}).filter((key) => key.endsWith(":" + kind)).length; }
function reactionMine(message: any, kind: string) { return Object.keys(message.reactions ?? {}).includes(session.auth?.userId + ":" + kind); }

onMounted(() => {
  unsubscribe = journey.subscribe((event) => { activities.value = applyJourneyEvent(activities.value, event); }).unsubscribe;
});
onScopeDispose(() => {
  unsubscribe();
  void runActivityAction(() => retireOwnedActivity());
});

watch(() => profiles.data, async (value) => {
  if (fixturesPrepared.value || !Array.isArray(value)) return;
  fixturesPrepared.value = true;
  if (!isLocalDemoOrigin()) return;
  const existing = new Set(value.map((profile: any) => profile.key));
  await prepareFixtures(musketeers.filter((person) => !existing.has(person.key)));
});

watch(() => session.auth?.userId, async (userId, previousUserId) => {
  const generation = ++activityRestoreGeneration;
  await runActivityAction(async () => {
    if (previousUserId && previousUserId !== userId) await retireOwnedActivity();
    if (!userId || session.auth?.isGuest || fixturePreparationActive) return;
    if (!restoreIsCurrent(generation, userId)) return;
    const stored = await preferences.get();
    if (!restoreIsCurrent(generation, userId) || stored.error || stored.data.preferences.campfireShareActivity !== true) return;
    if (await enableSharing(generation, userId) && restoreIsCurrent(generation, userId)) notice.value = "Activity sharing restored for this Musketeer.";
  });
});

async function prepareFixtures(people = musketeers) {
  fixturePreparationActive = true;
  activityRestoreGeneration += 1;
  await runActivityAction(() => retireOwnedActivity());
  for (const person of people) {
    let result = await auth.signUp("email", { email: person.email, password: demoPassword, name: person.name });
    if (result.error && /already|exists|registered/i.test(result.error.message)) result = await auth.signIn("email", { email: person.email, password: demoPassword });
    if (result.error) { notice.value = "Could not prepare " + person.name + ": " + result.error.message; fixturePreparationActive = false; return; }
    await registerFixture.run(person.key);
    await runActivityAction(() => retireOwnedActivity());
    await auth.signOut();
  }
  fixturePreparationActive = false;
  const seeded = await seedCampfire.run();
  notice.value = seeded.error ? seeded.error.message : "Development-only fixtures ready.";
}

async function switchTo(person: any) {
  activityRestoreGeneration += 1;
  await runActivityAction(() => retireOwnedActivity());
  await auth.signOut();
  const result = await auth.signIn("email", { email: person.email, password: demoPassword });
  notice.value = result.error ? result.error.message : "Signed in as " + person.name + ". Restoring activity preference…";
}

async function enableSharing(expectedGeneration: number, expectedUserId: string, exposeSharing = true) {
  const stale = () => !restoreIsCurrent(expectedGeneration, expectedUserId);
  const result = await journey.enable({ capture: { navigation: false, focus: false, interactions: false } });
  if (result.error) { notice.value = result.error.message; return false; }
  activityOwnerGeneration = expectedGeneration;
  if (stale()) { await retireOwnedActivity(expectedGeneration); return false; }
  const published = await journey.set({ status: "reading", metadata: { channel: channel.value }, ttlSeconds: 12 });
  if (published?.error) { notice.value = published.error.message; await retireOwnedActivity(expectedGeneration); return false; }
  if (stale()) { await retireOwnedActivity(expectedGeneration); return false; }
  if (exposeSharing) sharing.value = true;
  return true;
}
async function setShare(enabled: boolean) {
  const userId = session.auth?.userId;
  const generation = ++activityRestoreGeneration;
  sharing.value = false;
  if (!userId) { notice.value = "Sign in before sharing activity."; return; }
  await runActivityAction(async () => {
    const current = () => restoreIsCurrent(generation, userId);
    if (!current()) return;
    if (enabled) {
      if (!await enableSharing(generation, userId, false) || !current()) { await retireOwnedActivity(generation); return; }
    } else {
      await retireOwnedActivity();
      if (!current()) return;
    }
    if (!current()) { await retireOwnedActivity(generation); return; }
    const saved = await preferences.update({ campfireShareActivity: enabled });
    if (saved?.error) {
      notice.value = saved.error.message;
      if (enabled) await retireOwnedActivity(generation);
      return;
    }
    if (!current()) { if (enabled) await retireOwnedActivity(generation); return; }
    sharing.value = enabled;
  });
}
async function chooseChannel(next: string) {
  typingPublisher.dispose(); channel.value = next;
  if (sharing.value) await journey.set({ status: "reading", metadata: { channel: next }, ttlSeconds: 12 });
}
function compose() { if (sharing.value) typingPublisher.input(draft.value, channel.value); }
async function submit() {
  const result = await sendMessage.run({ channel: channel.value, body: draft.value });
  if (result.error) { notice.value = result.error.message; return; }
  draft.value = "";
  if (sharing.value) { typingPublisher.dispose(); await journey.set({ status: "posted", metadata: { channel: channel.value }, ttlSeconds: 8 }); }
}
async function react(messageId: string, kind: string) {
  const result = await toggleReaction.run({ messageId, kind });
  if (result.error) { notice.value = result.error.message; return; }
  if (sharing.value) await journey.set({ status: kind === "up" ? "liked" : "disliked", metadata: { channel: channel.value }, ttlSeconds: 8 });
}
</script>

<template>
  <main class="campfire">
    <aside class="rail"><img class="mark" src="./sporades-mark.svg" alt="" /><p class="eyebrow">Sporades exemplar</p><h1>🔥 Campfire</h1><nav aria-label="Channels"><button v-for="slug in fixedChannels" :key="slug" :class="{ active: channel === slug }" @click="chooseChannel(slug)"># {{ slug }}</button></nav><p class="warning">Demo fixtures prepare automatically in this development exemplar. Never expose the known credentials publicly.</p></aside>
    <section class="conversation"><header><h2># {{ channel }}</h2><p role="status">{{ notice }}</p></header><div class="messages"><article v-for="message in messages.data ?? []" :key="message.id"><div class="meta"><strong>{{ message.authorName }}</strong><time>{{ new Date(message.createdAt).toLocaleString() }}</time></div><p>{{ message.body }}</p><div class="reactions"><button v-for="kind in ['up', 'down']" :key="kind" :aria-label="(kind === 'up' ? 'Thumbs up' : 'Thumbs down') + ': ' + reactionCount(message, kind)" :aria-pressed="reactionMine(message, kind)" @click="react(message.id, kind)">{{ kind === "up" ? "👍" : "👎" }} {{ reactionCount(message, kind) }}</button></div></article></div><form @submit.prevent="submit"><label for="message">Message</label><div class="compose"><input id="message" v-model="draft" maxlength="500" :placeholder="'Message #' + channel" @input="compose" /><button>Send</button></div></form></section>
    <aside class="activity"><h2>What's happening</h2><label class="switch"><input type="checkbox" :checked="sharing" @change="setShare(($event.currentTarget as HTMLInputElement).checked)" />Share my activity</label><p>Shares reading, typing, posting, likes, dislikes, and channel. Never drafts, messages, URLs, query strings, emails, passwords, message IDs, or keystrokes.</p><ul><li v-for="item in activities" :key="item.sessionId">{{ activityText(item) }}</li></ul><h3>Switch Musketeer</h3><button v-for="person in musketeers" :key="person.key" @click="switchTo(person)">{{ person.name }}</button></aside>
  </main>
</template>

<style scoped>
:global(body) { margin: 0; background: #120d0a; color: #fff7ed; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }.campfire { min-height: 100vh; display: grid; grid-template-columns: 240px minmax(0, 1fr) 300px; }.rail, .activity { padding: 20px; background: #1b120d; }.rail { border-right: 1px solid #78350f66; }.activity { border-left: 1px solid #78350f66; }.eyebrow { color: #f59e0b; font-size: .72rem; font-weight: 800; text-transform: uppercase; letter-spacing: .22em; }nav, .activity { display: grid; align-content: start; gap: 9px; }button, input { border: 1px solid #92400e; border-radius: 7px; padding: 9px 12px; background: #29211d; color: inherit; font: inherit; }nav button, .activity button { text-align: left; }.active { background: #b45309; }.warning, .activity p { color: #fde68aaa; font-size: .78rem; }.conversation { display: flex; min-width: 0; flex-direction: column; }.conversation header, form { padding: 20px; border-bottom: 1px solid #78350f66; }.messages { flex: 1; padding: 20px; display: grid; align-content: start; gap: 14px; }.messages article { padding: 16px; border: 1px solid #78350f66; border-radius: 9px; background: #1c1410; }.meta, .reactions, .compose, .switch { display: flex; align-items: center; gap: 10px; }.meta time { color: #fde68a99; font-size: .75rem; }.compose input { flex: 1; }.conversation form label { position: absolute; clip: rect(0 0 0 0); }.activity ul { padding-left: 18px; }
.mark { width: 2rem; height: 2rem; }
@media (max-width: 900px) { .campfire { grid-template-columns: 1fr; }.rail, .activity { border: 0; }.conversation { min-height: 70vh; } }
</style>
`;
}
function viteTemplateFiles(files, framework) {
    return {
        ...files,
        "client/index.tsx": `import "./styles.css";\nimport("./vite-scaffold").then(({ viteScaffoldLabel }) => console.info(viteScaffoldLabel));\n${files["client/index.tsx"]}`,
        "client/styles.css": `.sporades-vite-asset { background-image: url("./sporades-mark.svg"); }\n`,
        "client/vite-scaffold.ts": `export const viteScaffoldLabel = "Sporades ${framework === "preact" ? "Preact" : "React"}/Vite client loaded";\n`,
        "client/sporades-mark.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#6750a4"/></svg>\n`,
    };
}
function vanillaTemplateFiles(options) {
    return {
        "README.md": `# ${options.name}\n\nA framework-neutral Vanilla TypeScript Sporades capsule.\n`,
        "server/index.ts": `import { capsule, message, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: ${JSON.stringify(options.name)},
  journey: { enabled: true },
  schema: { notes: table({ text: String(), ownerId: String() }) },
  queries: { notes: query((ctx) => ctx.db.notes.where("ownerId", ctx.auth.userId).orderBy("createdAt", "desc").all()) },
  mutations: { addNote: mutation((ctx, text: string) => ctx.db.notes.insert({ text: text.trim(), ownerId: ctx.auth.userId })) },
  messages: { ping: message((ctx, data) => {
    const sentToClients = ctx.messages.send({ type: "pong", data, scope: "currentUser" });
    return { pong: data ?? null, sentToClients };
  }) },
});
`,
        "client/index.ts": vanillaClientTemplate(),
        "shared/types.ts": `export type Note = { id: string; text: string; createdAt: string };\n`,
    };
}
function vanillaClientTemplate() {
    return `import { auth, files, journey, mutations, onMessage, preferences, queries, sendMessage } from "sporades/client";
import type { Note } from "../shared/types";

const app = document.querySelector<HTMLElement>("#app")!;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
const main = element("main");
const authLine = element("p", "Loading auth…");
const form = element("form");
const noteInput = element("input");
noteInput.name = "text";
noteInput.required = true;
form.append(noteInput, element("button", "Add note"));
const list = element("ul");
const theme = element("select");
theme.append(element("option", "system"), element("option", "dark"));
const themeLabel = element("label", "Theme ");
themeLabel.append(theme);
const fileInput = element("input");
fileInput.type = "file";
const pingButton = element("button", "Ping app message");
const journeyButton = element("button", "Share activity");
const status = element("pre");
main.append(element("h1", "Vanilla Sporades"), authLine, form, list, themeLabel, fileInput, pingButton, journeyButton, status);
app.replaceChildren(main);

const notes = queries.subscribe<Note[]>("notes", (state) => {
  if (state.loading) list.replaceChildren(element("li", "Loading…"));
  else if (state.error) list.replaceChildren(element("li", state.error.message));
  else list.replaceChildren(...(state.data ?? []).map((note) => element("li", note.text)));
});
auth.get().then((result) => { if (result.error) status.textContent = result.error.message; });
const authState = auth.subscribe((state) => { authLine.textContent = state.loading ? "Loading auth…" : \`\${state.auth?.displayName ?? "Anonymous"} · \${state.auth?.provider ?? "anonymous"}\`; });
form.addEventListener("submit", async (event) => { event.preventDefault(); const data = new FormData(form); await mutations.run("addNote", globalThis.String(data.get("text") ?? "")); form.reset(); });
preferences.get().then((result) => { if (result.data?.preferences.theme) theme.value = globalThis.String(result.data.preferences.theme); });
theme.addEventListener("change", () => { preferences.update({ theme: theme.value }); });
fileInput.addEventListener("change", async () => { const file = fileInput.files?.[0]; if (file) status.textContent = \`Uploaded \${(await files.upload(file)).name}\`; });
const messages = onMessage((message) => { status.textContent = \`Message: \${message.type}\`; });
pingButton.addEventListener("click", () => sendMessage("ping", { from: "vanilla" }));
const journeyEvents = journey.subscribe((event) => { status.textContent = \`Journey: \${event.type}\`; });
journeyButton.addEventListener("click", async () => { await journey.enable(); await journey.set({ status: "exploring-vanilla" }); });
window.addEventListener("pagehide", () => { notes.unsubscribe(); authState.unsubscribe(); messages.unsubscribe(); journeyEvents.unsubscribe(); journey.disable(); }, { once: true });
`;
}
function resolveTemplateOptions(template) {
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
                serverEnv: "# Server-only environment variables for Sporades.\nGOOGLE_CLIENT_ID=replace-with-google-client-id\nGOOGLE_CLIENT_SECRET=replace-with-google-client-secret\n",
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
function blankTemplateFiles(options) {
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
function todoTemplateFiles(options) {
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
function guestbookTemplateFiles(options) {
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
function photoLibraryTemplateFiles(options) {
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
function campfireTemplateFiles(options) {
    return {
        "README.md": `# ${options.name}

Campfire is the complete Sporades User journey tracker exemplar: realtime chat, durable reactions, and consented ephemeral activity for the four Musketeers.

## Run the campfire

\`\`\`sh
npm install
npm run dev
\`\`\`

Open the URL and Campfire prepares its demo fixtures automatically when none exist. This development-only browser flow uses ordinary public email sign-up and creates Athos (\`athos@campfire.example\`), Porthos (\`porthos@campfire.example\`), Aramis (\`aramis@campfire.example\`), and d'Artagnan (\`dartagnan@campfire.example\`). Repeating preparation is safe. Never expose these known credentials in a public Container session or Hosted Capsule; building, deploying, and hosting do not seed them server-side.

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
        "client/journey-lifecycle.ts": `export async function retireJourneyConsent({ typingPublisher, journey, setSharing }) {
  typingPublisher.dispose();
  await journey.disable();
  setSharing(false);
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
function campfireServerTemplate(name) {
    return `import { capsule, Json, mutation, query, String, table } from "sporades/server";

const channels = ["general", "ideas", "random", "protect-the-crown"];
const fixtureNames = { athos: "Athos", porthos: "Porthos", aramis: "Aramis", dartagnan: "d'Artagnan" };

export default capsule({
  name: ${JSON.stringify(name)},
  journey: { enabled: true, ttlSeconds: 12, capture: { navigation: false, focus: false, interactions: false } },
  schema: {
    channels: table({ slug: String(), name: String() }),
    profiles: table({ userId: String(), key: String(), name: String() }),
    messages: table({ channel: String(), body: String(), authorId: String(), authorName: String(), seedKey: String().default(""), reactions: Json().default({}) }),
  },
  queries: {
    channels: query((ctx) => ctx.db.channels.orderBy("createdAt", "asc").all()),
    messagesGeneral: query((ctx) => ctx.db.messages.where("channel", "general").orderBy("createdAt", "asc").limit(100).all()),
    messagesIdeas: query((ctx) => ctx.db.messages.where("channel", "ideas").orderBy("createdAt", "asc").limit(100).all()),
    messagesRandom: query((ctx) => ctx.db.messages.where("channel", "random").orderBy("createdAt", "asc").limit(100).all()),
    messagesProtectTheCrown: query((ctx) => ctx.db.messages.where("channel", "protect-the-crown").orderBy("createdAt", "asc").limit(100).all()),
    profiles: query((ctx) => ctx.db.profiles.all()),
  },
  mutations: {
    seedCampfire: mutation((ctx) => {
      const created = [], alreadyPresent = [], failed = [];
      const ensure = (type, key, exists, create) => { try { if (exists()) alreadyPresent.push({ type, key }); else { create(); created.push({ type, key }); } } catch (error) { failed.push({ type, key, message: error instanceof Error ? error.message : "Unknown seed failure." }); } };
      for (const slug of channels) ensure("channel", slug, () => ctx.db.channels.where("slug", slug).all().length > 0, () => ctx.db.channels.insert({ slug, name: slug }));
      ensure("message", "general-welcome", () => ctx.db.messages.where("seedKey", "general-welcome").all().length > 0, () => ctx.db.messages.insert({ channel: "general", body: "The Queen requires discretion.", authorId: "fixture:athos", authorName: fixtureNames.athos, seedKey: "general-welcome", reactions: {} }));
      ensure("message", "ideas-welcome", () => ctx.db.messages.where("seedKey", "ideas-welcome").all().length > 0, () => ctx.db.messages.insert({ channel: "ideas", body: "And refreshments.", authorId: "fixture:porthos", authorName: fixtureNames.porthos, seedKey: "ideas-welcome", reactions: {} }));
      ensure("message", "random-welcome", () => ctx.db.messages.where("seedKey", "random-welcome").all().length > 0, () => ctx.db.messages.insert({ channel: "random", body: "Mostly discretion.", authorId: "fixture:aramis", authorName: fixtureNames.aramis, seedKey: "random-welcome", reactions: {} }));
      ensure("message", "crown-prompt", () => ctx.db.messages.where("seedKey", "crown-prompt").all().length > 0, () => ctx.db.messages.insert({ channel: "protect-the-crown", body: "Is the crown adequately protected? 👍 All for one · 👎 One more guard, perhaps", authorId: "fixture:dartagnan", authorName: fixtureNames.dartagnan, seedKey: "crown-prompt", reactions: {} }));
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
      return ctx.db.messages.insert({ channel, body, authorId: ctx.auth.userId, authorName: ctx.auth.displayName, seedKey: "", reactions: {} });
    }),
    toggleReaction: mutation((ctx, input: any) => {
      const kind = input?.kind;
      if (kind !== "up" && kind !== "down") throw new Error("Choose thumbs up or thumbs down.");
      const message = ctx.db.messages.where("id", input?.messageId).all()[0];
      if (!message) throw new Error("Message not found.");
      const identity = ctx.auth.userId + ":" + kind;
      const reactions = { ...(message.reactions ?? {}) };
      if (reactions[identity]) { delete reactions[identity]; ctx.db.messages.update(message.id, { reactions }); return { active: false }; }
      reactions[identity] = true;
      ctx.db.messages.update(message.id, { reactions });
      return { active: true };
    }),
  },
});
`;
}
function campfireClientTemplate(framework) {
    const preact = framework === "preact";
    const imports = preact
        ? `import { render } from "preact";\nimport { useEffect, useState } from "preact/hooks";`
        : `import { useEffect, useState } from "react";\nimport { createRoot } from "react-dom/client";`;
    const mount = preact ? `render(<App />, document.getElementById("app")!);` : `createRoot(document.getElementById("app")!).render(<App />);`;
    const change = preact ? "onInput" : "onChange";
    const klass = preact ? "class" : "className";
    return `${imports}
import { auth, createHooks, journey, preferences } from "sporades/client";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Avatar } from "./components/ui/avatar";
import { Badge } from "./components/ui/badge";
import { Switch } from "./components/ui/switch";
import { Input } from "./components/ui/input";
import { Separator } from "./components/ui/separator";
import { ScrollArea } from "./components/ui/scroll-area";
import { createTypingPublisher } from "./journey-typing";
import { retireJourneyConsent } from "./journey-lifecycle";

const { useAuth, useMutation, useQuery } = createHooks({ useState, useEffect });
const musketeers = [
  { key: "athos", name: "Athos", email: "athos@campfire.example", monogram: "A", tone: "bg-slate-600" },
  { key: "porthos", name: "Porthos", email: "porthos@campfire.example", monogram: "P", tone: "bg-rose-800" },
  { key: "aramis", name: "Aramis", email: "aramis@campfire.example", monogram: "Ar", tone: "bg-indigo-800" },
  { key: "dartagnan", name: "d'Artagnan", email: "dartagnan@campfire.example", monogram: "dA", tone: "bg-amber-800" },
];
const fixedChannels = ["general", "ideas", "random", "protect-the-crown"];
const demoPassword = "all-for-one-campfire";
let fixturePreparationActive = false;
let activityRestoreGeneration = 0;
function isLocalDemoOrigin(hostname = window.location.hostname) { return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"; }

function App() {
  const session = useAuth();
  const [channel, setChannel] = useState("general");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [sharing, setSharing] = useState(false);
  const [fixturesPrepared, setFixturesPrepared] = useState(false);
  const [activities, setActivities] = useState([]);
  const [typingPublisher] = useState(() => createTypingPublisher((state) => journey.set(state)));
  const messageQuery = { general: "messagesGeneral", ideas: "messagesIdeas", random: "messagesRandom", "protect-the-crown": "messagesProtectTheCrown" }[channel];
  const messages = useQuery(messageQuery);
  const profiles = useQuery("profiles");
  const sendMessage = useMutation("sendMessage");
  const toggleReaction = useMutation("toggleReaction");
  const seedCampfire = useMutation("seedCampfire");
  const registerFixture = useMutation("registerFixture");

  useEffect(() => journey.subscribe((event) => {
    setActivities((current) => applyJourneyEvent(current, event));
  }).unsubscribe, []);
  useEffect(() => () => typingPublisher.dispose(), []);
  useEffect(() => {
    if (fixturesPrepared || !Array.isArray(profiles.data)) return;
    setFixturesPrepared(true);
    if (!isLocalDemoOrigin()) return;
    const existing = new Set(profiles.data.map((profile) => profile.key));
    prepareFixtures(musketeers.filter((person) => !existing.has(person.key)));
  }, [profiles.data, fixturesPrepared]);
  useEffect(() => {
    if (!session.auth?.userId || session.auth.isGuest || fixturePreparationActive) return;
    const generation = ++activityRestoreGeneration;
    let cancelled = false;
    (async () => {
      const stored = await preferences.get();
      if (cancelled || generation !== activityRestoreGeneration || stored.error || stored.data.preferences.campfireShareActivity !== true) return;
      const enabled = await enableSharing(generation);
      if (enabled && !cancelled) setNotice("Activity sharing restored for this Musketeer.");
    })();
    return () => { cancelled = true; if (generation === activityRestoreGeneration) activityRestoreGeneration += 1; };
  }, [session.auth?.userId]);

  async function prepareFixtures(people = musketeers) {
    if (people.length === 0) {
      const seeded = await seedCampfire.run();
      setNotice(seeded.error ? seeded.error.message : \`Fixtures ready: \${seeded.data.created.length} repaired, \${seeded.data.alreadyPresent.length} already present.\`);
      return;
    }
    fixturePreparationActive = true;
    activityRestoreGeneration += 1;
    await retireJourneyConsent({ typingPublisher, journey, setSharing });
    setNotice("Preparing development-only fixtures…");
    for (const person of people) {
      let result = await auth.signUp("email", { email: person.email, password: demoPassword, name: person.name });
      if (result.error && /already|exists|registered/i.test(result.error.message)) result = await auth.signIn("email", { email: person.email, password: demoPassword });
      if (result.error) { fixturePreparationActive = false; setNotice(\`Could not prepare \${person.name}: \${result.error.message}\`); return; }
      await registerFixture.run(person.key);
      await retireJourneyConsent({ typingPublisher, journey, setSharing });
      await auth.signOut();
    }
    fixturePreparationActive = false;
    activityRestoreGeneration += 1;
    const seeded = await seedCampfire.run();
    setNotice(seeded.error ? seeded.error.message : seeded.data.failed.length ? \`Fixture preparation failed for \${seeded.data.failed.map((item) => item.key).join(", ")}.\` : \`Fixtures ready: \${seeded.data.created.length} created, \${seeded.data.alreadyPresent.length} already present.\`);
  }

  async function switchTo(person) {
    activityRestoreGeneration += 1;
    await retireJourneyConsent({ typingPublisher, journey, setSharing });
    await auth.signOut();
    const result = await auth.signIn("email", { email: person.email, password: demoPassword });
    setNotice(result.error ? result.error.message : \`Signed in as \${person.name}. Restoring activity preference…\`);
  }

  async function enableSharing(expectedGeneration = null) {
    const result = await journey.enable({ capture: { navigation: false, focus: false, interactions: false } });
    if (result.error) { setNotice(result.error.message); return false; }
    if (expectedGeneration !== null && expectedGeneration !== activityRestoreGeneration) { await journey.disable(); return false; }
    await journey.set({ status: "reading", metadata: { channel }, ttlSeconds: 12 });
    if (expectedGeneration !== null && expectedGeneration !== activityRestoreGeneration) { await journey.disable(); return false; }
    setSharing(true);
    return true;
  }

  async function setShare(enabled) {
    if (enabled) {
      if (!await enableSharing()) return;
    } else { typingPublisher.dispose(); await journey.disable(); setSharing(false); }
    const saved = await preferences.update({ campfireShareActivity: enabled });
    if (saved.error) setNotice(saved.error.message);
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
    if (sharing) { typingPublisher.dispose(); await journey.set({ status: "posted", metadata: { channel }, ttlSeconds: 8 }); }
  }

  async function react(messageId, kind) {
    const result = await toggleReaction.run({ messageId, kind });
    if (result.error) { setNotice(result.error.message); return; }
    if (sharing) await journey.set({ status: kind === "up" ? "liked" : "disliked", metadata: { channel }, ttlSeconds: 8 });
  }

  return <main ${klass}="min-h-screen bg-[#120d0a] text-amber-50 lg:grid lg:grid-cols-[240px_1fr_300px]">
    <aside ${klass}="border-r border-amber-900/40 bg-[#1b120d] p-5">
      <p ${klass}="text-xs font-bold uppercase tracking-[.28em] text-amber-500">Sporades exemplar</p><h1 ${klass}="mb-8 mt-2 text-3xl font-black">🔥 Campfire</h1>
      <nav aria-label="Channels" ${klass}="space-y-2">{fixedChannels.map((slug) => <button key={slug} type="button" ${klass}={\`block w-full rounded-md px-3 py-2 text-left \${channel === slug ? "bg-amber-700 text-white" : "hover:bg-amber-950"}\`} onClick={() => chooseChannel(slug)}><Badge># {slug}</Badge></button>)}</nav>
      <Separator ${klass}="my-8"/><p ${klass}="text-xs text-amber-200/70">Demo fixtures prepare automatically in this development exemplar. Never expose the known credentials publicly.</p>
    </aside>
    <section ${klass}="flex min-h-screen flex-col"><header ${klass}="border-b border-amber-900/40 p-5"><h2 ${klass}="text-xl font-bold"># {channel}</h2><p role="status" ${klass}="text-sm text-amber-300">{notice}</p></header>
      <ScrollArea ${klass}="flex-1 space-y-4 p-5">{(messages.data ?? []).map((message) => <Message key={message.id} message={message} session={session} react={react} />)}</ScrollArea>
      <form ${klass}="border-t border-amber-900/40 p-5" onSubmit={submit}><label ${klass}="sr-only" htmlFor="message">Message</label><div ${klass}="flex gap-2"><Input id="message" maxLength={500} ${klass}="min-w-0 flex-1" value={draft} placeholder={\`Message #\${channel}\`} ${change}={(event) => compose(event.currentTarget.value)} /><Button ${klass}="bg-amber-700" type="submit">Send</Button></div></form>
    </section>
    <aside ${klass}="border-l border-amber-900/40 bg-[#1b120d] p-5"><h2 ${klass}="text-lg font-bold">What's happening</h2><div ${klass}="mt-4"><Switch label="Share my activity" checked={sharing} onChange={(event) => setShare(event.currentTarget.checked)} /></div><p ${klass}="mt-2 text-xs text-amber-200/70">Shares reading, typing, posting, likes, dislikes, and channel. Never drafts, messages, URLs, query strings, emails, passwords, message IDs, or keystrokes.</p>
      <ul ${klass}="mt-5 space-y-3">{activities.map((activity) => <li key={activity.sessionId} ${klass}="rounded-md bg-amber-950/60 p-3">{activityText(activity, profiles.data ?? [])}</li>)}</ul>
      <h3 ${klass}="mt-8 font-bold">Switch Musketeer</h3><div ${klass}="mt-3 grid gap-2">{musketeers.map((person) => <Button key={person.key} type="button" ${klass}=\"flex items-center gap-2 bg-stone-800 text-left\" onClick={() => switchTo(person)}><span ${klass}={\`grid h-7 w-7 place-items-center rounded-full \${person.tone}\`}>{person.monogram}</span>{person.name}</Button>)}</div>
    </aside>
  </main>;
}

function Message({ message, session, react }) {
  const reactionKeys = Object.keys(message.reactions ?? {});
  return <Card ${klass}="p-4"><div ${klass}="flex items-baseline gap-3"><Avatar label={message.authorName}/><strong>{message.authorName}</strong><time ${klass}="text-xs text-amber-300/60">{new Date(message.createdAt).toLocaleString()}</time></div><p ${klass}="my-3 whitespace-pre-wrap">{message.body}</p><div ${klass}="flex gap-2">{[["up", "👍"], ["down", "👎"]].map(([kind, emoji]) => { const mine = reactionKeys.includes(\`\${session.auth?.userId}:\${kind}\`); const total = reactionKeys.filter((key) => key.endsWith(\`:\${kind}\`)).length; return <button key={kind} type="button" aria-label={\`\${kind === "up" ? "Thumbs up" : "Thumbs down"}: \${total}; \${mine ? "active" : "inactive"}\`} aria-pressed={mine} ${klass}="rounded-full border border-amber-800 px-3 py-1" onClick={() => react(message.id, kind)}>{emoji} {total}</button>; })}</div></Card>;
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
function activityText(activity, profiles) {
  const name = personName(activity.userId, profiles), channel = activity.metadata?.channel ?? "campfire";
  if (activity.status === "posted") return \`\${name} posted a message in #\${channel}\`;
  if (activity.status === "liked") return \`\${name} liked a message in #\${channel}\`;
  if (activity.status === "disliked") return \`\${name} disliked a message in #\${channel}\`;
  return \`\${name} is \${activity.status} #\${channel}\`;
}
${mount}
`;
}
function blankClientTemplate(framework) {
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
function todoClientTemplate(framework) {
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
function guestbookClientTemplate(framework) {
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
function photoLibraryClientTemplate(framework) {
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
function agentsTemplate(template, framework, toolchain) {
    const vanilla = framework === "vanilla";
    const solid = framework === "solid";
    const vue = framework === "vue";
    const svelte = framework === "svelte";
    const clientFiles = vue ? "client/*.vue and client/*.ts" : svelte ? "client/*.svelte and client/*.ts" : `client/*.${vanilla ? "ts" : "tsx"}`;
    return `# Sporades App Instructions

This directory is for a Sporades app. Sporades is a CLI-first tool for building and running full-stack web apps.

Template: ${template}
Client framework: ${framework}
Client toolchain: ${toolchain}

## Rules

- Server code goes in \`server/\`, client code in \`client/\`, shared code in \`shared/\`.
- Use \`sporades/server\` only from \`server/*.ts\`.
- Use \`sporades/client\` only from \`${clientFiles}\`.
- Data is accessed through queries. Changes go through mutations.
- Use endpoints only for HTTP integrations that cannot use queries, mutations, or app messages.
- No file-based routing. Use the router included in the scaffold template.
- All imports must be from Sporades, the configured framework, or relative paths.
- Do not use Node built-ins in client code.
- Auth is available via \`ctx.auth\` on the server, ${vanilla ? "`auth.get()` and `auth.subscribe()` in the framework-neutral client" : solid ? "`createAuth()` in the SolidJS client" : "`useAuth()` on the client"}.
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
- \`client/index.${vanilla || vue || svelte ? "ts" : "tsx"}\` - ${vanilla ? "framework-neutral DOM UI entrypoint" : solid ? "SolidJS render entrypoint" : vue ? "Vue mount entrypoint" : svelte ? "Svelte mount entrypoint" : "UI entrypoint"}
${solid ? "- `client/App.tsx` - native SolidJS component UI\n" : ""}${vue ? "- `client/App.vue` - Vue Single-File Component UI\n" : ""}- \`shared/\` - pure TypeScript shared by client and server
${svelte ? "- `client/App.svelte` - Svelte component UI\n" : ""}
- \`index.html\` - HTML shell (user-owned)
- \`sporades.json\` - project configuration
`;
}
function escapeHtml(value) {
    const replacements = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    };
    return value.replace(/[&<>"']/g, (char) => replacements[char] ?? char);
}
//# sourceMappingURL=scaffold-template.js.map