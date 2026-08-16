import { withFakeLibsqlService } from "./libsql-http-service.js";

const databasePath = process.argv[2];
if (!databasePath) process.exit(1);

let stop;
const stopped = new Promise((resolve) => { stop = resolve; });
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

await withFakeLibsqlService(databasePath, async ({ url }) => {
  process.stdout.write(`${JSON.stringify({ url })}\n`);
  await stopped;
});
