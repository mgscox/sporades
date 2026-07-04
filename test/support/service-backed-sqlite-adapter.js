import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { createSqliteDatabaseAdapter } from "../../src/server-runtime-source.js";

const serviceScript = fileURLToPath(new URL("./sqlite-http-service.js", import.meta.url));
const requestScript = fileURLToPath(new URL("./sqlite-http-request.js", import.meta.url));

export async function createServiceBackedSqliteAdapter(databasePath) {
  const service = spawn(process.execPath, [serviceScript, databasePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  service.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  const lines = createInterface({ input: service.stdout });
  const [firstLine] = await Promise.race([
    once(lines, "line"),
    once(service, "exit").then(([code]) => {
      throw new Error(`SQLite service exited before startup with code ${code}: ${stderr.join("")}`);
    }),
  ]);
  const { port } = JSON.parse(firstLine);
  const endpoint = `http://127.0.0.1:${port}/query`;

  const shape = await createSqliteDatabaseAdapter(`${databasePath}.shape`);
  shape.close();

  return {
    ...shape,
    exec(sql) {
      request(endpoint, { operation: "exec", sql });
    },
    prepare(sql) {
      return {
        all(...params) {
          return request(endpoint, { operation: "all", sql, params });
        },
        get(...params) {
          return request(endpoint, { operation: "get", sql, params });
        },
        run(...params) {
          return request(endpoint, { operation: "run", sql, params });
        },
        columns() {
          return request(endpoint, { operation: "columns", sql });
        },
      };
    },
    close() {
      lines.close();
      service.kill("SIGTERM");
    },
  };
}

function request(endpoint, payload) {
  const output = execFileSync(process.execPath, [requestScript, endpoint], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(output);
  if (!result.ok) {
    throw new Error(result.error?.message ?? "SQLite service request failed.");
  }
  return result.data;
}
