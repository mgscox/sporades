// Stateful HTTP subset for the public proxy contract, not a full Umami emulator.
import { createServer, request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';

if (process.argv[2] === 'probe') {
  const origin = 'http://analytics.kimatt.test:18080';
  const send = (pathname, body, extra = {}) => new Promise((resolve, reject) => {
    const request = httpRequest('http://127.0.0.1:18080' + pathname, {
      method: 'POST', headers: { host: 'analytics.kimatt.test:18080', origin,
        'content-type': 'application/json', ...extra }, signal: AbortSignal.timeout(3000),
    }, response => {
      let bytes = ''; response.on('data', part => { bytes += part; });
      response.on('end', () => resolve({status:response.statusCode,ok:response.statusCode===200,json:async()=>JSON.parse(bytes)}));
      response.on('error',reject);
    });
    request.on('error',reject); request.end(JSON.stringify(body));
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    try { if ((await send('/api/auth/login', { username: 'fixture', password: 'synthetic' })).ok) break; } catch {}
    assert.ok(Date.now() < deadline, 'Caddy became ready');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const login = await send('/api/auth/login', { username: 'fixture', password: 'synthetic' });
  const { token } = await login.json();
  const headers = { authorization: `Bearer ${token}`, 'x-forwarded-host': 'attacker.invalid' };
  const first = await send('/dashboard', {}, headers);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { hostname: 'analytics.kimatt.test:18080', pageviews: 0 });
  const collected = await send('/api/send', { type: 'event', payload: { website: 'fixture-site', url: '/acceptance' } });
  assert.equal(collected.status, 200);
  assert.equal((await (await send('/dashboard', {}, headers)).json()).pageviews, 1);
  assert.equal((await send('/dashboard', {}, { ...headers, origin: 'http://attacker.invalid' })).status, 500);
  assert.equal((await send('/dashboard', {}, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await (await send('/dashboard', {}, headers)).json()).pageviews, 1);
  console.log(JSON.stringify({ authenticatedDashboard: true, publicHostnamePreserved: true,
    forwardedHostSpoofIgnored: true, pageviewStored: true, crossOriginDenied: true, invalidSessionDenied: true }));
} else {
  const sessions = new Set();
  const pageviews = [];
  createServer(async (request, response) => {
    let bytes = '';
    for await (const part of request) bytes += part;
    let body;
    try { body = JSON.parse(bytes || '{}'); } catch { response.writeHead(400).end(); return; }
    const reply = (status, value) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (request.url === '/api/auth/login') {
      if (body.username !== 'fixture' || body.password !== 'synthetic') return reply(401, {});
      sessions.add('synthetic-session');
      return reply(200, { token: 'synthetic-session' });
    }
    if (request.url === '/api/send') {
      if (body.type !== 'event' || body.payload?.website !== 'fixture-site') return reply(400, {});
      pageviews.push(body.payload.url);
      return reply(200, {});
    }
    if (request.url === '/dashboard') {
      // Match the Host/Origin check used by Next.js Server Actions before auth.
      const forwarded = request.headers['x-forwarded-host'] ?? request.headers.host;
      if (!request.headers.origin || new URL(request.headers.origin).host !== forwarded) return reply(500, { error: 'origin mismatch' });
      if (!sessions.has(request.headers.authorization?.replace(/^Bearer /, ''))) return reply(401, {});
      return reply(200, { hostname: forwarded, pageviews: pageviews.length });
    }
    reply(404, { error: 'unsupported fixture operation' });
  }).listen(4000, '127.0.0.1');
}
