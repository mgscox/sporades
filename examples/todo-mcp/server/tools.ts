import { addTodoOnce, listMyTodos } from "./todos.js";
import type { EndpointContext } from "sporades/server";

export const scopes = ["todos:read", "todos:add"] as const;
const todoSchema = {
  type: "object", additionalProperties: false, required: ["id", "text", "done"],
  properties: { id: { type: "string" }, text: { type: "string" }, done: { type: "boolean" } },
};

// This registry belongs to this Capsule. Edit it and redeploy without changing Sporades.
export const tools = [
  {
    name: "list_my_todos", description: "List up to 50 of my latest todos.", requiredScopes: ["todos:read"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object", additionalProperties: false, required: ["todos", "hasMore"],
      properties: { todos: { type: "array", maxItems: 50, items: todoSchema }, hasMore: { type: "boolean" } },
    },
    handler: (ctx: EndpointContext, _input: any) => listMyTodos(ctx),
  },
  {
    name: "add_todo", description: "Add a todo. Retry with the same UUID and text to recover a lost response.", requiredScopes: ["todos:add"],
    inputSchema: {
      type: "object", additionalProperties: false, required: ["text", "requestId"],
      properties: {
        text: { type: "string", minLength: 1, description: "Trimmed on the server; 1–500 Unicode code points after trimming." },
        requestId: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" },
      },
    },
    outputSchema: todoSchema,
    handler: (ctx: EndpointContext, input: any) => addTodoOnce(ctx, input),
  },
];
