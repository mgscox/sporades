import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  completePendingFileUpload,
  createPublicFileUrl,
  createPendingFileUpload,
  deletePrivateFile,
  getPrivateFileUrl,
} from "../dist/file-storage-runtime.js";
import { handleFileHttpRoute, prepareHttpSecurity } from "../dist/http-runtime.js";
import { openDevDatabase, routeEndpoint, runAppMessage, runEndpoint, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { capsule, endpoint, message, mutation, query } from "../dist/server.js";

function guestAuth(userId) {
  return {
    userId,
    displayName: userId,
    email: null,
    picture: null,
    isAuthenticated: false,
    isGuest: true,
    provider: "anonymous",
  };
}

async function uploadFile(database, auth, filePath, contents) {
  const pending = await createPendingFileUpload(database, auth, {
    file: {
      name: path.basename(filePath),
      path: filePath,
      type: "text/plain",
      size: Buffer.byteLength(contents),
    },
  });
  assert.equal(pending.ok, true, pending.error?.message);
  const completed = await completePendingFileUpload(
    database,
    pending.data.uploadUrl.split("/").pop(),
    Readable.from([Buffer.from(contents)]),
  );
  assert.equal(completed.ok, true, completed.error?.message);
  return completed.data.file;
}

async function seedSession(database, auth, token) {
  await database.adapter.insertAuthUser({
    id: auth.userId,
    createdAt: "2026-09-13T00:00:00.000Z",
    displayName: auth.displayName,
    email: `${auth.userId}@example.com`,
    picture: null,
    isAuthenticated: 1,
    isGuest: 0,
    provider: "email",
  });
  await database.adapter.insertAuthSession({
    token,
    userId: auth.userId,
    provider: "email",
    createdAt: "2026-09-13T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

async function startEndpointServer(database) {
  const server = createServer(async (request, response) => {
    if (prepareHttpSecurity(database, request, response)) return;
    if (await routeEndpoint(database, request, response)) return;
    if (await handleFileHttpRoute(database, request, response)) return;
    response.writeHead(404).end("Not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("Capsule server code can delete a File as the current user", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-server-files-"));
  const definition = capsule({
    name: "server-files-current-user",
    mutations: {
      deleteFile: mutation((ctx, fileReference) => ctx.files.delete(fileReference)),
    },
  });
  const database = await openDevDatabase(
    path.join(directory, "data.db"),
    "",
    {},
    { name: definition.name, files: { storagePath: path.join(directory, "files") } },
    definition,
  );
  const owner = guestAuth("file-owner");

  try {
    const file = await uploadFile(database, owner, "/documents/report.txt", "report");

    const deleted = await runMutation(database, owner, "deleteFile", [file.id]);

    assert.equal(deleted.error, null);
    assert.equal(deleted.data.id, file.id);
    assert.equal((await getPrivateFileUrl(database, owner, file.id)).ok, false);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Capsule server File deletion denies a different user opaquely", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-server-files-"));
  const definition = capsule({
    name: "server-files-denied-user",
    mutations: {
      deleteFile: mutation((ctx, fileReference) => ctx.files.delete(fileReference)),
    },
  });
  const database = await openDevDatabase(
    path.join(directory, "data.db"),
    "",
    {},
    { name: definition.name, files: { storagePath: path.join(directory, "files") } },
    definition,
  );
  const owner = guestAuth("file-owner");
  const other = guestAuth("other-user");

  try {
    const file = await uploadFile(database, owner, "/documents/private.txt", "private");

    const denied = await runMutation(database, other, "deleteFile", [file.id]);

    assert.deepEqual(denied.error, {
      message: "File not found.",
      hint: "Pass the id or absolute File path of a private file owned by the current user.",
    });
    assert.equal((await getPrivateFileUrl(database, owner, file.id)).ok, true);

  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("user-scoped File deletion keeps ambiguous paths opaque", async () => {
  const transactionAdapter = {
    selectLiveFileByPath: async () => [{ id: "one" }, { id: "two" }],
  };
  const database = {
    adapter: {
      withTransaction: async (callback) => await callback(transactionAdapter),
    },
  };

  const result = await deletePrivateFile(database, guestAuth("file-owner"), "/shared/collision.txt");

  assert.deepEqual(result.error, {
    message: "File not found.",
    hint: "Pass the id or absolute File path of a private file owned by the current user.",
  });
});

test("Capsule File ACL can authorize server deletion for the current user", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-server-files-"));
  const definition = capsule({
    name: "server-files-acl-user",
    files: {
      acl: {
        delete: ({ ctx, file }) => ctx.auth.userId === "collaborator" && file.path === "/shared/review.txt",
      },
    },
    mutations: {
      deleteFile: mutation((ctx, fileReference) => ctx.files.delete(fileReference)),
    },
  });
  const database = await openDevDatabase(
    path.join(directory, "data.db"),
    "",
    {},
    { name: definition.name, files: { storagePath: path.join(directory, "files") } },
    definition,
  );
  const owner = guestAuth("file-owner");
  const collaborator = guestAuth("collaborator");

  try {
    const file = await uploadFile(database, owner, "/shared/review.txt", "review");

    const deleted = await runMutation(database, collaborator, "deleteFile", [file.id]);

    assert.equal(deleted.error, null);
    assert.equal(deleted.data.id, file.id);
    assert.equal((await getPrivateFileUrl(database, owner, file.id)).ok, false);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("endpoint File APIs retain ingress and attachment methods alongside user deletion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-server-files-"));
  const holder = { fileId: null };
  const definition = capsule({
    name: "server-files-endpoint",
    endpoints: {
      deleteFile: endpoint(
        { method: "POST", path: "/files/delete", response: { fileAttachment: true } },
        async (ctx) => ({
          body: {
            methods: ["claim", "inspection", "status", "attachment", "delete"]
              .filter((name) => typeof ctx.files[name] === "function"),
            file: await ctx.files.delete(holder.fileId),
          },
        }),
      ),
    },
  });
  const database = await openDevDatabase(
    path.join(directory, "data.db"),
    "",
    {},
    { name: definition.name, files: { storagePath: path.join(directory, "files") } },
    definition,
  );
  const owner = {
    ...guestAuth("endpoint-owner"),
    email: "endpoint-owner@example.com",
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const token = "endpoint-owner-session";
  let server;

  try {
    await seedSession(database, owner, token);
    const file = await uploadFile(database, owner, "/endpoint/source.txt", "endpoint");
    holder.fileId = file.id;
    server = await startEndpointServer(database);

    const response = await fetch(`${server.baseUrl}/files/delete`, {
      method: "POST",
      headers: { "x-sporades-session-token": token },
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.methods, ["claim", "inspection", "status", "attachment", "delete"]);
    assert.equal(body.file.id, file.id);
    assert.equal((await getPrivateFileUrl(database, owner, file.id)).ok, false);
  } finally {
    await server?.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed mutation rolls back File deletion without removing its bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-server-files-"));
  const definition = capsule({
    name: "server-files-rollback",
    mutations: {
      deleteThenFail: mutation(async (ctx, fileReference) => {
        await ctx.files.delete(fileReference);
        throw new Error("rollback deletion");
      }),
    },
  });
  const database = await openDevDatabase(
    path.join(directory, "data.db"),
    "",
    {},
    { name: definition.name, files: { storagePath: path.join(directory, "files") } },
    definition,
  );
  const owner = {
    ...guestAuth("rollback-owner"),
    email: "rollback-owner@example.com",
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const token = "rollback-owner-session";
  let server;

  try {
    await seedSession(database, owner, token);
    const file = await uploadFile(database, owner, "/rollback/source.txt", "still present");
    const publicUrl = await createPublicFileUrl(database, owner, file.id, { noExpiry: true });
    assert.equal(publicUrl.ok, true, publicUrl.error?.message);
    server = await startEndpointServer(database);

    const failed = await runMutation(database, owner, "deleteThenFail", [file.id], { sessionToken: token });

    assert.equal(failed.error.message, "rollback deletion");
    const response = await fetch(
      `${server.baseUrl}/__sporades/files/private/${file.id}?v=${encodeURIComponent(file.version)}`,
      { headers: { "x-sporades-session-token": token } },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "still present");
    const publicResponse = await fetch(`${server.baseUrl}${publicUrl.data.publicUrl.url}`);
    assert.equal(publicResponse.status, 200);
    assert.equal(await publicResponse.text(), "still present");
  } finally {
    await server?.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed App messages and endpoints roll back File deletion without removing bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-server-files-"));
  const references = { message: null, endpoint: null };
  const definition = capsule({
    name: "server-files-handler-rollback",
    messages: {
      deleteThenFail: message(async (ctx) => {
        await ctx.files.delete(references.message);
        throw new Error("message rollback");
      }),
    },
    endpoints: {
      deleteThenFail: endpoint({ method: "POST", path: "/files/delete-then-fail" }, async (ctx) => {
        await ctx.files.delete(references.endpoint);
        throw new Error("endpoint rollback");
      }),
    },
  });
  const database = await openDevDatabase(
    path.join(directory, "data.db"),
    "",
    {},
    { name: definition.name, files: { storagePath: path.join(directory, "files") } },
    definition,
  );
  const owner = {
    ...guestAuth("handler-rollback-owner"),
    email: "handler-rollback-owner@example.com",
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const token = "handler-rollback-owner-session";
  let server;

  try {
    await seedSession(database, owner, token);
    const messageFile = await uploadFile(database, owner, "/rollback/message.txt", "message bytes");
    const endpointFile = await uploadFile(database, owner, "/rollback/endpoint.txt", "endpoint bytes");
    references.message = messageFile.id;
    references.endpoint = endpointFile.id;

    const messageResult = await runAppMessage(database, owner, "deleteThenFail", null, { sessionToken: token });
    assert.match(messageResult.error.message, /message rollback/);
    await assert.rejects(
      runEndpoint(
        database,
        database.endpoints[0],
        new URL("http://capsule.test/files/delete-then-fail"),
        Object.assign(Readable.from([]), { method: "POST", headers: { "x-sporades-session-token": token } }),
      ),
      /endpoint rollback/,
    );

    server = await startEndpointServer(database);
    for (const [file, contents] of [[messageFile, "message bytes"], [endpointFile, "endpoint bytes"]]) {
      const response = await fetch(
        `${server.baseUrl}/__sporades/files/private/${file.id}?v=${encodeURIComponent(file.version)}`,
        { headers: { "x-sporades-session-token": token } },
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), contents);
    }
  } finally {
    await server?.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retained user File deletion authority is revoked after success and rollback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-server-files-"));
  let retainedFiles;
  const definition = capsule({
    name: "server-files-revocation",
    mutations: {
      retain: mutation((ctx) => { retainedFiles = ctx.files; return null; }),
      retainThenFail: mutation((ctx) => { retainedFiles = ctx.files; throw new Error("rollback retained files"); }),
    },
  });
  const database = await openDevDatabase(
    path.join(directory, "data.db"),
    "",
    {},
    { name: definition.name, files: { storagePath: path.join(directory, "files") } },
    definition,
  );
  const owner = guestAuth("retained-file-owner");

  try {
    const file = await uploadFile(database, owner, "/retained/source.txt", "retained");
    assert.equal((await runMutation(database, owner, "retain", [])).error, null);
    await assert.rejects(retainedFiles.delete(file.id), (error) => error?.message === "File access is no longer active.");
    assert.equal((await getPrivateFileUrl(database, owner, file.id)).ok, true);

    assert.match((await runMutation(database, owner, "retainThenFail", [])).error.message, /rollback retained files/);
    await assert.rejects(retainedFiles.delete(file.id), (error) => error?.message === "File access is no longer active.");
    assert.equal((await getPrivateFileUrl(database, owner, file.id)).ok, true);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("App message cleanup drains an unawaited user File deletion before commit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-server-files-"));
  let releaseAcl;
  let signalAclEntered;
  let retainedFilesDuringDrain;
  globalThis.__serverFileDeleteAclGate = new Promise((resolve) => { releaseAcl = resolve; });
  globalThis.__serverFileDeleteAclEntered = new Promise((resolve) => { signalAclEntered = resolve; });
  const definition = capsule({
    name: "server-files-unawaited",
    files: {
      acl: {
        delete: async () => {
          globalThis.__serverFileDeleteAclEnteredResolve();
          await globalThis.__serverFileDeleteAclGate;
          return true;
        },
      },
    },
    messages: {
      deleteWithoutAwait: message((ctx, fileReference) => {
        retainedFilesDuringDrain = ctx.files;
        void ctx.files.delete(fileReference);
        return null;
      }),
    },
  });
  globalThis.__serverFileDeleteAclEnteredResolve = signalAclEntered;
  const database = await openDevDatabase(
    path.join(directory, "data.db"),
    "",
    {},
    { name: definition.name, files: { storagePath: path.join(directory, "files") } },
    definition,
  );
  const owner = guestAuth("unawaited-owner");
  const collaborator = guestAuth("unawaited-collaborator");

  try {
    const file = await uploadFile(database, owner, "/unawaited/source.txt", "unawaited");
    const protectedFile = await uploadFile(database, collaborator, "/unawaited/protected.txt", "protected");
    let settled = false;
    const pending = runAppMessage(database, collaborator, "deleteWithoutAwait", file.id).finally(() => { settled = true; });
    await globalThis.__serverFileDeleteAclEntered;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the handler transaction must drain the unawaited deletion");
    await assert.rejects(
      retainedFilesDuringDrain.delete(protectedFile.id),
      (error) => error?.message === "File access is no longer active.",
    );
    releaseAcl();
    assert.equal((await pending).error, null);
    assert.equal((await getPrivateFileUrl(database, owner, file.id)).ok, false);
    assert.equal((await getPrivateFileUrl(database, collaborator, protectedFile.id)).ok, true);
  } finally {
    delete globalThis.__serverFileDeleteAclGate;
    delete globalThis.__serverFileDeleteAclEntered;
    delete globalThis.__serverFileDeleteAclEnteredResolve;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("query cleanup drains an unawaited user File deletion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-server-files-"));
  let releaseAcl;
  let signalAclEntered;
  globalThis.__serverFileQueryDeleteAclGate = new Promise((resolve) => { releaseAcl = resolve; });
  globalThis.__serverFileQueryDeleteAclEntered = new Promise((resolve) => { signalAclEntered = resolve; });
  globalThis.__serverFileQueryDeleteAclEnteredResolve = signalAclEntered;
  const definition = capsule({
    name: "server-files-query-unawaited",
    files: {
      acl: {
        delete: async () => {
          globalThis.__serverFileQueryDeleteAclEnteredResolve();
          await globalThis.__serverFileQueryDeleteAclGate;
          return true;
        },
      },
    },
    queries: {
      deleteWithoutAwait: query((ctx, fileReference) => {
        void ctx.files.delete(fileReference);
        return null;
      }),
    },
  });
  const database = await openDevDatabase(
    path.join(directory, "data.db"),
    "",
    {},
    { name: definition.name, files: { storagePath: path.join(directory, "files") } },
    definition,
  );
  const owner = guestAuth("query-unawaited-owner");
  const collaborator = guestAuth("query-unawaited-collaborator");

  try {
    const file = await uploadFile(database, owner, "/query/unawaited.txt", "query unawaited");
    let settled = false;
    const pending = runQuery(database, collaborator, "deleteWithoutAwait", [file.id]).finally(() => { settled = true; });
    await globalThis.__serverFileQueryDeleteAclEntered;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the query must drain the unawaited deletion");
    releaseAcl();
    assert.equal((await pending).error, null);
    assert.equal((await getPrivateFileUrl(database, owner, file.id)).ok, false);
  } finally {
    delete globalThis.__serverFileQueryDeleteAclGate;
    delete globalThis.__serverFileQueryDeleteAclEntered;
    delete globalThis.__serverFileQueryDeleteAclEnteredResolve;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("query middleware cannot retain user File deletion authority", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-server-files-"));
  const definition = capsule({ name: "server-files-query-revocation" });
  const database = await openDevDatabase(
    path.join(directory, "data.db"),
    "",
    {},
    { name: definition.name, files: { storagePath: path.join(directory, "files") } },
    definition,
  );
  const owner = guestAuth("query-file-owner");

  try {
    const file = await uploadFile(database, owner, "/query/source.txt", "query");
    database.contextMiddleware = ["(ctx) => { globalThis.__retainedQueryFiles = ctx.files; return { ...ctx }; }"];
    const result = await runQuery(database, owner, "missingQuery", []);
    assert.match(result.error.message, /Unknown query/);
    await assert.rejects(
      globalThis.__retainedQueryFiles.delete(file.id),
      (error) => error?.message === "File access is no longer active.",
    );
    assert.equal((await getPrivateFileUrl(database, owner, file.id)).ok, true);
  } finally {
    delete globalThis.__retainedQueryFiles;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
