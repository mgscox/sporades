import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { timingSafeEqual, randomBytes } from 'node:crypto';

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
  const metricTime = String(BigInt(Date.now()) * 1000000n);
  const metric = JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sporades-stack-health' } }] }, scopeMetrics: [{ metrics: [{ name: 'sporades.stack.readiness', gauge: { dataPoints: [{ timeUnixNano: metricTime, asDouble: 1 }] } }] }] }] });
  const metricSent = await deadlineFetch(`${config.collectorUrl}/v1/metrics`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: metric });
  if (!metricSent.ok) return false;
  const metricEnd = Date.now() + 2500;
  do {
    const query = new URL('/api/v1/query', config.prometheusUrl);
    query.searchParams.set('query', 'sporades_stack_readiness');
    const stored = await deadlineFetch(query);
    if (stored.ok) {
      const data = await stored.json();
      if (data.status === 'success' && data.data?.result?.some(item => Number(item.value?.[1]) === 1 && Number(item.value?.[0]) * 1000 >= Date.now() - 10_000)) return true;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < metricEnd);
  return false;
}

function proxyUi(req, res, target) {
  if (!req.url.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end(); return; }
  const url = new URL(target);
  const headers = { host: url.host };
  for (const name of ['accept', 'accept-encoding', 'content-type', 'content-length']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const upstream = httpRequest({ protocol: url.protocol, hostname: url.hostname, port: url.port, path: req.url, method: req.method, headers, timeout: 3000 }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
}

export function createGateway(config, tls) {
  let recentHealth;
  let healthUntil = 0;
  const handler = async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      try {
        if (!recentHealth || Date.now() >= healthUntil) {
          recentHealth = pathReady(config).catch(() => false);
          healthUntil = Date.now() + 3000;
        }
        const ready = await recentHealth;
        json(res, ready ? 200 : 503, ready);
      }
      catch { json(res, 503, false); }
      return;
    }
    if (req.url === '/v1/traces' || req.url === '/v1/metrics') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      if (!same(req.headers.authorization, `Bearer ${config.ingestToken}`)) { res.writeHead(401); res.end(); return; }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      try {
        const response = await deadlineFetch(`${config.collectorUrl}${req.url}`, { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? 'application/x-protobuf' }, body: Buffer.concat(chunks) });
        if (!response.ok) { res.writeHead(response.status >= 500 ? 503 : 400); res.end(); return; }
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(503); res.end(); }
      return;
    }
    const auth = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : '';
    if (!same(auth, `${config.uiUser}:${config.uiPassword}`)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Sporades traces"' }); res.end(); return;
    }
    proxyUi(req, res, req.url.startsWith('/grafana/') ? config.grafanaUrl : config.jaegerUrl);
  };
  return tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
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
  }, tls);
  gateway.listen(8443, '0.0.0.0');
}
