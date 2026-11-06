#!/usr/bin/env node
// Explicit operator workflow. Never called by Host push or generated autodeploy.
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptObservability, validateAcceptancePlan } from '../dist/cli/observability-acceptance.js';

const controller = new AbortController();
const interrupt = () => controller.abort();
try {
  const args = process.argv.slice(2);
  const options = {};
  const allowed = ['--plan', '--driver', '--authorize-target', '--release'];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!allowed.includes(key) || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error();
    options[key] = args[index + 1];
  }
  if (allowed.some(key => !options[key])) throw new Error();
  // Never fall back to a workstation's saved Host/Telemetry profiles.
  const root = await realpath(process.cwd());
  const config = await realpath(process.env.SPORADES_CONFIG_DIR ?? '');
  const relative = path.relative(root, config);
  if (!process.env.SPORADES_CONFIG_DIR || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error();
  const bytes = await readFile(options['--plan']);
  if (bytes.length > 65536) throw new Error();
  const authorization = { authorizeTarget: options['--authorize-target'], release: options['--release'] };
  const plan = validateAcceptancePlan(JSON.parse(bytes.toString('utf8')), authorization);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  // Driver modules are reviewed executable operator code. Validate selection BEFORE import.
  const { default: driver } = await import(pathToFileURL(path.resolve(options['--driver'])).href);
  if (!driver || ['probe', 'readBack', 'cleanup'].some(name => typeof driver[name] !== 'function')) throw new Error();
  const report = await acceptObservability(plan, driver, { ...authorization, signal: controller.signal });
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = report.status === 'pass' ? 0 : 1;
} catch {
  process.stderr.write('Observability acceptance could not start. Supply a valid plan and reviewed driver, exact --authorize-target and --release, and SPORADES_CONFIG_DIR inside the working checkout. Diagnostics omitted.\n');
  process.exitCode = 2;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
