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
  do {
    const response = await deadlineFetch(`${config.jaegerUrl}/api/traces/${traceId}`);
    if (response.ok && (await response.json()).data?.length) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < end);
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
  const handler = async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      try { const ready = await pathReady(config); json(res, ready ? 200 : 503, ready); }
      catch { json(res, 503, false); }
      return;
    }
    if (req.url === '/v1/traces') {
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
        const response = await deadlineFetch(`${config.collectorUrl}/v1/traces`, { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? 'application/x-protobuf' }, body: Buffer.concat(chunks) });
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
    proxyUi(req, res, config.jaegerUrl);
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
  }, tls);
  gateway.listen(8443, '0.0.0.0');
}
