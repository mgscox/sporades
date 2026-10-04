import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { createAvailabilityServer } from './availability.mjs';
import { senderAuthorization } from './sender-credentials.mjs';
import { createInventoryStore } from './inventory-store.mjs';
import { inventoryHost, INVENTORY_MAX_BYTES, validateInventory, validateInventoryCredentials } from './inventory-contract.mjs';

const same = (given, expected) => {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
};
const json = (res, status, ok) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok }));
};
const deadlineFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(1500) });
const pipelines = new WeakMap();
const INGEST_CAPACITY = 32;

// Served only on the unpublished Compose network, independently of ingestion
// and backend readiness. No credentials, Host identities or request labels.
export function createGatewayMetrics(gateway) {
  const pipeline = pipelines.get(gateway);
  if (!pipeline) throw new Error('Unknown gateway');
  return createHttpServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(`sporades_gateway_memory_rss_bytes ${process.memoryUsage().rss}\nsporades_gateway_ingest_in_flight ${pipeline.inFlight}\nsporades_gateway_ingest_capacity ${INGEST_CAPACITY}\nsporades_gateway_ingest_rejected_total ${pipeline.rejected}\nsporades_gateway_ingest_failures_total ${pipeline.failures}\n${pipeline.lastSuccess ? `sporades_gateway_ingest_last_success_seconds ${pipeline.lastSuccess}\n` : ''}`);
  });
}

