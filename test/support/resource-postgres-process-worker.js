import { createPostgresDatabaseAdapter } from '../../dist/server-runtime-source.js';

const messages = new Map();
const waiting = new Map();
const send = (kind, detail = {}) => process.send?.({ kind, ...detail });
function wait(kind) {
  if (messages.has(kind)) { const value = messages.get(kind); messages.delete(kind); return Promise.resolve(value); }
  return new Promise((resolve) => waiting.set(kind, resolve));
}

process.on('message', (message) => {
  const resolve = waiting.get(message.kind);
  if (resolve) { waiting.delete(message.kind); resolve(message); }
  else messages.set(message.kind, message);
});

try {
  const adapter = await createPostgresDatabaseAdapter({ url: process.env.SPORADES_POSTGRES_TEST_URL });
  send('ready');
  await wait('start');
  await adapter.withResourceTransaction(async (transaction) => {
    await transaction.prepare("INSERT INTO ticket04_process_writes (owner) VALUES ('A')").run();
    await transaction.prepare("INSERT INTO sporades_resource_receipts VALUES ('anchors','anchor','process-death','input','actor','{}','[]','2030-01-01T00:00:00.000Z')").run();
    send('entered');
    const release = await wait('release');
    if (release.rollback) throw new Error('requested rollback');
    await transaction.prepare("INSERT INTO ticket04_process_writes (owner) VALUES ('A-after-barrier')").run();
  }, undefined, { table: 'anchors', id: 'anchor' });
  send('outcome', { code: 'COMMITTED' });
  await adapter.close();
  process.disconnect?.();
} catch (error) {
  send('error', { code: error?.code, message: error?.message });
  process.exitCode = 1;
}
