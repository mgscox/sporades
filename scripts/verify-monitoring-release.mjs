#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const [npmArtifactArg, monitoringArtifactArg, ...extraArgs] = process.argv.slice(2);
if (!npmArtifactArg || !monitoringArtifactArg || extraArgs.length) {
  console.error('Usage: node scripts/verify-monitoring-release.mjs <npm-tarball> <monitoring-tar.gz>');
  process.exit(2);
}
const npmArtifact = path.resolve(npmArtifactArg);
const monitoringArtifact = path.resolve(monitoringArtifactArg);
assert(process.env.SPORADES_CONFIG_DIR, 'Set SPORADES_CONFIG_DIR to an existing worktree directory');
const requestedConfig = await realpath(process.env.SPORADES_CONFIG_DIR);
assert(within(await realpath(repository), requestedConfig), 'SPORADES_CONFIG_DIR must be inside the worktree');
const runtimeRoot = await createWorktreeDirectory(repository, '.sporades');
const ownedRoot = await createWorktreeDirectory(runtimeRoot, 'monitoring-release-verification');
const runDir = await checkedDirectory(await mkdtemp(path.join(ownedRoot, `run-${Date.now()}-${process.pid}-`)), 'Run directory');
const configDir = await createWorktreeDirectory(runDir, 'config');
const commandDir = await createWorktreeDirectory(runDir, 'commands');
const extractionDir = await createWorktreeDirectory(runDir, 'monitoring-archive');
const installPrefix = path.join(runDir, 'installed');
const appName = `monitoring-release-${process.pid}-${randomBytes(4).toString('hex')}`;
const appDir = path.join(runDir, appName);