async function pathReady(config) {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const time = String(BigInt(Date.now()) * 1000000n);
  const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sporades-stack-health' } }] }, scopeSpans: [{ spans: [{ traceId, spanId, name: 'readiness', startTimeUnixNano: time, endTimeUnixNano: time }] }] }] });
  const sent = await deadlineFetch(`${config.collectorUrl}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (!sent.ok) return false;
  const end = Date.now() + 2500;
  let traceReady = false;
  do {
    const response = await deadlineFetch(`${config.jaegerUrl}/api/traces/${traceId}`);
    if (response.ok && (await response.json()).data?.length) { traceReady = true; break; }
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < end);
  if (!traceReady) return false;
  if (!config.prometheusUrl) return true;
  // A fresh instant-query timestamp can describe an old sample. A unique value
  // proves that this probe's metric write reached readable storage.
  const metricValue = randomBytes(6).readUIntBE(0, 6) + 1;
  const metricTime = String(BigInt(Date.now()) * 1000000n);
  const metric = JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sporades-stack-health' } }] }, scopeMetrics: [{ metrics: [{ name: 'sporades.stack.readiness', gauge: { dataPoints: [{ timeUnixNano: metricTime, asDouble: metricValue }] } }] }] }] });
  const metricSent = await deadlineFetch(`${config.collectorUrl}/v1/metrics`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: metric });
  if (!metricSent.ok) return false;
  const metricEnd = Date.now() + 2500;
  do {
    const query = new URL('/api/v1/query', config.prometheusUrl);
    query.searchParams.set('query', 'sporades_stack_readiness');
    const stored = await deadlineFetch(query);
    if (stored.ok) {
      const data = await stored.json();
      if (data.status === 'success' && data.data?.result?.some(item => Number(item.value?.[1]) === metricValue)) return true;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < metricEnd);
  return false;
}

// Covers the entire UI exchange, including backend response bodies. The ingest
// body and Collector deadlines are separate and intentionally shorter.
const UI_REQUEST_DEADLINE_MS = 15000;

function proxyUi(req, res, target, deadlineMs = UI_REQUEST_DEADLINE_MS) {
  if (!req.url.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end(); return; }
  const url = new URL(target);
  const headers = { host: url.host };
  for (const name of ['accept', 'accept-encoding', 'content-type', 'content-length']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  let response;
  let finished = false;
  const upstream = httpRequest({ protocol: url.protocol, hostname: url.hostname, port: url.port, path: req.url, method: req.method, headers }, incoming => {
    response = incoming;
    if (finished) { incoming.destroy(); return; }
    const outgoingHeaders = { ...incoming.headers };
    // UI authentication belongs to the gateway. Backend cookies must not
    // create a second browser session outside that boundary.
    delete outgoingHeaders['set-cookie'];
    res.writeHead(incoming.statusCode, outgoingHeaders);
    incoming.on('aborted', () => fail(502));
    incoming.on('error', () => fail(502));
    incoming.pipe(res);
  });
  const stop = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    req.unpipe(upstream);
    response?.unpipe(res);
    response?.destroy();
    upstream.destroy();
    // A backend may answer before a client finishes uploading. Once the
    // response has flushed, close that client socket instead of leaving the
    // HTTP parser waiting indefinitely for the remainder of its body.
    if (!req.complete) {
      res.shouldKeepAlive = false;
      if (res.writableFinished || res.destroyed) req.destroy();
      else res.once('finish', () => req.destroy());
    }
  };
  const fail = status => {
    if (finished) return;
    stop();
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else { res.writeHead(status); res.end(); }
  };
  const deadline = setTimeout(() => fail(504), deadlineMs);
  upstream.on('error', () => fail(502));
  req.on('aborted', () => fail(502));
  req.on('error', () => fail(502));
  res.on('finish', stop);
  res.on('close', stop);
  req.pipe(upstream);
}

export function createGateway(config, tls) {
  const pipeline = { inFlight: 0, rejected: 0, failures: 0, lastSuccess: 0 };
  const inventoryCredentials = validateInventoryCredentials(config.inventoryHosts ?? {});
  const inventoryStore = config.inventoryDirectory ? createInventoryStore(config.inventoryDirectory) : null;
  const loadSenders = () => config.senderDirectory ? senderAuthorization(config.senderDirectory) : null;
  const inventoryAllowed = (req, host, senders) => {
    const legacyToken = Object.hasOwn(inventoryCredentials, host) && !senders?.legacyInventoryDisabled.includes(host) ? inventoryCredentials[host] : null;
    const tokens = [...(senders?.inventory.get(host) ?? []), ...(legacyToken ? [legacyToken] : [])];
    return inventoryHost(host) && tokens.some(token => same(req.headers.authorization, `Bearer ${token}`));
  };
  const ingestAllowed = (req, senders) => [...(senders?.ingest ?? []), ...(senders?.legacyIngest !== false ? [config.ingestToken] : [])]
    .some(token => same(req.headers.authorization, `Bearer ${token}`));
  let recentHealth;
  let healthUntil = 0;
  const handler = async (req, res) => {
    let senders;
    if (config.senderDirectory && (req.url === '/health' || req.url.startsWith('/v1/'))) {
      try { senders = await loadSenders(); }
      catch { json(res, 503, false); return; }
    }
    if (req.method === 'GET' && req.url === '/health') {
      try {
        if (!recentHealth || Date.now() >= healthUntil) {
          recentHealth = pathReady(config).catch(() => false);
          healthUntil = Date.now() + 3000;
        }
        const ready = await recentHealth && (!inventoryStore || await inventoryStore.ready());
        json(res, ready ? 200 : 503, ready);
      }
      catch { json(res, 503, false); }
      return;
    }
    // Operator read authority is independent of ingestion and inventory tokens.
    // This endpoint exposes two booleans for one diagnostic trace, never a raw
    // backend response or arbitrary query. Legacy gateways report unsupported.
    if (req.url.startsWith('/v1/diagnostics/')) {
      const auth = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : '';
      if (!config.uiUser || !config.uiPassword || !same(auth, `${config.uiUser}:${config.uiPassword}`)) { json(res, 401, false); return; }
      const match = /^\/v1\/diagnostics\/traces\/([a-f0-9]{32})$/.exec(req.url);
      if (!match) { json(res, 400, false); return; }
      if (req.method !== 'GET') { json(res, 405, false); return; }
      try {
        const response = await deadlineFetch(`${config.jaegerUrl}/api/traces/${match[1]}`);
        if (!response.ok && response.status !== 404) { json(res, 503, false); return; }
        let text = '';
        if (response.ok) {
          for await (const chunk of response.body) {
            text += Buffer.from(chunk).toString();
            if (text.length > 1024 * 1024) throw new Error('Response too large');
          }
        }
        const traces = response.ok ? JSON.parse(text).data : [];
        if (!Array.isArray(traces)) throw new Error('Invalid backend response');
        const spans = traces.filter(trace => trace.traceID === match[1]).flatMap(trace => Array.isArray(trace.spans) ? trace.spans : []);
        const probes = spans.filter(span => span.traceID === match[1] && span.operationName === 'sporades.host.relay.check');
        const now = Date.now() * 1000;
        const recent = probes.some(span => Number.isSafeInteger(span.startTime) && span.startTime <= now + 5_000_000 && span.startTime >= now - 120_000_000);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, data: { queryVisible: probes.length > 0, recent } }));
      } catch { if (!res.headersSent && !res.destroyed) json(res, 503, false); }
      return;
    }
    if (req.url.startsWith('/v1/inventory/')) {
      const host = req.url.slice('/v1/inventory/'.length);
      if (!inventoryAllowed(req, host, senders)) { json(res, 403, false); return; }
      if (!inventoryStore) { json(res, 503, false); return; }
      const respond = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: status === 200, data }));
      };
      try {
        if (req.method === 'GET') { respond(200, await inventoryStore.read(host)); return; }
        if (req.method !== 'PUT') { json(res, 405, false); return; }
        if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) { json(res, 415, false); return; }
        let size = 0;
        const chunks = [];
        const deadline = setTimeout(() => req.destroy(), 3000);
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > INVENTORY_MAX_BYTES) { json(res, 413, false); return; }
            chunks.push(chunk);
          }
        } finally { clearTimeout(deadline); }
        let inventory;
        try { inventory = validateInventory(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { json(res, 400, false); return; }
        if (inventory.host !== host) { json(res, 403, false); return; }
        if (!inventoryAllowed(req, host, await loadSenders())) { json(res, 403, false); return; }
        const result = await inventoryStore.update(inventory);
        respond(result.status, result.data);
      } catch { if (!res.headersSent && !res.destroyed) json(res, 503, false); }
      return;
    }
    if (req.url === '/v1/traces' || req.url === '/v1/metrics') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      if (!ingestAllowed(req, senders)) { res.writeHead(401); res.end(); return; }
      const encoding = req.headers['content-encoding']?.toLowerCase();
      if (encoding && encoding !== 'identity' && encoding !== 'gzip') { res.writeHead(415); res.end(); return; }
      if (pipeline.inFlight >= INGEST_CAPACITY) {
        pipeline.rejected++;
        res.writeHead(503, { connection: 'close' }).end();
        return;
      }
      pipeline.inFlight++;
      try {
        let size = 0;
        const chunks = [];
        const bodyDeadline = setTimeout(() => req.destroy(), 3000);
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) { pipeline.rejected++; res.writeHead(413, { connection: 'close' }); res.end(); return; }
            chunks.push(chunk);
          }
        } finally { clearTimeout(bodyDeadline); }
        if (!ingestAllowed(req, await loadSenders())) { res.writeHead(401); res.end(); return; }
        const headers = { 'content-type': req.headers['content-type'] ?? 'application/x-protobuf' };
        if (encoding === 'gzip') headers['content-encoding'] = encoding;
        const response = await deadlineFetch(`${config.collectorUrl}${req.url}`, { method: 'POST', headers, body: Buffer.concat(chunks) });
        if (!response.ok) { pipeline.failures++; res.writeHead(response.status >= 500 ? 503 : 400); res.end(); return; }
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await response.arrayBuffer()));
        pipeline.lastSuccess = Date.now() / 1000;
      } catch {
        pipeline.failures++;
        if (!res.destroyed && !res.headersSent) { res.writeHead(503); res.end(); }
        else res.destroy();
      } finally { pipeline.inFlight--; }
      return;
    }
    const auth = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : '';
    if (!same(auth, `${config.uiUser}:${config.uiPassword}`)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Sporades traces"' }); res.end(); return;
    }
    proxyUi(req, res, req.url.startsWith('/alertmanager/') ? config.alertmanagerUrl : req.url.startsWith('/grafana/') ? config.grafanaUrl : config.jaegerUrl, config.uiRequestDeadlineMs);
  };
  const gateway = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
  pipelines.set(gateway, pipeline);
  return gateway;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const required = ['TRACE_TLS_MODE'];
  for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
  const credentials = JSON.parse(readFileSync('/run/secrets/trace-credentials.json', 'utf8'));
  for (const key of ['ingestToken', 'uiUser', 'uiPassword']) if (!credentials[key]) throw new Error(`Missing ${key}`);
  if (process.env.TRACE_TLS_MODE === 'proxy' && !['127.0.0.1', '::1'].includes(process.env.TRACE_BIND)) {
    throw new Error('TRACE_BIND must be loopback in proxy mode');
  }
  const tls = process.env.TRACE_TLS_MODE === 'tls' ? {
    cert: readFileSync(process.env.TRACE_CERT_FILE), key: readFileSync(process.env.TRACE_KEY_FILE),
  } : undefined;
  if (!tls && process.env.TRACE_TLS_MODE !== 'proxy') throw new Error('Invalid TRACE_TLS_MODE');
  const gateway = createGateway({
    ...credentials, collectorUrl: 'http://collector:4318',
    jaegerUrl: 'http://jaeger:16686',
    prometheusUrl: 'http://prometheus:9090',
    grafanaUrl: 'http://grafana:3000',
    alertmanagerUrl: 'http://alertmanager:9093',
    inventoryDirectory: '/inventory',
    senderDirectory: '/run/senders',
  }, tls);
  gateway.listen(8443, '0.0.0.0');
  const availability = createAvailabilityServer({ storagePaths: { metrics: '/storage/metrics', traces: '/storage/traces' }, inventoryDirectory: '/inventory', blackboxDirectory: '/blackbox', blackboxReloadUrl: 'http://blackbox:9115/-/reload' }).listen(9091, '0.0.0.0');
  const metrics = createGatewayMetrics(gateway).listen(8889, '0.0.0.0');
  process.once('SIGTERM', () => {
    const deadline = setTimeout(() => { gateway.closeAllConnections(); metrics.closeAllConnections(); availability.closeAllConnections(); process.exit(0); }, 2000);
    deadline.unref();
    Promise.all([gateway, metrics, availability].map(server => new Promise(resolve => server.close(resolve)))).then(() => { clearTimeout(deadline); process.exit(0); });
  });
}
