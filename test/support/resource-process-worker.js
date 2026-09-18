import { openDevDatabase, createControllableRuntimeClock, recoverExpiredJobLeases, runMutation } from '../../dist/server-runtime-source.js';
import { table, String as Text, job, mutation } from '../../dist/server.js';
const teamId = '11111111-1111-4111-8111-111111111111';
const messages = new Map();
const pending = new Map();
function wait(key) {
  if (messages.has(key)) { const value = messages.get(key); messages.delete(key); return Promise.resolve(value); }
  return new Promise(resolve => pending.set(key, resolve));
}
const send = (kind, data = {}) => process.send({ kind, ...data });
let database;
let escaped;
let clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
process.on('message', async message => {
  if (message.kind === 'recover') {
    try { await recoverExpiredJobLeases(database); send('recovered', { code: 'COMMITTED' }); }
    catch (error) { send('recovered', { code: error.errcode === 5 ? 'SQLITE_BUSY' : error.code }); }
  } else if (message.kind === 'lose-response') {
    const original = database.adapter.withResourceTransaction.bind(database.adapter);
    database.adapter.withResourceTransaction = async (...args) => {
      await original(...args);
      send('commit-response-lost');
      await new Promise(() => {});
    };
    send('configured');
  } else if (message.kind === 'advance') {
    clock.advanceBy(message.ms);
    if (message.timers) await clock.runDueTimers();
    send('advanced');
  } else if (message.kind === 'shutdown') {
    await database.shutdown(); send('shutdown');
  } else if (message.kind === 'grant-change') {
    try {
      if (message.action === 'membership-revoke') database.adapter.prepare('DELETE FROM sporades_team_memberships WHERE teamId=? AND userId=?').run(teamId, 'actor');
      else {
        const outcome = await runMutation(database, { userId: 'actor', displayName: 'Actor', email: null, picture: null, isAuthenticated: true, isGuest: false, provider: 'email' }, 'changeGrant', [message.action]);
        if (!outcome.ok) throw Object.assign(new Error('Grant change failed.'), { code: outcome.error?.code });
      }
      send('grant-change', { code: 'COMMITTED', action: message.action });
    } catch (error) {
      send('grant-change', { code: error.errcode === 5 || error.errcode === 6 ? 'SQLITE_BUSY' : error.code, action: message.action });
    }
  } else if (message.kind === 'late') {
    try { await escaped.insert({ value: 'late' }); send('late', { code: 'UNEXPECTED_SUCCESS' }); }
    catch (error) { send('late', { code: error.code }); }
  } else if (message.kind === 'close') {
    await database.close(); process.disconnect();
  } else if (pending.has(message.kind)) {
    const resolve = pending.get(message.kind); pending.delete(message.kind); resolve(message);
  } else messages.set(message.kind, message);
});
const definition = {
  schema: { anchors: table({ value: Text() }).acl({
    read: ({ ctx }) => ctx.acl.teams.isMember(teamId),
    write: ({ ctx }) => ctx.acl.teams.isMember(teamId),
  }), writes: table({ value: Text() }) },
  mutations: { changeGrant: mutation(async (ctx, action) => ctx.resources.run({ resource: { table: 'anchors', id: 'anchor' }, operationId: `grant-${action}`, input: null }, async scope => {
    if (action === 'revoke') await scope.db.anchors.delete('anchor');
    else await scope.db.anchors.update('anchor', { value: 'rotated' });
    return { changed: action };
  })) },
  jobs: { work: job(async (ctx, payload) => {
    send('claimed');
    const command = await wait('acquire');
    if (command.action === 'cancel') {
      try { await ctx.jobs.cancel('a'); send('cancel-first', { code: 'COMMITTED' }); }
      catch (error) { send('cancel-first', { code: error.errcode === 5 ? 'SQLITE_BUSY' : error.code }); }
      await wait('retry-cancel');
      await ctx.jobs.cancel('a'); send('cancel-committed');
      await wait('settle'); return null;
    }
    try {
      const value = await ctx.resources.run({ resource: { table: 'anchors', id: 'anchor' }, operationId: payload.operation, input: null }, async scope => {
        escaped = scope.db.writes;
        const anchor = await scope.db.anchors.where('id', 'anchor').get();
        send('observed', { value: anchor?.value ?? null });
        await scope.db.writes.insert({ value: 'protected' });
        send('entered');
        await wait('release');
        if (payload.fail) throw new Error('fixture rollback');
        return { committed: true };
      });
      send('outcome', { code: 'COMMITTED', replay: value.committed });
    } catch (error) { send('outcome', { code: error.code ?? 'CALLBACK_FAILED' }); }
    await wait('settle');
    return null;
  }) },
};
database = await openDevDatabase(process.argv[2], '', {}, { name: 'resource-process' }, definition, { clock });
await database.init();
send('ready');
await wait('start');
await clock.runDueTimers();
send('settled');
