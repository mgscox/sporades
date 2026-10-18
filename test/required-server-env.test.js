import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/sporades.js');
async function temporary(run) {
  const dir = await mkdtemp(path.join(root, '.sporades-required-env-test-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function runCli(dir, args, input, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: dir, encoding: 'utf8', input, timeout: 20000,
    env: { ...process.env, SPORADES_CONFIG_DIR: path.join(dir, 'cli-config'), ...extraEnv },
  });
  assert.equal(result.error, undefined);
  return { ...result, output: JSON.parse(result.stdout) };
}

test('shipped doctor checks decrypted Sealed Server env, rejects blank keys, and exposes names only', async () => temporary(async dir => {
  await mkdir(path.join(dir, 'server'));
  await writeFile(path.join(dir, 'server/index.ts'), 'export default { schema: {} };');
  await writeFile(path.join(dir, 'sporades.json'), JSON.stringify({ name: 'env-check', env: { required: ['INTAKE_URL', 'TOKEN', 'INTAKE_URL'] } }));
  const check = result => result.output.data.checks.find(entry => entry.id === 'doctor.server-env');
  let result = runCli(dir, ['doctor'], undefined, { TOKEN: 'ambient-shell-probe' });
  assert.equal(result.status, 1);
  assert.deepEqual(check(result).details.missingKeys, ['INTAKE_URL', 'TOKEN']);
  assert.equal(runCli(dir, ['env', 'set', 'TOKEN', '--stdin'], 'private-probe-value').status, 0);
  result = runCli(dir, ['doctor']);
  assert.deepEqual(check(result).details.missingKeys, ['INTAKE_URL']);
  assert.equal((result.stdout + result.stderr).includes('private-probe-value'), false);
  assert.equal(runCli(dir, ['env', 'set', 'INTAKE_URL', '--stdin'], '   ').status, 0);
  assert.deepEqual(check(runCli(dir, ['doctor'])).details.missingKeys, ['INTAKE_URL']);
  assert.equal(runCli(dir, ['env', 'set', 'INTAKE_URL', '--stdin'], 'https://example.test/intake').status, 0);
  result = runCli(dir, ['doctor']);
  assert.equal(check(result).status, 'pass');
  assert.equal(result.status, 0, result.stdout);
  // The sealed source wins even if the legacy file supplies a now-missing key.
  assert.equal(runCli(dir, ['env', 'set', 'TOKEN', '--stdin'], '').status, 0);
  await writeFile(path.join(dir, '.env.sporades.server'), 'TOKEN=legacy-probe\n');
  assert.deepEqual(check(runCli(dir, ['doctor'])).details.missingKeys, ['TOKEN']);
  await writeFile(path.join(dir, '.sporades/sealed-server-env/server-env.private.pem'), 'invalid-private-probe');
  result = runCli(dir, ['doctor']);
  assert.equal(check(result).status, 'fail');
  assert.equal(result.stdout.includes('invalid-private-probe'), false);
}));

test('runtime boot logs exactly one names-only error; failClosed refuses before opening storage', async () => temporary(async dir => {
  const { openDevDatabase, shutdownAndCloseDatabase } = await import('../dist/server-runtime-source.js');
  const dbPath = path.join(dir, 'data.db');
  const logPath = path.join(dir, 'boot.jsonl');
  const config = { name: 'env-check', env: { required: ['MISSING_KEY', 'PRESENT_KEY', 'MISSING_KEY'] }, logs: { jsonlPath: logPath } };
  const db = await openDevDatabase(dbPath, '', { PRESENT_KEY: 'private-boot-probe' }, config);
  await shutdownAndCloseDatabase(db);
  let events = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.event === 'env.required.missing');
  assert.equal(events.length, 1);
  assert.equal(events[0].level, 'error');
  assert.match(events[0].message, /MISSING_KEY/);
  assert.equal(JSON.stringify(events).includes('private-boot-probe'), false);
  const deniedPath = path.join(dir, 'denied.db');
  await assert.rejects(openDevDatabase(deniedPath, '', {}, { ...config, env: { ...config.env, failClosed: true } }), { code: 'MISSING_REQUIRED_SERVER_ENV' });
  await assert.rejects(readFile(deniedPath), { code: 'ENOENT' });
  events = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.event === 'env.required.missing');
  assert.equal(events.length, 2);
  assert.match(events[1].message, /MISSING_KEY, PRESENT_KEY/);
  // A later boot uses fresh values, and healthy boots emit no missing-env event.
  const healthy = await openDevDatabase(deniedPath, '', { MISSING_KEY: 'set', PRESENT_KEY: 'set' }, { ...config, env: { ...config.env, failClosed: true } });
  await shutdownAndCloseDatabase(healthy);
  assert.equal((await readFile(logPath, 'utf8')).split('env.required.missing').length - 1, 2);
}));