const token = `fixture-${randomBytes(24).toString('hex')}`;
const env = { ...process.env, SPORADES_CONFIG_DIR: configDir, ACCEPTANCE_TOKEN: token, npm_config_cache: path.join(runDir, 'npm-cache'), npm_config_update_notifier: 'false' };
// npm test forwards this root-project setting, which npm 11 rejects for a
// different project. Artifact installation already disables lifecycle scripts.
for (const key of Object.keys(env)) if (/^npm_config_allow_scripts$/i.test(key)) delete env[key];
const commands = [];
let child = null;
let activeCommand = null;
let collector = null;
let signal = null;
let stdout = '';
let stderr = '';
let devError = null;
const otlpPayloads = [];
const report = {
  status: 'pending',
  startedAt: new Date().toISOString(),
  evidenceLevel: 'installed-package Dev acceptance with an explicitly fixture-only loopback OTLP receiver; no Docker Compose, stored-backend, separate-VM, or real Host acceptance',
  runtime: process.version,
  platform: process.platform,
  arch: process.arch,
  osVersion: os.release(),
  versions: {},
  artifacts: {},
  runDirectory: path.relative(repository, runDir),
  privacy: {},
};

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function within(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function checkedDirectory(target, label) {
  const resolved = await realpath(target);
  assert(within(repository, resolved), `${label} must be inside the worktree`);
  assert((await stat(resolved)).isDirectory(), `${label} must be a directory`);
  return resolved;
}
async function createWorktreeDirectory(parent, name) {
  const actualParent = await checkedDirectory(parent, 'Runtime/evidence parent');
  const target = path.join(actualParent, name);
  try { await realpath(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(target, { mode: 0o700 });
  }
  return checkedDirectory(target, 'Runtime/evidence directory');
}
async function assertStatePaths(commandEnv = env) {
  for (const target of [runDir, commandDir, extractionDir]) await checkedDirectory(target, 'Evidence directory');
  const actualConfig = await checkedDirectory(commandEnv.SPORADES_CONFIG_DIR, 'SPORADES_CONFIG_DIR');
  assert.equal(actualConfig, configDir, 'CLI configuration must stay in its owned run directory');
}

async function capture(name, command, args, options = {}) {
  if (signal) throw new Error(`Interrupted by ${signal}`);
  await assertStatePaths(options.env ?? env);
  await checkedDirectory(options.cwd ?? runDir, 'Command working directory');
  const index = commands.length;
  const safeName = `${String(index).padStart(2, '0')}-${name}`;
  const outPath = path.join(commandDir, `${safeName}.stdout`);
  const errPath = path.join(commandDir, `${safeName}.stderr`);
  const startedAt = new Date().toISOString();
  const result = await new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd ?? runDir,
      env: options.env ?? env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeCommand = proc;
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 5000).unref();
    }, 120000);
    proc.stdout.on('data', chunk => { out += chunk; });
    proc.stderr.on('data', chunk => { err += chunk; });
    proc.once('error', error => {
      if (settled) return;
      settled = true;
      activeCommand = null;
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, error: error.message, stdout: out, stderr: err });
    });
    proc.once('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      activeCommand = null;
      clearTimeout(timer);
      resolve({ code, signal: closeSignal, timedOut, stdout: out, stderr: err });
    });
  });
  await assertStatePaths();
  await Promise.all([writeFile(outPath, result.stdout), writeFile(errPath, result.stderr)]);
  const entry = { name, command, args, cwd: options.cwd ?? runDir, startedAt, finishedAt: new Date().toISOString(), code: result.code, signal: result.signal, timedOut: result.timedOut, ...(result.error ? { error: result.error } : {}), stdout: path.relative(repository, outPath), stderr: path.relative(repository, errPath) };
  commands.push(entry);
  if (signal) throw new Error(`Interrupted by ${signal}`);
  if (result.timedOut) throw new Error(`${name} timed out after 120 seconds`);
  if (result.error) throw new Error(`${name} could not start: ${result.error}`);
  if (result.code !== 0) throw new Error(`${name} exited ${result.code ?? result.signal}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}

async function digestFile(file) { return sha256(await readFile(file)); }
function deadlineFetch(url, init = {}, timeoutMs = 5000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
function extractLogs(stdoutText) {
  const value = JSON.parse(stdoutText);
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data?.entries)) return value.data.entries;
  if (Array.isArray(value?.entries)) return value.entries;
  throw new Error('Installed CLI logs output did not contain a JSON entries array');
}

const onSignal = sig => {
  signal ??= sig;
  if (activeCommand && activeCommand.exitCode === null) {
    const interruptedCommand = activeCommand;
    interruptedCommand.kill('SIGTERM');
    setTimeout(() => { if (interruptedCommand.exitCode === null && interruptedCommand.signalCode === null) interruptedCommand.kill('SIGKILL'); }, 5000).unref();
  }
  if (child && child.exitCode === null) child.kill('SIGTERM');
};
const onInterrupt = () => onSignal('SIGINT');
const onTerminate = () => onSignal('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);

try {
  for (const [file, label] of [[npmArtifact, 'npm tarball'], [monitoringArtifact, 'monitoring archive']]) {
    await access(file);
  }
  report.artifacts.npmTarball = { path: path.relative(await realpath(repository), await realpath(npmArtifact)), sha256: await digestFile(npmArtifact) };
  report.artifacts.monitoringArchive = { path: path.relative(await realpath(repository), await realpath(monitoringArtifact)), sha256: await digestFile(monitoringArtifact) };
  report.versions.checkout = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;

  const packJson = await capture('pack-dry-run', 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: repository });
  const packed = JSON.parse(packJson);
  assert.equal(packed.length, 1, 'npm pack dry run must describe exactly one package');
  const shippedFiles = packed[0].files.map(file => file.path).sort();
  assert(shippedFiles.length > 0, 'npm pack dry run returned no files');
  report.versions.pack = packed[0].version;
  assert.equal(report.versions.pack, report.versions.checkout, 'checkout and npm pack versions differ');

  await capture('npm-install', 'npm', ['install', npmArtifact, '--prefix', installPrefix, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: runDir });
  const installedRoot = path.join(installPrefix, 'node_modules', 'sporades');
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  report.versions.installed = installedPackage.version;
  assert.equal(installedPackage.version, report.versions.checkout, 'installed package version differs from checkout');
  let compared = 0;
  for (const file of shippedFiles) {
    const expected = await readFile(path.join(repository, file));
    const actual = await readFile(path.join(installedRoot, file));
    assert(expected.equals(actual), `Installed package bytes differ from checkout: ${file}`);
    compared++;
  }
  report.packageParity = { shippedFiles: compared, byteIdentical: true };

  const listing = await capture('monitoring-archive-list', 'tar', ['-tzf', monitoringArtifact], { cwd: runDir });
  const paths = listing.split(/\r?\n/).filter(Boolean);
  assert(paths.length > 1, 'monitoring archive is empty');
  const roots = new Set(paths.map(p => p.split('/')[0]));
  assert.equal(roots.size, 1, 'monitoring archive must have one top-level directory');
  const archiveRoot = [...roots][0];
  assert(archiveRoot && !archiveRoot.startsWith('.') && !archiveRoot.includes('..'), 'monitoring archive has an unsafe root');
  for (const entry of paths) {
    assert(!path.isAbsolute(entry) && !entry.split('/').includes('..'), `Unsafe monitoring archive path: ${entry}`);
    assert(entry === archiveRoot || entry.startsWith(`${archiveRoot}/`), `Unexpected monitoring archive path: ${entry}`);
  }
  const verbose = await capture('monitoring-archive-types', 'tar', ['-tvzf', monitoringArtifact], { cwd: runDir });
  for (const line of verbose.split(/\r?\n/).filter(Boolean)) {
    const type = line.trimStart()[0];
    assert(type === '-' || type === 'd', `Monitoring archive contains a non-regular entry: ${line}`);
  }
  await capture('monitoring-archive-extract', 'tar', ['-xzf', monitoringArtifact, '--no-same-owner', '--no-same-permissions', '-C', extractionDir], { cwd: runDir });
  const unpackedRoot = path.join(extractionDir, archiveRoot);
  const stackManifest = JSON.parse(await readFile(path.join(unpackedRoot, 'stack-manifest.json'), 'utf8'));
  assert.equal(stackManifest.packageVersion, installedPackage.version, 'monitoring archive package version differs from installed package');
  assert(stackManifest.assets && typeof stackManifest.assets === 'object' && !Array.isArray(stackManifest.assets), 'invalid monitoring stack manifest assets');
  const assetNames = Object.keys(stackManifest.assets).sort();
  const { ASSETS, STACK_SCHEMA } = await import(pathToFileURL(path.join(installedRoot, 'dist/cli/monitoring-stack.js')));
  assert.deepEqual(assetNames, [...ASSETS].sort(), 'Monitoring manifest must include every shipped stack asset');
  assert.equal(stackManifest.schemaVersion, STACK_SCHEMA, 'Monitoring manifest schema differs from installed stack');
  const archiveAssetNames = paths.filter(p => p !== archiveRoot && !p.endsWith('/')).map(p => p.slice(archiveRoot.length + 1)).sort();
  assert.deepEqual(archiveAssetNames, [...assetNames, 'stack-manifest.json'].sort(), 'monitoring archive files differ from manifest asset list');
  for (const asset of assetNames) {
    assert(/^[a-f0-9]{64}$/.test(stackManifest.assets[asset]), `Invalid manifest hash for ${asset}`);
    const archiveBytes = await readFile(path.join(unpackedRoot, asset));
    assert.equal(sha256(archiveBytes), stackManifest.assets[asset], `Monitoring archive hash mismatch: ${asset}`);
    const installedName = asset === '.gitignore' ? 'gitignore.template' : asset;
    const installedBytes = await readFile(path.join(installedRoot, 'monitoring', 'trace', installedName));
    assert(archiveBytes.equals(installedBytes), `Monitoring archive bytes differ from installed package: ${asset}`);
  }
  report.monitoringArchive = { manifestVersion: stackManifest.packageVersion, schemaVersion: stackManifest.schemaVersion, verifiedAssets: assetNames.length, manifestHashesAndInstalledBytesMatch: true };

  const hostHelperPath = path.join(installedRoot, 'bin', 'sporades-host-helper.js');
  const generatedManifestPath = path.join(installedRoot, 'dist', 'generated-source-manifest.json');
  report.artifacts.installedBin = { sha256: await digestFile(path.join(installedRoot, 'bin', 'sporades.js')) };
  report.artifacts.installedHostHelper = { sha256: await digestFile(hostHelperPath) };
  report.artifacts.generatedSourceManifest = { sha256: await digestFile(generatedManifestPath) };

  const cli = path.join(installedRoot, 'bin', 'sporades.js');
  await capture('create-vanilla-capsule', process.execPath, [cli, 'create', appName, '--framework', 'vanilla', '--template', 'blank', '--no-install', '--no-git', '--json'], { cwd: runDir });
  await writeFile(path.join(appDir, 'server', 'index.ts'), `import { capsule, endpoint } from 'sporades/server';\nexport default capsule({ name: '${appName}', endpoints: {\n  work: endpoint({ method: 'GET', path: '/work' }, async ctx => {\n    const label = ctx.request.query.label === 'slow' ? 'slow' : 'fast';\n    ctx.log.info('acceptance-start', { label });\n    await new Promise(resolve => setTimeout(resolve, label === 'slow' ? 150 : 5));\n    ctx.log.info('acceptance-end', { label });\n    return { status: 200, body: { label } };\n  }),\n  fail: endpoint({ method: 'GET', path: '/fail' }, async () => { throw new Error('fixture-private-exception'); }),\n} });\n`);
  await capture('add-loopback-telemetry-profile', process.execPath, [cli, 'telemetry', 'profile', 'add', 'monitoring-release-local', '--endpoint', 'http://127.0.0.1:5219', '--loopback', '--credential-env', 'ACCEPTANCE_TOKEN', '--metrics-interval-ms', '5000', '--json'], { cwd: runDir });

  collector = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      otlpPayloads.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    } catch {
      response.writeHead(401);
      response.end('{}');
    }
  });
  collector.listen(5219, '127.0.0.1');
  await once(collector, 'listening');
  const devPortProbe = createServer();
  devPortProbe.listen(5218, '127.0.0.1');
  await once(devPortProbe, 'listening');
  await new Promise((resolve, reject) => devPortProbe.close(error => error ? reject(error) : resolve()));
  await assertStatePaths();
  await checkedDirectory(appDir, 'Capsule working directory');
  child = spawn(process.execPath, [cli, 'dev', '--port', '5218', '--telemetry', 'monitoring-release-local'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.once('error', error => { devError = error; });
  const readyUntil = Date.now() + 60000;
  let ready = false;
  while (!ready && Date.now() < readyUntil) {
    if (signal) throw new Error(`Interrupted by ${signal}`);
    if (devError) throw devError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Installed Dev exited ${child.exitCode ?? child.signalCode}: ${stderr}\n${stdout}`);
    ready = await deadlineFetch('http://127.0.0.1:5218/', {}, 1000).then(response => response.ok).catch(() => false);
    if (!ready) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, `Installed Dev did not become ready: ${stderr}`);
  await assert.rejects(stat(path.join(appDir, 'node_modules')), { code: 'ENOENT' }, 'Capsule unexpectedly has node_modules');

  const requests = [['slow', '1'.repeat(32)], ['fast', '2'.repeat(32)]];
  await Promise.all(requests.map(async ([label, traceId]) => {
    const response = await deadlineFetch(`http://127.0.0.1:5218/work?label=${label}&private=fixture-private-query`, { headers: { traceparent: `00-${traceId}-${'a'.repeat(16)}-01`, baggage: 'seed=fixture-private-baggage', authorization: 'Bearer fixture-private-header' } }, 10000);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { label });
  }));
  const failureTraceId = '3'.repeat(32);
  const failure = await deadlineFetch('http://127.0.0.1:5218/fail', { headers: { traceparent: `00-${failureTraceId}-${'a'.repeat(16)}-01` } }, 10000);
  assert.equal(failure.status, 500, 'synthetic endpoint failure should be translated to HTTP 500');
  const requiredTraceIds = [...requests.map(([, traceId]) => traceId), failureTraceId];
  const requiredMetricNames = ['http.server.request.count', 'http.server.request.duration', 'process.memory.rss', 'process.cpu.time'];
  const receivedTelemetry = () => {
    const spans = otlpPayloads.flatMap(item => item.body.resourceSpans ?? []).flatMap(resource => resource.scopeSpans ?? []).flatMap(scope => scope.spans ?? []);
    const metricNames = [...new Set(otlpPayloads.flatMap(item => item.body.resourceMetrics ?? []).flatMap(resource => resource.scopeMetrics ?? []).flatMap(scope => scope.metrics ?? []).map(metric => metric.name))].sort();
    const missing = [
      ...requiredTraceIds.filter(traceId => !spans.some(span => span.traceId === traceId && span.kind === 2)).map(traceId => `SERVER trace ${traceId}`),
      ...requiredMetricNames.filter(name => !metricNames.includes(name)).map(name => `metric ${name}`),
    ];
    return { spans, metricNames, missing };
  };
  const otlpUntil = Date.now() + 20000;
  let received = receivedTelemetry();
  while (received.missing.length && Date.now() < otlpUntil) {
    if (signal) throw new Error(`Interrupted by ${signal}`);
    await new Promise(resolve => setTimeout(resolve, 200));
    received = receivedTelemetry();
  }
  assert.equal(received.missing.length, 0, `Timed out waiting for required telemetry: ${received.missing.join(', ')}`);
  const { spans, metricNames } = received;
  assert.equal(spans.filter(span => span.traceId === failureTraceId && span.kind === 2).length, 1, `Expected exactly one failure SERVER span for trace ${failureTraceId}`);
  const otlpText = JSON.stringify(otlpPayloads);
  assert.doesNotMatch(otlpText, /fixture-private-(?:query|baggage|header|exception)/, 'private fixture data leaked into OTLP payloads');
  assert(!otlpText.includes(token), 'Ingestion credential leaked into OTLP payloads');
  const browserBundle = await readFile(path.join(appDir, '.sporades', 'build', 'client.js'), 'utf8');
  assert(!browserBundle.includes(token) && !browserBundle.includes('fixture-private-'), 'Server-only fixture material leaked into the browser Bundle');
  for (const [, traceId] of requests) assert.equal(spans.filter(span => span.traceId === traceId && span.kind === 2).length, 1, `Expected exactly one SERVER span for trace ${traceId}`);

  const logOutput = await capture('installed-cli-logs', process.execPath, [cli, 'logs', '--json', '--port', '5218'], { cwd: appDir });
  const logEntries = extractLogs(logOutput);
  for (const [label, traceId] of requests) {
    const matching = logEntries.filter(entry => entry.event === 'ctx.log' && entry.data?.label === label);
    const starts = matching.filter(entry => entry.message === 'acceptance-start');
    const ends = matching.filter(entry => entry.message === 'acceptance-end');
    assert.equal(starts.length, 1, `Expected one ${label} acceptance-start log`);
    assert.equal(ends.length, 1, `Expected one ${label} acceptance-end log`);
    for (const entry of [...starts, ...ends]) {
      assert.equal(entry.traceId, traceId, `${label} log trace ID mismatch`);
      assert(spans.some(span => span.traceId === entry.traceId && span.spanId === entry.spanId), `${label} log span is missing from exported trace`);
    }
    assert.equal(starts[0].request?.id, ends[0].request?.id, `${label} start/end logs have different request IDs`);
    assert.equal(starts[0].request?.id?.length > 0, true, `${label} logs have no request ID`);
  }
  assert.equal(new Set(logEntries.filter(entry => entry.message === 'acceptance-start').map(entry => entry.request?.id)).size, 2, 'Overlapping requests must have distinct request IDs');
  report.requestLogs = { labels: requests.map(([label, traceId]) => ({ label, traceId, paired: true })), requestIdsMatchWithinEachRequest: true };
  report.privacy = { privateQueryAbsentFromOtlp: !otlpText.includes('fixture-private-query'), privateBaggageAbsentFromOtlp: !otlpText.includes('fixture-private-baggage'), privateHeaderAbsentFromOtlp: !otlpText.includes('fixture-private-header'), privateExceptionAbsentFromOtlp: !otlpText.includes('fixture-private-exception'), credentialAbsentFromOtlp: true, serverMaterialAbsentFromBrowserBundle: true };
  report.http = { concurrentSuccesses: 2, translatedFailure: failure.status, appNodeModules: false };
  report.telemetry = { receiver: '127.0.0.1:5219 fixture-only', authenticatedMetricsAndTracesReceived: true, spans: spans.length, metricNames, traceIds: requests.map(([, traceId]) => traceId), failureTraceId, failureServerSpanVerified: true };
  report.artifacts.generatedCapsule = { path: path.relative(repository, path.join(appDir, '.sporades', 'build', 'server.mjs')), sha256: await digestFile(path.join(appDir, '.sporades', 'build', 'server.mjs')) };
  report.status = 'passed';
} catch (error) {
  report.status = signal ? 'interrupted' : 'failed';
  report.error = error?.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 10000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    }
  }
  report.devProcess = child ? { exitCode: child.exitCode, signal: child.signalCode } : null;
  if (signal) { report.status = 'interrupted'; report.signal = signal; process.exitCode = 1; }
  if (collector) {
    collector.closeAllConnections();
    await new Promise(resolve => collector.close(resolve));
  }
  report.finishedAt = new Date().toISOString();
  report.commands = commands;
  report.devStdout = path.relative(repository, path.join(runDir, 'dev.stdout'));
  report.devStderr = path.relative(repository, path.join(runDir, 'dev.stderr'));
  report.otlpFixturePayloads = path.relative(repository, path.join(runDir, 'otlp-fixture-payloads.json'));
  await assertStatePaths();
  await Promise.all([
    writeFile(path.join(runDir, 'dev.stdout'), stdout),
    writeFile(path.join(runDir, 'dev.stderr'), stderr),
    writeFile(path.join(runDir, 'otlp-fixture-payloads.json'), `${JSON.stringify(otlpPayloads, null, 2)}\n`),
    writeFile(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`),
  ]);
  console.log(JSON.stringify(report, null, 2));
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
