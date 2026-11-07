import { randomUUID } from 'node:crypto';
import type { AcceptanceContext, AcceptanceDriver, AcceptanceEvidence, AcceptanceEvent, AcceptancePlan, AcceptanceReport, AcceptanceSurface } from '../../src/types/observability-acceptance.js';

const surfaces: AcceptanceSurface[] = ['server-error', 'browser-error', 'browser-rejection', 'analytics-pageview', 'notification-smtp', 'notification-inbox'];
const token = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const invalid = (): never => { throw new Error('Invalid observability acceptance plan or explicit target/release authorization.'); };

export function validateAcceptancePlan(input: unknown, authorization: { authorizeTarget: string; release: string }): AcceptancePlan {
  if (!object(input) || input.version !== 1 || !object(input.target) || !object(input.surfaces)) invalid();
  const plan = input as unknown as AcceptancePlan;
  const target = plan.target;
  if (!keys(plan, ['version', 'target', 'surfaces', 'analytics', 'notifications']) || !keys(target, ['origin', 'capsule', 'release', 'environment'])) invalid();
  if (!token(target.capsule) || !token(target.release) || (target.environment !== undefined && !token(target.environment)) || typeof target.origin !== 'string') invalid();
  let url: URL;
  try { url = new URL(target.origin); } catch { return invalid(); }
  if (url.origin !== target.origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) invalid();
  if (authorization.authorizeTarget !== target.origin || authorization.release !== target.release) invalid();
  if (plan.analytics !== undefined && typeof plan.analytics !== 'boolean' || plan.notifications !== undefined && typeof plan.notifications !== 'boolean') invalid();
  for (const [surface, config] of Object.entries(plan.surfaces)) {
    if (!surfaces.includes(surface as AcceptanceSurface) || !object(config) || !token(config.provider) || !token(config.project) || !['enabled', 'disabled', 'missing'].includes(config.state)) invalid();
    if (!keys(config, ['provider', 'project', 'state', 'diagnostic'])) invalid();
    if (config.diagnostic !== undefined && (!object(config.diagnostic) || !keys(config.diagnostic, ['path', 'approval']) || !token(config.diagnostic.approval) || typeof config.diagnostic.path !== 'string' || !/^\/(?!\/)[a-zA-Z0-9/_.,~-]{0,255}$/.test(config.diagnostic.path))) invalid();
  }
  return structuredClone(plan);
}

class Deadline extends Error {}
async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, milliseconds: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let onAbort = () => {};
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error();
      return action(controller.signal);
    }), new Promise<never>((_, reject) => {
      onAbort = () => { controller.abort(); reject(new Error()); };
      if (parent?.aborted) { onAbort(); return; }
      parent?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new Deadline()); }, milliseconds);
    })]);
  } finally { clearTimeout(timer!); parent?.removeEventListener('abort', onAbort); controller.abort(); }
}

function eventFailure(event: AcceptanceEvent, context: AcceptanceContext, canaries: string[], end: number): string | null {
  if (!object(event) || !token(event.handle) || !Object.hasOwn(event, 'payload')) return 'invalid-provider-evidence';
  if (event.project !== context.project) return 'wrong-project';
  if (event.marker !== context.marker) return 'missing-or-wrong-marker';
  const time = Date.parse(event.timestamp);
  if (!Number.isFinite(time) || time < Date.parse(context.startedAt) || time > end) return 'stale-or-invalid-timestamp';
  if (event.capsule !== context.target.capsule || event.release !== context.target.release || event.environment !== context.target.environment || event.surface !== context.surface) return 'wrong-runtime-tags';
  if (context.surface.startsWith('notification-') && event.relatedEventHandle !== context.serverEventHandle) return 'wrong-notification-event';
  if (context.surface.startsWith('notification-') && event.handle === context.serverEventHandle) return 'invalid-notification-receipt';
  const payload = JSON.stringify(event.payload);
  if (!payload?.includes(context.marker)) return 'invalid-provider-evidence';
  if (canaries.some(value => payload.includes(value) || payload.includes(JSON.stringify(value).slice(1, -1)))) return 'redaction-failed';
  return null;
}