const mail = {
  smtp: { vendor: 'generic', host: 'smtp.example.test', port: 465, tls: { mode: 'implicit' }, auth: { method: 'PLAIN', usernameEnv: 'SMTP_USERNAME', passwordEnv: 'SMTP_PASSWORD' } },
  webhooks: { mailjet: { path: '/mail-events', secretEnv: 'MAIL_WEBHOOK_SECRET' } },
};

test('configured SMTP, webhook and enabled payments keys are implied; dormant integrations require nothing', async () => temporary(async dir => {
  const { STRIPE_API_VERSION } = await import('../dist/stripe-payment-config.js');
  const payments = { stripe: { enabled: true, secretKeyEnv: 'STRIPE_KEY', webhookSecretEnv: 'STRIPE_WEBHOOK', publicOrigin: 'https://capsule.example.test', callbackPath: '/stripe-events', apiVersion: STRIPE_API_VERSION, livemode: false, requestTimeoutMs: 1000 } };
  await writeFile(path.join(dir, 'sporades.json'), JSON.stringify({ name: 'env-implied', env: {}, mail, payments }));
  const result = runCli(dir, ['doctor']);
  assert.deepEqual(result.output.data.checks.find(c => c.id === 'doctor.server-env').details.missingKeys,
    ['MAIL_WEBHOOK_SECRET', 'SMTP_PASSWORD', 'SMTP_USERNAME', 'STRIPE_KEY', 'STRIPE_WEBHOOK']);
  const { openDevDatabase, shutdownAndCloseDatabase } = await import('../dist/server-runtime-source.js');
  const log = path.join(dir, 'implied.jsonl');
  const config = { name: 'implied', mail, logs: { jsonlPath: log } };
  // Omitted env preserves boot availability while reporting implied missing names.
  const db = await openDevDatabase(path.join(dir, 'data.db'), '', {}, config);
  await shutdownAndCloseDatabase(db);
  assert.match(await readFile(log, 'utf8'), /MAIL_WEBHOOK_SECRET, SMTP_PASSWORD, SMTP_USERNAME/);
  // Existing Capsules have no new doctor failure unless they opt into enforcement.
  await writeFile(path.join(dir, 'sporades.json'), JSON.stringify(config));
  assert.equal(runCli(dir, ['doctor']).output.data.checks.some(c => c.id === 'doctor.server-env'), false);
  await writeFile(path.join(dir, 'sporades.json'), JSON.stringify({ name: 'dormant', env: {}, payments: { stripe: { enabled: false } }, mail: { smtp: { ...mail.smtp, auth: { method: 'none' } } } }));
  assert.equal(runCli(dir, ['doctor']).output.data.checks.find(c => c.id === 'doctor.server-env').status, 'pass');
}));

test('default webhook secret references are implied while disabled webhooks add no requirements', async () => temporary(async dir => {
  await writeFile(path.join(dir, 'sporades.json'), JSON.stringify({ name: 'webhooks', env: {}, mail: { webhooks: { mailjet: {}, postmark: { secretEnv: 'CUSTOM_WEBHOOK' }, mailgun: { enabled: false } } } }));
  const result = runCli(dir, ['doctor']);
  assert.deepEqual(result.output.data.checks.find(c => c.id === 'doctor.server-env').details.missingKeys, ['CUSTOM_WEBHOOK', 'MAILJET_WEBHOOK_SECRET']);
}));

test('invalid env requirements are opaque and rejected consistently by config, doctor and runtime', async () => temporary(async dir => {
  const { readProjectConfig } = await import('../dist/cli/project-config.js');
  const { openDevDatabase } = await import('../dist/server-runtime-source.js');
  for (const env of [null, false, [], { required: 'SECRET' }, { required: ['bad-probe-key-value'] }, { required: ['SPORADES_PRIVATE'] }, { required: ['__proto__'] }, { required: ['A'.repeat(129)] }, { required: Array(65).fill('KEY') }, { failClosed: 'yes' }, { extra: 'private-probe' }]) {
    await writeFile(path.join(dir, 'sporades.json'), JSON.stringify({ env }));
    await assert.rejects(readProjectConfig(dir), { code: 'INVALID_SERVER_ENV_CONFIG' });
    const result = runCli(dir, ['doctor']);
    assert.equal(result.output.data.checks.find(c => c.id === 'doctor.project-config').status, 'fail');
    assert.equal(result.stdout.includes('private-probe'), false);
    assert.equal(result.stdout.includes('bad-probe-key-value'), false);
    await assert.rejects(openDevDatabase(path.join(dir, 'never.db'), '', {}, { env }), { code: 'INVALID_SERVER_ENV_CONFIG' });
  }
  let getterCalled = false;
  const env = Object.defineProperty({}, 'required', { enumerable: true, get() { getterCalled = true; return []; } });
  await assert.rejects(openDevDatabase(path.join(dir, 'never.db'), '', {}, { env }), { code: 'INVALID_SERVER_ENV_CONFIG' });
  assert.equal(getterCalled, false);
  await assert.rejects(readFile(path.join(dir, 'never.db')), { code: 'ENOENT' });
}));

