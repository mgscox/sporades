import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { accessKeys, auth, createHooks } from "sporades/client";
import type { AccessKeySummary } from "sporades/client";
import type { Todo } from "../shared/types.js";
import "./style.css";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });

function Keys() {
  const [keys, setKeys] = useState<AccessKeySummary[]>([]);
  const [name, setName] = useState("Todo reader");
  const [read, setRead] = useState(true);
  const [add, setAdd] = useState(false);
  const [secret, setSecret] = useState("");
  const [notice, setNotice] = useState("");
  const agents = useQuery<{ id: string; serviceUserId: string; displayName: string }[]>("myAgents");
  const createAgent = useMutation("createAgent");
  const disableAgent = useMutation("disableAgent");
  async function perform(action: () => Promise<any>) {
    setSecret("");
    try {
      const result = await action();
      if (result?.error) throw new Error(result.error.message);
      const value = result?.data ?? result;
      if (value?.token) setSecret(value.token);
      const listed = await accessKeys.list();
      if (listed.error) throw new Error(listed.error.message);
      setKeys(listed.data?.accessKeys ?? []);
      setNotice("Saved");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Operation failed"); }
  }
  useEffect(() => { void perform(async () => null); }, []);
  return <section aria-labelledby="keys-title"><h2 id="keys-title">Agent access</h2>
    <p>Start with read permission. Add permission allows an agent to capture todos for your list.</p>
    <form onSubmit={event => { event.preventDefault(); void perform(() => accessKeys.issue({ name, grants: [...(read ? ["todos:read"] : []), ...(add ? ["todos:add"] : [])] })); }}>
      <label>Key name <input value={name} onChange={event => setName(event.target.value)} /></label>
      <label><input type="checkbox" checked={read} onChange={event => setRead(event.target.checked)} /> Read todos</label>
      <label><input type="checkbox" checked={add} onChange={event => setAdd(event.target.checked)} /> Add todos</label>
      <button disabled={!name.trim() || (!read && !add)}>Issue key</button>
    </form>
    {secret && <div role="status"><p>Copy this bearer now. It is shown once and is cleared when this panel closes.</p><textarea aria-label="New bearer credential" readOnly value={secret} /><button onClick={() => setSecret("")}>Hide credential</button></div>}
    <p role="status">{notice}</p>
    <ul>{keys.map(key => <li key={key.id}>{key.name} ({key.status}) <button disabled={key.status !== "active"} onClick={() => void perform(() => accessKeys.rotate(key.id, { lifecycleRevision: key.lifecycleRevision }))}>Rotate {key.name}</button> <button disabled={key.status === "revoked"} onClick={() => void perform(() => accessKeys.revoke(key.id))}>Revoke {key.name}</button></li>)}</ul>
    <h3>Separate automation list</h3><p>A Service User starts with its own empty list. It uses the name and permissions selected above.</p>
    <button disabled={!name.trim() || (!read && !add)} onClick={() => void perform(() => createAgent.run({ displayName: name, accessKey: { name, grants: [...(read ? ["todos:read"] : []), ...(add ? ["todos:add"] : [])] } }))}>Create Todo agent</button>
    <ul>{(agents.data ?? []).map(agent => <li key={agent.id}>{agent.displayName} <button onClick={() => void perform(() => disableAgent.run(agent.serviceUserId))}>Disable {agent.displayName}</button></li>)}</ul>
  </section>;
}

function App() {
  const session = useAuth();
  const todos = useQuery<Todo[]>("todos");
  const addTodo = useMutation("addTodo");
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  async function signIn(create: boolean) {
    const result = await (create ? auth.signUp("email", { email, password }) : auth.signIn("email", { email, password }));
    setPassword("");
    setNotice(result.error?.message ?? "Signed in");
  }
  return <main><h1>Sporades Todos</h1><p>Todos belong to your current identity. Link your guest list before issuing an agent key.</p>
    {session.isAuthenticated() ? <p>Signed in as {session.auth?.displayName} <button onClick={() => void auth.signOut()}>Sign out</button></p> : <section><h2>Link or sign in</h2>
      <form onSubmit={event => { event.preventDefault(); void signIn(false); }}>
        <label>Email <input type="email" value={email} onChange={event => setEmail(event.target.value)} required /></label>
        <label>Password <input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
        <button>Sign in</button><button type="button" onClick={() => void signIn(true)}>Link this list</button>
      </form></section>}
    <p role="status">{notice}</p>
    <form onSubmit={async event => { event.preventDefault(); const result = await addTodo.run(text); if (result.error) setNotice(result.error.message); else setText(""); }}>
      <label>Todo <input value={text} onChange={event => setText(event.target.value)} /></label><button disabled={!text.trim() || addTodo.loading}>Add todo</button>
    </form>
    <p role="status">{todos.error?.message}</p><ul aria-label="Todos">{(todos.data ?? []).map(todo => <li key={todo.id}>{todo.text}</li>)}</ul>
    {session.isAuthenticated() && <Keys key={session.auth?.userId} />}
  </main>;
}
createRoot(document.getElementById("app")!).render(<App />);
