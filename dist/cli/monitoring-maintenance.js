import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { chown, chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSETS, STACK_SCHEMA, prerequisite } from './monitoring-stack.js';
import { commandError } from './cli-support.js';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fail() { throw commandError('Monitoring maintenance could not complete.', 'Keep services stopped. Check protected paths, stack provenance, configuration and the maintenance guide; retry with the same inputs. No backend history or Capsule data is deleted.'); }
async function exists(file) { try {
    return await lstat(file);
}
catch (e) {
    if (e.code === 'ENOENT')
        return null;
    throw e;
} }
async function regular(file) { const st = await lstat(file); if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o022)
    fail(); return readFile(file); }
async function safeDirectory(dir, privateMode = false) { const st = await lstat(dir); if (!st.isDirectory() || st.isSymbolicLink() || st.mode & (privateMode ? 0o077 : 0o022) || (process.geteuid && st.uid !== process.geteuid()))
    fail(); }
async function atomic(file, bytes, mode = 0o600) {
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    const handle = await open(temp, 'wx', mode);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(temp, file);
    const dir = await open(path.dirname(file), 'r');
    try {
        await dir.sync();
    }
    finally {
        await dir.close();
    }
}
function docker(args, cwd) {
    const r = spawnSync('docker', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0 || r.error)
        fail();
    return r.stdout.trim();
}
const compose = (dir, args) => docker(['compose', '--env-file', '.compose.env', ...args], dir);
function stopped(dir) {
    const ids = compose(dir, ['ps', '--all', '--quiet']).split(/\s+/).filter(Boolean);
    if (ids.length && JSON.parse(docker(['inspect', ...ids], dir)).some((c) => c.State?.Running || c.State?.Restarting || c.State?.Paused))
        fail();
}
function manifest(bytes) {
    const m = JSON.parse(bytes.toString());
    if (![3, 4].includes(m.schemaVersion) || typeof m.packageVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(m.packageVersion))
        fail();
    if (m.assets && (typeof m.assets !== 'object' || Array.isArray(m.assets) || Object.entries(m.assets).some(([k, v]) => !ASSETS.includes(k) || typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))))
        fail();
    return m;
}
async function sourceAssets(packageRoot) {
    const assets = {};
    for (const name of ASSETS)
        assets[name] = digest(await readFile(path.join(packageRoot, 'monitoring/trace', name === '.gitignore' ? 'gitignore.template' : name)));
    const version = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version;
    return { schemaVersion: STACK_SCHEMA, packageVersion: version, assets };
}
async function validateEnvironment(dir, packageRoot) {
    const setup = await import(pathToFileURL(path.join(packageRoot, 'monitoring/trace/setup.mjs')).href);
    if (setup.inspectEnvironment((await regular(path.join(dir, '.env'))).toString()).missing.length)
        fail();
    await regular(path.join(dir, '.compose.env'));
}
// A durable before-image is written before any generated file is replaced.
// Re-entry restores an interrupted attempt before planning a new one.
async function apply(dir, stateDir, next, recordPrevious = true) {
    const before = {};
    for (const name of Object.keys(next)) {
        const f = path.join(dir, name);
        before[name] = await exists(f) ? (await regular(f)).toString('base64') : null;
    }
    await atomic(path.join(stateDir, 'journal.json'), JSON.stringify(before));
    for (const [name, bytes] of Object.entries(next)) {
        if (bytes === null)
            await rm(path.join(dir, name), { force: true });
        else
            await atomic(path.join(dir, name), Buffer.from(bytes, 'base64'), 0o644);
    }
    if (recordPrevious)
        await atomic(path.join(stateDir, 'previous.json'), JSON.stringify({ before, after: Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === null ? null : digest(Buffer.from(v, 'base64'))])) }));
    await rm(path.join(stateDir, 'journal.json'));
}
function validImage(image) {
    if (!image || typeof image !== 'object' || Array.isArray(image) || Object.entries(image).some(([k, v]) => (!ASSETS.includes(k) && k !== 'stack-manifest.json') || (v !== null && (typeof v !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)))))
        fail();
    return image;
}
async function recover(dir, stateDir) {
    const journal = path.join(stateDir, 'journal.json');
    if (!await exists(journal))
        return;
    const before = validImage(JSON.parse((await regular(journal)).toString()));
    for (const [name, value] of Object.entries(before)) {
        if (value === null)
            await rm(path.join(dir, name), { force: true });
        else
            await atomic(path.join(dir, name), Buffer.from(value, 'base64'), 0o644);
    }
    await rm(journal);
}
export async function runMonitoringMaintenance(action, directory, packageRoot, options = {}) {
    prerequisite();
    const dir = path.resolve(directory);
    const stateDir = path.join(dir, '.maintenance');
    let lock;
    try {
        await safeDirectory(dir);
        await mkdir(stateDir, { mode: 0o700 });
    }
    catch (e) {
        if (e.code !== 'EEXIST')
            fail();
    }
    try {
        if (!['upgrade', 'rollback', 'backup', 'restore'].includes(action) || (options.backup && !['backup', 'restore'].includes(action)) || (options.baseline && action !== 'upgrade'))
            fail();
        await safeDirectory(stateDir, true);
        // SQLite's OS-owned writer lock releases on process exit, including SIGKILL.
        const lockPath = path.join(stateDir, 'lock.sqlite');
        const lockStat = await exists(lockPath);
        if (lockStat && (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.mode & 0o077 || (process.geteuid && lockStat.uid !== process.geteuid())))
            fail();
        const { DatabaseSync } = await import('node:sqlite');
        lock = new DatabaseSync(lockPath);
        await chmod(lockPath, 0o600);
        lock.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS maintenance_lock (id INTEGER PRIMARY KEY);');
        if (action !== 'restore')
            stopped(dir);
        await recover(dir, stateDir);
        if (action === 'backup' || action === 'restore')
            return await storageMaintenance(action, dir, packageRoot, options.backup);
        const excluded = new Set(['.maintenance', 'backups', 'data']);
        const inputs = await hashes(dir, '', excluded);
        const inputMetadata = await metadata(dir, excluded);
        await validateEnvironment(dir, packageRoot);
        const overrides = [];
        const next = {};
        if (action === 'rollback') {
            const previous = JSON.parse((await regular(path.join(stateDir, 'previous.json'))).toString());
            validImage(previous.before);
            if (!previous.after || Object.keys(previous.after).length !== Object.keys(previous.before).length || Object.keys(previous.before).some(k => !(k in previous.after)))
                fail();
            let alreadyRestored = true;
            for (const [name, bytes] of Object.entries(previous.before)) {
                const f = path.join(dir, name);
                if ((await exists(f) ? digest(await regular(f)) : null) !== (bytes === null ? null : digest(Buffer.from(bytes, 'base64'))))
                    alreadyRestored = false;
            }
            if (alreadyRestored)
                return { path: dir, action, changed: false, overrides };
            for (const [name, expected] of Object.entries(previous.after)) {
                if (!ASSETS.includes(name) && name !== 'stack-manifest.json')
                    fail();
                const f = path.join(dir, name);
                if ((await exists(f) ? digest(await regular(f)) : null) !== expected)
                    fail();
            }
            Object.assign(next, previous.before);
        }
        else {
            const prior = manifest(await regular(path.join(dir, 'stack-manifest.json')));
            let baseline = prior.assets;
            if (!baseline) {
                if (!options.baseline)
                    fail();
                const bdir = path.resolve(options.baseline);
                await safeDirectory(bdir);
                const b = manifest(await regular(path.join(bdir, 'stack-manifest.json')));
                if (b.packageVersion !== prior.packageVersion || b.schemaVersion !== prior.schemaVersion)
                    fail();
                baseline = {};
                for (const name of ASSETS)
                    if (await exists(path.join(bdir, name)))
                        baseline[name] = digest(await regular(path.join(bdir, name)));
            }
            const current = await sourceAssets(packageRoot);
            for (const name of ASSETS) {
                const file = path.join(dir, name);
                const bytes = await exists(file) ? await regular(file) : null;
                if (bytes && digest(bytes) !== baseline[name]) {
                    overrides.push(name);
                    continue;
                }
                const fresh = await readFile(path.join(packageRoot, 'monitoring/trace', name === '.gitignore' ? 'gitignore.template' : name));
                if (!bytes || digest(bytes) !== digest(fresh))
                    next[name] = fresh.toString('base64');
            }
            const bytes = Buffer.from(JSON.stringify(current, null, 2) + '\n');
            if (digest(await regular(path.join(dir, 'stack-manifest.json'))) !== digest(bytes))
                next['stack-manifest.json'] = bytes.toString('base64');
        }
        if (!Object.keys(next).length)
            return { path: dir, action, changed: false, overrides };
        // Validate effective Compose privately before replacing any generated asset.
        const candidate = path.join(stateDir, 'candidate');
        await rm(candidate, { recursive: true, force: true });
        await mkdir(candidate, { mode: 0o700 });
        await copyTree(dir, candidate, excluded);
        // Planning and validation must use the same configuration generation.
        if (!same(inputs, await hashes(candidate)))
            fail();
        for (const [name, bytes] of Object.entries(next)) {
            if (bytes === null)
                await rm(path.join(candidate, name), { force: true });
            else
                await atomic(path.join(candidate, name), Buffer.from(bytes, 'base64'), 0o644);
        }
        compose(candidate, ['config', '--quiet']);
        await validateComponents(candidate, packageRoot);
        // The maintenance lock excludes CLI peers, not operator edits. Refuse
        // publication if any replacement asset or effective input changed.
        if (!same(inputs, await hashes(dir, '', excluded)) || !same(inputMetadata, await metadata(dir, excluded)))
            fail();
        await apply(dir, stateDir, next, action !== 'rollback');
        await rm(candidate, { recursive: true, force: true });
        return { path: dir, action, changed: true, overrides };
    }
    catch (error) {
        if (error instanceof Error && error.message === 'Monitoring maintenance could not complete.')
            throw error;
        return fail();
    }
    finally {
        lock?.close();
    }
}
function same(a, b) {
    return JSON.stringify(Object.entries(a).sort(([x], [y]) => x.localeCompare(y))) === JSON.stringify(Object.entries(b).sort(([x], [y]) => x.localeCompare(y)));
}
async function copyTree(source, target, exclude = new Set()) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
        if (exclude.has(entry.name))
            continue;
        const from = path.join(source, entry.name), to = path.join(target, entry.name);
        if (entry.isSymbolicLink())
            fail();
        if (entry.isDirectory()) {
            await mkdir(to, { mode: 0o700 });
            await copyTree(from, to);
        }
        else if (entry.isFile())
            await writeFile(to, await regular(from), { flag: 'wx', mode: (await lstat(from)).mode & 0o777 });
        else
            fail();
    }
}
const STORAGE = { traces: ['jaeger', '/badger'], metrics: ['prometheus', '/prometheus'], grafana: ['grafana', '/var/lib/grafana'], inventory: ['gateway', '/inventory'] };
function volumes(dir) {
    const config = JSON.parse(compose(dir, ['config', '--format', 'json']));
    const names = {};
    for (const [key, [service, target]] of Object.entries(STORAGE)) {
        const mounts = config.services?.[service]?.volumes?.filter((v) => v.target === target);
        if (mounts?.length !== 1 || mounts[0].type !== 'volume' || mounts[0].source !== key)
            fail();
        const v = config.volumes?.[key];
        if (!v || v.external || v.driver_opts || (v.driver && v.driver !== 'local') || typeof v.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,200}$/.test(v.name))
            fail();
        names[key] = v.name;
    }
    if (new Set(Object.values(names)).size !== 4)
        fail();
    return names;
}
async function hashes(dir, prefix = '', exclude = new Set()) {
    const result = Object.create(null);
    for (const e of await readdir(dir, { withFileTypes: true })) {
        if (exclude.has(e.name))
            continue;
        const file = path.join(dir, e.name), name = prefix + e.name;
        if (e.isSymbolicLink())
            fail();
        if (e.isDirectory())
            Object.assign(result, await hashes(file, name + '/'));
        else if (e.isFile()) {
            const st = await lstat(file);
            if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o022)
                fail();
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(file))
                hash.update(chunk);
            result[name] = hash.digest('hex');
        }
        else
            fail();
    }
    return result;
}
function idleVolumes(dir, names) {
    for (const name of Object.values(names))
        if (docker(['ps', '--quiet', '--filter', `volume=${name}`], dir))
            fail();
}
function archive(dir, volume, backup, file, restore = false) {
    if (backup.includes(','))
        fail();
    return docker(['run', '--rm', '--network', 'none', '--label', 'com.sporades.monitoring-maintenance=true',
        '--mount', `type=volume,src=${volume},dst=/storage${restore ? '' : ',readonly'}`,
        '--mount', `type=bind,src=${backup},dst=/backup${restore ? ',readonly' : ''}`,
        'busybox:1.37.0', 'tar', restore ? '-xpf' : '-cpf', `/backup/${file}`, '-C', '/storage', ...(restore ? [] : ['.'])], dir);
}
async function checkArchive(dir, backup, file) {
    if (backup.includes(','))
        fail();
    const run = (flag) => docker(['run', '--rm', '--network', 'none', '--mount', `type=bind,src=${backup},dst=/backup,readonly`, 'busybox:1.37.0', 'tar', flag, `/backup/${file}`], dir);
    for (const name of run('-tf').split('\n')) {
        if (!name || name.startsWith('/') || name.split('/').includes('..') || /[\r\x00-\x1f]/.test(name))
            fail();
    }
    if (run('-tvf').split('\n').some(line => !/^[-d]/.test(line)))
        fail();
}
async function storageMaintenance(action, dir, packageRoot, backup) {
    if (!backup)
        fail();
    const location = path.resolve(backup);
    if (location === dir || location.startsWith(dir + path.sep) || dir.startsWith(location + path.sep))
        fail();
    await safeDirectory(path.dirname(location));
    if (action === 'backup') {
        await validateEnvironment(dir, packageRoot);
        const stack = manifest(await regular(path.join(dir, 'stack-manifest.json')));
        const names = volumes(dir);
        idleVolumes(dir, names);
        if (await exists(path.join(dir, '.private/senders/.lock')))
            fail();
        const excluded = new Set(['.maintenance', 'backups', 'data']);
        const beforeFiles = await hashes(dir, '', excluded);
        const configMetadata = await metadata(dir, excluded);
        // Never overwrite a completed or incomplete secret-bearing backup.
        if (await exists(location))
            fail();
        const stage = `${location}.partial-${randomBytes(8).toString('hex')}`;
        await mkdir(stage, { mode: 0o700 });
        try {
            await mkdir(path.join(stage, 'config'), { mode: 0o700 });
            await copyTree(dir, path.join(stage, 'config'), new Set(['.maintenance', 'backups', 'data']));
            for (const [key, name] of Object.entries(names)) {
                docker(['volume', 'inspect', name], dir);
                archive(dir, name, stage, `${key}.tar`);
                await chmod(path.join(stage, `${key}.tar`), 0o600);
            }
            const files = await hashes(stage);
            if (!same(beforeFiles, await hashes(path.join(stage, 'config'))) || !same(beforeFiles, await hashes(dir, '', excluded)) || !same(configMetadata, await metadata(dir, excluded)) || await exists(path.join(dir, '.private/senders/.lock')))
                fail();
            await atomic(path.join(stage, 'backup-manifest.json'), JSON.stringify({ schemaVersion: 1, stack, volumes: Object.keys(names), files, configMetadata }));
            await rename(stage, location);
        }
        catch {
            await rm(stage, { recursive: true, force: true });
            fail();
        }
        return { path: dir, action, changed: true, overrides: [] };
    }
    await safeDirectory(location, true);
    const bytes = await regular(path.join(location, 'backup-manifest.json'));
    const snapshot = JSON.parse(bytes.toString());
    if (snapshot.schemaVersion !== 1 || !snapshot.files || typeof snapshot.files !== 'object' || Array.isArray(snapshot.files) || JSON.stringify(snapshot.volumes) !== JSON.stringify(Object.keys(STORAGE)))
        fail();
    manifest(Buffer.from(JSON.stringify(snapshot.stack)));
    const actual = await hashes(location);
    delete actual['backup-manifest.json'];
    if (Object.keys(actual).some(k => !k.startsWith('config/') && !Object.keys(STORAGE).some(n => k === `${n}.tar`)) || Object.keys(actual).some(k => /^config\/(?:\.maintenance|backups|data)(?:\/|$)/.test(k)))
        fail();
    if (Object.keys(actual).length !== Object.keys(snapshot.files).length || Object.entries(actual).some(([k, v]) => snapshot.files[k] !== v))
        fail();
    for (const name of Object.keys(STORAGE)) {
        if (!actual[`${name}.tar`])
            fail();
        await checkArchive(dir, location, `${name}.tar`);
    }
    await validateEnvironment(path.join(location, 'config'), packageRoot);
    const journal = path.join(dir, '.maintenance/restore.json');
    const id = digest(bytes);
    const prior = await exists(journal) ? JSON.parse((await regular(journal)).toString()) : null;
    if (prior && prior.id !== id)
        fail();
    if (!prior && (await readdir(dir)).some(n => n !== '.maintenance'))
        fail();
    if (!prior)
        await atomic(journal, JSON.stringify({ id, complete: false }));
    // Interrupted configuration copy is retried only for this exact snapshot.
    async function install(from, to) {
        for (const e of await readdir(from, { withFileTypes: true })) {
            const src = path.join(from, e.name), dst = path.join(to, e.name);
            if (e.isDirectory()) {
                if (!await exists(dst))
                    await mkdir(dst, { mode: 0o700 });
                const st = await lstat(dst);
                if (!st.isDirectory() || st.isSymbolicLink() || st.mode & 0o022)
                    fail();
                await install(src, dst);
            }
            else {
                const b = await regular(src);
                if (await exists(dst)) {
                    if (digest(await regular(dst)) !== digest(b))
                        fail();
                }
                else
                    await atomic(dst, b, snapshot.configMetadata?.[path.relative(path.join(location, 'config'), src)]?.mode ?? 0o600);
            }
        }
    }
    await install(path.join(location, 'config'), dir);
    await restoreMetadata(dir, snapshot.configMetadata);
    stopped(dir);
    const names = volumes(dir);
    idleVolumes(dir, names);
    if (prior?.names && JSON.stringify(prior.names) !== JSON.stringify(names))
        fail();
    const existing = docker(['volume', 'ls', '--format', '{{.Name}}'], dir).split('\n');
    for (const name of Object.values(names)) {
        if (existing.includes(name)) {
            const meta = JSON.parse(docker(['volume', 'inspect', name], dir))[0];
            if (meta?.Labels?.['com.sporades.restore'] !== id)
                fail();
        }
    }
    if (prior?.complete)
        return { path: dir, action, changed: false, overrides: [] };
    await atomic(journal, JSON.stringify({ id, names, complete: false }));
    for (const [key, name] of Object.entries(names)) {
        // Only freshly created, exact-snapshot-owned volumes may be populated.
        if (!existing.includes(name))
            docker(['volume', 'create', '--label', `com.sporades.restore=${id}`, name], dir);
        archive(dir, name, location, `${key}.tar`, true);
    }
    await atomic(journal, JSON.stringify({ id, names, complete: true }));
    return { path: dir, action, changed: true, overrides: [] };
}
async function metadata(dir, exclude = new Set(), prefix = '') {
    const values = Object.create(null);
    for (const e of await readdir(dir, { withFileTypes: true })) {
        if (exclude.has(e.name))
            continue;
        const file = path.join(dir, e.name), st = await lstat(file), name = prefix + e.name;
        if ((!st.isFile() && !st.isDirectory()) || st.isSymbolicLink() || st.mode & 0o022)
            fail();
        values[name] = { mode: st.mode & 0o777, uid: st.uid, gid: st.gid };
        if (st.isDirectory())
            Object.assign(values, await metadata(file, new Set(), name + '/'));
    }
    return values;
}
async function restoreMetadata(dir, values) {
    if (!values || typeof values !== 'object' || Array.isArray(values))
        fail();
    for (const [name, v] of Object.entries(values)) {
        if (path.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..') || !Number.isSafeInteger(v?.mode) || v.mode < 0 || v.mode > 0o777 || v.mode & 0o022 || !Number.isSafeInteger(v.uid) || v.uid < 0 || v.uid > 0xffffffff || !Number.isSafeInteger(v.gid) || v.gid < 0 || v.gid > 0xffffffff)
            fail();
        const file = path.join(dir, name), st = await lstat(file);
        if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()))
            fail();
    }
    for (const [name, v] of Object.entries(values).sort(([a], [b]) => b.length - a.length)) {
        const file = path.join(dir, name);
        const st = await lstat(file);
        if (st.uid !== v.uid || st.gid !== v.gid)
            await chown(file, v.uid, v.gid);
        await chmod(file, v.mode);
    }
}
async function validateComponents(dir, packageRoot) {
    const config = JSON.parse(compose(dir, ['config', '--format', 'json']) || '{}');
    // Effective operator overrides are validated using the same supported product family.
    const expected = { collector: /^otel\/opentelemetry-collector-contrib:[\w.-]+$/, jaeger: /^cr\.jaegertracing\.io\/jaegertracing\/jaeger:[\w.-]+$/, prometheus: /^prom\/prometheus:[\w.-]+$/ };
    for (const [name, pattern] of Object.entries(expected)) {
        if (!pattern.test(config.services?.[name]?.image ?? ''))
            fail();
    }
    const mount = (name, target) => ['--mount', `type=bind,src=${path.join(dir, name)},dst=${target},readonly`];
    if (dir.includes(','))
        fail();
    const base = ['run', '--rm', '--network', 'none', '--user', '0', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec'];
    const collectorMount = config.services.collector.volumes?.find((v) => v.target === '/etc/otelcol/config.yaml');
    if (collectorMount?.type !== 'bind' || !['collector.yaml', 'collector-persistent.yaml'].includes(path.basename(collectorMount.source)) || path.dirname(collectorMount.source) !== dir)
        fail();
    docker([...base, ...mount(path.basename(collectorMount.source), '/etc/otelcol/config.yaml'), config.services.collector.image, 'validate', '--config=/etc/otelcol/config.yaml'], dir);
    const setup = await import(pathToFileURL(path.join(packageRoot, 'monitoring/trace/setup.mjs')).href);
    const env = setup.parseEnvironment((await regular(path.join(dir, '.compose.env'))).toString());
    docker([...base, '--env', `TRACE_RETENTION=${env.get('TRACE_RETENTION') ?? '72h'}`, ...mount('jaeger.yaml', '/etc/jaeger/config.yaml'), config.services.jaeger.image, 'validate', '--config=/etc/jaeger/config.yaml'], dir);
    docker([...base, ...mount('prometheus.yaml', '/etc/prometheus/prometheus.yml'), ...mount('pipeline-rules.yaml', '/etc/prometheus/pipeline-rules.yaml'), '--entrypoint', '/bin/promtool', config.services.prometheus.image, 'check', 'config', '/etc/prometheus/prometheus.yml'], dir);
    for (const name of ASSETS.filter(n => n.endsWith('.json')))
        JSON.parse((await regular(path.join(dir, name))).toString());
    for (const name of ASSETS.filter(n => n.endsWith('.mjs'))) {
        const result = spawnSync(process.execPath, ['--check', path.join(dir, name)], { encoding: 'utf8', timeout: 10_000 });
        if (result.status !== 0)
            fail();
    }
}
//# sourceMappingURL=monitoring-maintenance.js.map