test('generated server Bundle logs missing keys and enforces failClosed with sealed runtime values', async () => temporary(async dir => {
  const { createServerBundleModuleSource } = await import('../dist/templates/server-bundle-module-graph.js');
  assert.equal(runCli(dir, ['env', 'set', 'PRESENT_KEY', '--stdin'], 'private-bundle-probe').status, 0);
  const source = await createServerBundleModuleSource({
    config: { name: 'sealed-env-parity', env: { required: ['MISSING_KEY', 'PRESENT_KEY'], failClosed: true }, logs: { jsonlPath: path.join(dir, 'bundle.jsonl') } },
    serverEnv: {}, sealedServerEnv: { enabled: true }, serverSource: '', serverModuleSource: 'export default {};',
  });
  const bundle = path.join(dir, 'server.mjs');
  await writeFile(bundle, source);
  const result = spawnSync(process.execPath, [bundle], {
    cwd: dir, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PORT: '0', SPORADES_CONFIG_DIR: path.join(dir, 'cli-config'), SPORADES_DATABASE_PATH: path.join(dir, 'never.db'), SPORADES_LOG_STDOUT: '1' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MISSING_REQUIRED_SERVER_ENV/);
  const events = result.stdout.trim().split('\n').map(JSON.parse).filter(e => e.event === 'env.required.missing');
  assert.equal(events.length, 1);
  assert.equal(events[0].message, 'Missing required Server env keys: MISSING_KEY');
  assert.equal((result.stdout + result.stderr).includes('private-bundle-probe'), false);
  await assert.rejects(readFile(path.join(dir, 'never.db')), { code: 'ENOENT' });
}));

test('generated Bundle continues by default and starts failClosed after required env is restored', async () => temporary(async dir => {
  const { createServerBundleModuleSource } = await import('../dist/templates/server-bundle-module-graph.js');
  for (const restored of [false, true]) {
    const log = path.join(dir, `generated-${restored}.jsonl`);
    const source = await createServerBundleModuleSource({
      config: { name: 'env-boot-parity', env: { required: ['APP_URL'], failClosed: restored }, mail: { webhooks: { postmark: {} } }, logs: { jsonlPath: log } },
      serverEnv: restored ? { APP_URL: 'private-restored-probe', POSTMARK_WEBHOOK_SECRET: 'private-restored-probe' } : {},
      serverSource: '', serverModuleSource: 'export default { schema: {} };',
      epilogue: "await new Promise(resolve => server.close(resolve)); await shutdownAndCloseDatabase(database); process.stdout.write('started');",
    });
    const bundle = path.join(dir, 'server.mjs');
    await writeFile(bundle, source);
    const result = spawnSync(process.execPath, [bundle], {
      cwd: dir, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PORT: '0', SPORADES_CONFIG_DIR: path.join(dir, 'cli-config'), SPORADES_LOG_STDOUT: '0' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, 'started');
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.event === 'env.required.missing');
    assert.equal(events.length, restored ? 0 : 1);
    if (!restored) assert.equal(events[0].message, 'Missing required Server env keys: APP_URL, POSTMARK_WEBHOOK_SECRET');
    assert.equal((result.stdout + result.stderr + JSON.stringify(events)).includes('private-restored-probe'), false);
  }
}));

test('failClosed boot with a relative database filename writes diagnostics beside it without claiming its path', async () => temporary(async dir => {
  const runtime = new URL('../dist/server-runtime-source.js', import.meta.url).href;
  const program = `import { openDevDatabase } from ${JSON.stringify(runtime)};
    try { await openDevDatabase('denied.db', '', {}, { env: { required: ['KEY'], failClosed: true } }); }
    catch (error) { process.stdout.write(error.code); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: dir, encoding: 'utf8', timeout: 15000, env: { ...process.env, SPORADES_CONFIG_DIR: path.join(dir, 'cli-config') },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, 'MISSING_REQUIRED_SERVER_ENV');
  await assert.rejects(readFile(path.join(dir, 'denied.db')), { code: 'ENOENT' });
  assert.match(await readFile(path.join(dir, 'logs/events.jsonl'), 'utf8'), /Missing required Server env keys: KEY/);
}));
