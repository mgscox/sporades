import { Boolean, capsule, endpoint, Json, mutation, query, requireAuth, String, table } from "sporades/server";
import type { CapsuleContext, CreateServiceUserInput, TableAclRules } from "sporades/server";
import { mcp, methodNotAllowed } from "./mcp.js";
import { scopes } from "./tools.js";
import { addTodo, listTodos } from "./todos.js";

const ownerAcl: TableAclRules = {
  read: ({ row, ctx }) => row?.ownerId === ctx.auth.userId,
  write: ({ previous, next, ctx }) => (!previous || previous.ownerId === ctx.auth.userId) && (!next || next.ownerId === ctx.auth.userId),
};
const session = { linked: true, credentials: ["session"] as const };

export default capsule({
  name: "todo-mcp-pilot",
  implicitMutations: false,
  accessKeys: { scopes },
  schema: {
    // Same fields as the Todo scaffold: existing rows and guest browser workflows remain usable.
    todos: table({ text: String(), done: Boolean().default(false), ownerId: String() }).acl(ownerAcl),
    todoAddReceipts: table({ ownerId: String(), requestId: String(), text: String(), result: Json() }).unique("ownerId", "requestId").acl(ownerAcl),
    managedAgents: table({ ownerId: String(), serviceUserId: String(), displayName: String() }).acl(ownerAcl),
  },
  queries: {
    todos: query(listTodos),
    myAgents: query(requireAuth(session, ctx => ctx.db.managedAgents.where("ownerId", ctx.auth.userId).all())),
  },
  mutations: {
    addTodo: mutation(addTodo),
    createAgent: mutation(requireAuth(session, (ctx: CapsuleContext, input: CreateServiceUserInput) => {
      // Management policy: the creating human may later disable only this Service User.
      const operation = ctx.serviceUsers.reserveCreate(input);
      return ctx.lifecycle.continue(operation, async created => {
        await ctx.db.managedAgents.insert({ ownerId: ctx.auth.userId, serviceUserId: created.serviceUser.id, displayName: created.serviceUser.displayName });
        return created;
      });
    })),
    disableAgent: mutation(requireAuth(session, async (ctx: CapsuleContext, userId: string) => {
      const operation = ctx.serviceUsers.reserveDisable(userId);
      const managed = await ctx.db.managedAgents.where("ownerId", ctx.auth.userId).where("serviceUserId", userId).get();
      if (!managed) throw new Error("Unavailable agent");
      return ctx.lifecycle.continue(operation, async disabled => {
        await ctx.db.managedAgents.delete(managed.id);
        return disabled;
      });
    })),
  },
  endpoints: {
    // No `mcp` option: this endpoint is never exposed by the operator bridge.
    appMcp: endpoint({ method: "POST", path: "/mcp" }, requireAuth({ credentials: ["access-key"] }, mcp)),
    mcpGet: endpoint({ method: "GET", path: "/mcp", session: "none" }, methodNotAllowed),
    mcpDelete: endpoint({ method: "DELETE", path: "/mcp", session: "none" }, methodNotAllowed),
  },
});
