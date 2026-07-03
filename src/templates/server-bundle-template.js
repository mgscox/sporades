import { SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../server-runtime-source.js";

export function createServerBundleSource({ config, serverEnv, serverSource, serverModuleSource }) {
  const runtimeFunctions = SERVER_RUNTIME_SOURCE_FUNCTIONS
    .map((fn) => fn.toString())
    .join("\n\n");
  const serverModuleDataUrl = `data:text/javascript;base64,${Buffer.from(serverModuleSource, "utf8").toString("base64")}`;

  return `// Sporades server bundle
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

export const sporadesConfig = ${JSON.stringify(config, null, 2)};
export const sporadesServerEnv = ${JSON.stringify(serverEnv, null, 2)};
export const sporadesServerSource = ${JSON.stringify(serverSource)};
const sporadesCapsuleModule = await import(${JSON.stringify(serverModuleDataUrl)});
const sporadesCapsuleDefinition = sporadesCapsuleModule.default ?? null;

${runtimeFunctions}

const port = Number(process.env.PORT ?? sporadesConfig.deploy?.port ?? 4000);
const databasePath = process.env.SPORADES_DATABASE_PATH ?? path.join(process.cwd(), "data", "data.db");
const database = await openDevDatabase(databasePath, sporadesServerSource, sporadesServerEnv, sporadesConfig, sporadesCapsuleDefinition);
const websocketHub = createWebSocketHub(() => database);

const server = createServer(async (request, response) => {
  try {
    if (await routeSporadesAuth(database, request, response)) {
      return;
    }

    if (await handleFileHttpRoute(database, request, response, websocketHub)) {
      return;
    }

    if (await routeEndpoint(database, request, response)) {
      return;
    }

    if (request.url === "/" || request.url === "/index.html") {
      const html = await readRuntimeFile("index.html", path.join(process.cwd(), "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (request.url === "/client.js") {
      const client = await readRuntimeFile("client.js", path.join(process.cwd(), ".sporades", "build", "client.js"));
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(client);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error.message);
  }
});

server.on("upgrade", (request, socket) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  if (requestUrl.pathname !== "/__sporades/ws") {
    socket.destroy();
    return;
  }
  websocketHub.accept(request, socket);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "0.0.0.0", resolve);
});

const shutdown = () => {
  websocketHub.disconnectAll();
  server.close(() => {
    database.close();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function readRuntimeFile(containerFileName, fallbackPath) {
  try {
    return await readFile(path.join(process.cwd(), containerFileName), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return readFile(fallbackPath, "utf8");
  }
}
`;
}
