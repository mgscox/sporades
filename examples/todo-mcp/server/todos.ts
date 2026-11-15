import type { CapsuleContext } from "sporades/server";

export class TodoInputError extends Error {
  constructor(readonly code: "INVALID_TEXT" | "REQUEST_ID_CONFLICT" | "RESULT_TOO_LARGE") { super(code); }
}

export function normalizeText(value: unknown): string {
  if (typeof value !== "string") throw new TodoInputError("INVALID_TEXT");
  const text = value.trim();
  const length = [...text].length;
  if (length < 1 || length > 500) throw new TodoInputError("INVALID_TEXT");
  return text;
}

export function todoResult(row: any) {
  return { id: row.id as string, text: row.text as string, done: row.done as boolean };
}

// Browser and MCP inserts share normalization, ownership and the caller's transaction.
export async function addTodo(ctx: Pick<CapsuleContext, "db" | "auth">, value: unknown) {
  return todoResult(await ctx.db.todos.insert({ text: normalizeText(value), ownerId: ctx.auth.userId }));
}

const latestFirst = (a: any, b: any) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

export async function listTodos(ctx: Pick<CapsuleContext, "db" | "auth">) {
  return (await ctx.db.todos.where("ownerId", ctx.auth.userId).all()).sort(latestFirst);
}

export async function listMyTodos(ctx: Pick<CapsuleContext, "db" | "auth">) {
  const rows = await ctx.db.todos.where("ownerId", ctx.auth.userId).orderBy("createdAt", "desc").limit(51).all();
  let latest = rows;
  if (rows.length > 50) {
    // The table API has one order key. Resolve boundary ties with a second bounded query.
    const boundary = rows[49].createdAt;
    const tied = await ctx.db.todos.where("ownerId", ctx.auth.userId).where("createdAt", boundary).orderBy("id", "desc").limit(51).all();
    latest = [...rows.filter(row => row.createdAt > boundary), ...tied];
  }
  const result = { todos: latest.sort(latestFirst).slice(0, 50).map(todoResult), hasMore: rows.length > 50 };
  // Historical scaffold rows were unbounded. Refuse an oversized result without rewriting them.
  if (Buffer.byteLength(JSON.stringify(result)) > 120_000) throw new TodoInputError("RESULT_TOO_LARGE");
  return result;
}

export async function addTodoOnce(ctx: Pick<CapsuleContext, "db" | "auth">, input: { text: string; requestId: string }) {
  const text = normalizeText(input.text);
  const requestId = input.requestId.toLowerCase();
  const receipt = await ctx.db.todoAddReceipts.insertOrIgnore({
    ownerId: ctx.auth.userId, requestId, text, result: null,
  }, "ownerId", "requestId");
  if (!receipt) {
    const existing = await ctx.db.todoAddReceipts.where("ownerId", ctx.auth.userId).where("requestId", requestId).get();
    if (!existing || existing.result === null) throw new Error("Incomplete Todo receipt");
    if (existing.text !== text) throw new TodoInputError("REQUEST_ID_CONFLICT");
    return existing.result;
  }
  const result = await addTodo(ctx, text);
  await ctx.db.todoAddReceipts.update(receipt.id, { result });
  return result;
}
