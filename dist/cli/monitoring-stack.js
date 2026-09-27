import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandError } from './cli-support.js';
const STACK_SCHEMA = 1;
const ASSETS = ['.dockerignore', '.env.example', '.gitignore', 'Dockerfile.gateway', 'README.md', 'collector.yaml', 'compose.yaml', 'gateway.mjs', 'jaeger.yaml', 'prometheus.yaml', 'grafana-datasource.yaml', 'grafana-dashboard-provider.yaml', 'api-dashboard.json', 'setup.mjs', 'smoke.mjs'];
function prerequisite() {
    if (!['arm64', 'x64'].includes(process.arch) || !['linux', 'darwin'].includes(process.platform)) {
        throw commandError('Unsupported monitoring stack architecture.', 'Use Linux amd64 or arm64; macOS with Docker Desktop is supported for local testing.');
    }
    const compose = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
    if (compose.error || compose.status !== 0) {
        throw commandError('Docker Compose is unavailable.', 'Install Docker Engine 29.x and Docker Compose 2.40.3 or later, then run this command again.');
    }
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(compose.stdout.trim());
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 40 || (Number(match[2]) === 40 && Number(match[3]) < 3)))) {
        throw commandError('Unsupported Docker Compose version.', 'Install Docker Compose 2.40.3 or later.');
    }
    const engine = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
    if (engine.error || engine.status !== 0) {
        throw commandError('Docker Engine is unavailable.', 'Start Docker Engine 29.x and check that the selected Docker context is reachable.');
    }
    const engineVersion = /^v?(\d+)\.(\d+)\.(\d+)/.exec(engine.stdout.trim());
    if (!engineVersion || Number(engineVersion[1]) !== 29) {
        throw commandError('Unsupported Docker Engine version.', 'Use Docker Engine 29.x on the selected Docker context.');
    }
}
async function existingFile(filename) {
    try {
        return await lstat(filename);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
export async function runMonitoringStack(action, directory, packageRoot) {
    prerequisite();
    const source = path.join(packageRoot, 'monitoring', 'trace');
    const target = path.resolve(directory);
    const packageInfo = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const version = packageInfo.version;
    const manifestPath = path.join(target, 'stack-manifest.json');
    if (action === 'init')
        await mkdir(target, { recursive: true });
    else if (!(await existingFile(target)))
        throw commandError('Monitoring stack directory does not exist.', 'Run `sporades monitoring stack init --dir <path>` first.');
    const preexistingContent = (await readdir(target)).length > 0;
    const manifestStat = await existingFile(manifestPath);
    let prior = null;
    if (manifestStat) {
        try {
            prior = JSON.parse(await readFile(manifestPath, 'utf8'));
        }
        catch {
            throw commandError('Invalid monitoring stack manifest.', 'Back up the directory and inspect stack-manifest.json before continuing.');
        }
    }
    const versionDifference = !prior && preexistingContent
        ? { installed: 'unknown', available: version, schema: null }
        : prior && (prior.schemaVersion !== STACK_SCHEMA || prior.packageVersion !== version)
            ? { installed: prior.packageVersion ?? 'unknown', available: version, schema: prior.schemaVersion ?? null } : null;
    const created = [];
    const overrides = [];
    const missingAssets = [];
    for (const name of ASSETS) {
        const sourcePath = path.join(source, name === '.gitignore' ? 'gitignore.template' : name);
        const destination = path.join(target, name);
        const sourceBytes = await readFile(sourcePath);
        const current = await existingFile(destination);
        if (!current && action === 'init') {
            await cp(sourcePath, destination, { errorOnExist: true, force: false });
            created.push(name);
        }
        else if (!current)
            missingAssets.push(name);
        else {
            if (!current.isFile())
                throw commandError(`Monitoring stack asset is not a regular file: ${name}`, 'Inspect the stack directory and remove unsafe links before continuing.');
            const destinationBytes = await readFile(destination);
            if (createHash('sha256').update(sourceBytes).digest('hex') !== createHash('sha256').update(destinationBytes).digest('hex'))
                overrides.push(name);
        }
    }
    if (action === 'init' && !manifestStat && !preexistingContent) {
        await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: STACK_SCHEMA, packageVersion: version }, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
        created.push('stack-manifest.json');
    }
    let missing = [];
    if (action === 'init') {
        const setup = await import(pathToFileURL(path.join(source, 'setup.mjs')).href);
        missing = (await setup.setupEnvironment(path.join(target, '.env'))).missing;
    }
    else {
        const setup = await import(pathToFileURL(path.join(source, 'setup.mjs')).href);
        const env = await existingFile(path.join(target, '.env'));
        if (!env)
            missing = ['.env'];
        else
            missing = setup.inspectEnvironment(await readFile(path.join(target, '.env'), 'utf8')).missing;
    }
    return {
        path: target, schemaVersion: STACK_SCHEMA, packageVersion: version, created, overrides, missingAssets, versionDifference, missing,
        nextSteps: ['Review .env and fill missing settings', 'Run `node setup.mjs` after editing .env', 'Run `docker compose --env-file .compose.env up -d --build` from the stack directory', 'Run `node smoke.mjs send` to verify stored traces and metrics', 'Open /grafana/d/sporades-api through the protected gateway'],
    };
}
//# sourceMappingURL=monitoring-stack.js.map