/** Explicit operator workflow; ordinary deploy verification never calls this. Drivers are trusted executable operator code. */
export async function acceptObservability(input: unknown, driver: AcceptanceDriver, options: {
  authorizeTarget: string; release: string; timeoutMs?: number; pollMs?: number; signal?: AbortSignal;
}): Promise<AcceptanceReport> {
  const plan = validateAcceptancePlan(input, options);
  const timeout = options.timeoutMs ?? 30000;
  const poll = options.pollMs ?? 1000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 90000 || !Number.isInteger(poll) || poll < 1 || poll > 5000) invalid();
  const marker = `acceptance-${randomUUID().replaceAll('-', '')}`;
  const startedAt = new Date().toISOString();
  const evidence = {} as Record<AcceptanceSurface, AcceptanceEvidence>;
  const report: AcceptanceReport = { version: 1, status: 'blocked', target: plan.target, marker, startedAt, finishedAt: startedAt, surfaces: evidence, cleanup: 'pass' };
  let serverCanaries: string[] = [];
  try {
    for (const surface of surfaces) {
      const notification = surface.startsWith('notification-');
      const config = plan.surfaces[surface];
      const entry: AcceptanceEvidence = { status: 'blocked', reason: 'provider-missing', marker: `${marker}-${notification ? 'server-error' : surface}` };
      evidence[surface] = entry;
      if (options.signal?.aborted) { entry.status = 'fail'; entry.reason = 'interrupted'; continue; }
      if (surface === 'analytics-pageview' && plan.analytics !== true || notification && plan.notifications !== true) {
        entry.status = 'skipped'; entry.reason = 'not-requested'; continue;
      }
      if (!config) continue;
      entry.provider = config.provider; entry.project = config.project;
      if (config.state !== 'enabled') { entry.reason = `provider-${config.state}`; continue; }
      if (!notification && !config.diagnostic) { entry.reason = 'no-approved-diagnostic'; continue; }
      if (notification && evidence['server-error'].status !== 'pass') { entry.reason = 'server-event-unverified'; continue; }
      if (notification && (config.project !== evidence['server-error'].project || config.provider !== evidence['server-error'].provider)) { entry.reason = 'notification-project-mismatch'; continue; }
      entry.diagnostic = config.diagnostic;
      let phase = 'probe';
      try {
        await bounded(async signal => {
          const context: AcceptanceContext = Object.freeze({ target: Object.freeze({ ...plan.target }), surface, marker: entry.marker,
            project: config.project, diagnostic: config.diagnostic ? Object.freeze({ ...config.diagnostic }) : undefined,
            startedAt, signal, serverEventHandle: notification ? evidence['server-error'].handle : undefined });
          let canaries = serverCanaries;
          if (!notification) {
            const receipt = await driver.probe(context);
            if (signal.aborted) throw new Deadline();
            if (receipt?.capture !== 'app-runtime' || !receipt.target || Object.entries(plan.target).some(([key, value]) => receipt.target[key as keyof typeof receipt.target] !== value)) {
              entry.status = 'fail'; entry.reason = 'runtime-probe-unverified'; return;
            }
            canaries = receipt.redactionCanaries;
            if (!Array.isArray(canaries) || canaries.length === 0 || canaries.length > 32 || canaries.some(value => typeof value !== 'string' || value.length < 8 || value.length > 512)) {
              entry.status = 'blocked'; entry.reason = 'redaction-not-exercised'; return;
            }
            canaries = [...canaries];
            if (surface === 'server-error') serverCanaries = canaries;
          }
          phase = 'read-back';
          while (!signal.aborted) {
            const event = await driver.readBack(context);
            if (signal.aborted) throw new Deadline();
            if (event !== null) {
              const failure = eventFailure(event, context, canaries, Date.now());
              entry.status = failure ? 'fail' : 'pass'; entry.reason = failure ?? 'stored-event-verified';
              if (!failure) { entry.handle = event.handle; entry.timestamp = new Date(Date.parse(event.timestamp)).toISOString(); }
              return;
            }
            await new Promise<void>(resolve => {
              const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
              const timer = setTimeout(done, poll);
              signal.addEventListener('abort', done, { once: true });
            });
          }
          throw new Deadline();
        }, timeout, options.signal);
      } catch (error) {
        entry.status = options.signal?.aborted || error instanceof Deadline || phase === 'probe' ? 'fail' : 'blocked';
        entry.reason = options.signal?.aborted ? 'interrupted' : error instanceof Deadline ? 'timeout' : phase === 'probe' ? 'probe-failed' : 'provider-unavailable';
      }
    }
  } finally {
    try { await bounded(signal => driver.cleanup(signal), 5000); }
    catch { report.cleanup = 'fail'; }
  }
  report.finishedAt = new Date().toISOString();
  report.status = options.signal?.aborted || report.cleanup === 'fail' || Object.values(evidence).some(entry => entry.status === 'fail') ? 'fail'
    : Object.values(evidence).some(entry => entry.status === 'blocked') ? 'blocked' : 'pass';
  return report;
}
