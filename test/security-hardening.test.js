import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import * as http from '../dist/http-runtime.js';
import { validateSecurityConfig, resolveEffectiveSecurityPolicy } from '../dist/cli/project-config.js';

test('serialized enforced nonce CSP retains a stricter endpoint policy as an independent policy', async () => {
  const database = { securityPolicy: http.resolveRuntimeSecurityPolicy({ security: { csp: { mode: 'enforce', nonce: true } } }) };
  const server = createServer((request, response) => {
    http.prepareHttpSecurity(database, request, response);
    response.writeHead(500, { 'content-security-policy': "default-src 'none'" });
    response.end('opaque failure');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.ok(response.headers.get('content-security-policy').split(/,\s*/).includes("default-src 'none'"));
    assert.match(response.headers.get('content-security-policy'), /nonce-/);
    await response.text();
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('endpoint CSP composes across casing, setHeader and report-only mode without weakening the platform', async () => {
  for (const mode of ['enforce', 'report-only']) {
    const database = { securityPolicy: http.resolveRuntimeSecurityPolicy({ security: { csp: { mode, nonce: true } } }) };
    const server = createServer((request, response) => {
      http.prepareHttpSecurity(database, request, response);
      if (request.url === '/stored') response.setHeader('Content-Security-Policy', "default-src 'none'");
      response.writeHead(500, request.url === '/stored' ? {} : { 'Content-Security-Policy': request.url === '/permissive' ? 'default-src *' : "default-src 'none'" });
      response.end('opaque failure');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const pathname of ['/stored', '/restrictive', '/permissive']) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
        const endpointPolicy = pathname === '/permissive' ? 'default-src *' : "default-src 'none'";
        const enforced = response.headers.get('content-security-policy').split(/,\s*/);
        assert.ok(enforced.includes(endpointPolicy));
        const baseline = response.headers.get(mode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only');
        assert.match(baseline, /object-src 'none'/);
        assert.match(baseline, /nonce-/);
        assert.equal(mode === 'enforce' ? enforced.length : enforced.length + 1, 2);
        await response.text();
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

async function serve(config, fn) {
  const database = { securityPolicy: http.resolveRuntimeSecurityPolicy(config) };
  const server = createServer((request, response) => {
    http.prepareHttpSecurity(database, request, response);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(http.renderPageHtml('<head><script nonce="%SPORADES_NONCE%" src="/client.js"></script></head>', response, 'test-token'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`, database.securityPolicy); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('nonce mode binds each response policy, runtime script and authored scripts to one fresh nonce', async () => {
  await serve({ security: { csp: { mode: 'enforce', nonce: true, directives: { 'script-src': ["'self'"] } } } }, async url => {
    const nonces = await Promise.all(Array.from({ length: 8 }, async () => {
      const response = await fetch(url);
      const policy = response.headers.get('content-security-policy');
      const nonce = policy.match(/'nonce-([^']+)'/)[1];
      assert.equal(Buffer.from(nonce, 'base64').length, 32);
      assert.match(policy, /'strict-dynamic'/);
      const html = await response.text();
      assert.ok(html.includes(`<script nonce="${nonce}">window.__SPORADES_CONNECTION_TOKEN="test-token";`));
      assert.ok(html.includes(`<script nonce="${nonce}" src="/client.js">`));
      assert.ok(!html.includes('%SPORADES_NONCE%'));
      return nonce;
    }));
    assert.equal(new Set(nonces).size, nonces.length);
  });
});

test('HSTS is opt-in and emitted only by a Hosted Capsule, regardless of forwarding headers', async () => {
  for (const session of ['dev', 'public-dev', 'container', 'hosted']) {
    await serve({ __sporadesSession: session, security: { hsts: { maxAgeSeconds: 31536000, includeSubDomains: true, preload: true } } }, async url => {
      const response = await fetch(url, { headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(response.headers.get('strict-transport-security'), session === 'hosted' ? 'max-age=31536000; includeSubDomains; preload' : null);
      await response.text();
    });
  }
  await serve({ __sporadesSession: 'hosted' }, async url => {
    const response = await fetch(url);
    assert.equal(response.headers.get('strict-transport-security'), null);
    await response.text();
  });
});

test('explicit CSP reports use report-uri in report-only and enforced responses', async () => {
  for (const mode of ['report-only', 'enforce']) {
    for (const reportTo of ['/csp-reports', 'https://reports.example.test/csp']) {
      const config = { security: { csp: { mode, reportTo } } };
      validateSecurityConfig(config.security);
      assert.deepEqual(resolveEffectiveSecurityPolicy(config, 'container').csp.directives['report-uri'], [reportTo]);
      await serve(config, async url => {
        const response = await fetch(url);
        const policy = response.headers.get(mode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only');
        assert.ok(policy.includes(`report-uri ${reportTo}`));
        await response.text();
      });
    }
  }
});

test('new security options reject malformed input at CLI validation and runtime startup', () => {
  const invalid = [
    { csp: { nonce: 'true' } }, { csp: { nonce: null } },
    ...[true, '', '//evil.test/csp', '/\\evil.test', '/csp; script-src *', '/csp\u0000', '/csp\u0100', '/csp\r\nx-secret: value', 'javascript:alert(1)', 'https://user:secret@example.test/csp', 'https://example.test/csp#fragment'].map(reportTo => ({ csp: { reportTo } })),
    ...[true, null, [], {}, { maxAgeSeconds: -1 }, { maxAgeSeconds: '100' }, { maxAgeSeconds: 1.5 }, { maxAgeSeconds: Number.MAX_SAFE_INTEGER + 1 }, { maxAgeSeconds: 1, preload: 'true' }, { maxAgeSeconds: 1, includeSubDomains: null }].map(hsts => ({ hsts })),
    { csp: { nonce: true, directives: { 'script-src': {} } } },
  ];
  for (const security of invalid) {
    for (const validate of [() => validateSecurityConfig(security), () => http.resolveRuntimeSecurityPolicy({ security })]) {
      assert.throws(validate, error => error.code === 'INVALID_SECURITY_CONFIG', JSON.stringify(security));
    }
  }
});

test('nonce-disabled Capsules retain legacy HTML, default CSP and inspection shape', async () => {
  const bytes = Buffer.from([0xff, 0xfe, 0x00]);
  assert.strictEqual(http.renderPageHtml(bytes, {}), bytes, 'untouched HTML retains its original bytes');
  for (const nonce of [undefined, false]) {
    const config = { security: { csp: { nonce } } };
    const policy = resolveEffectiveSecurityPolicy(config, 'container');
    assert.equal(Object.hasOwn(policy.csp, 'nonce'), false);
    assert.equal(Object.hasOwn(policy, 'hsts'), false);
    assert.deepEqual(policy.csp.directives['script-src'], ["'self'", "'unsafe-inline'"]);
    await serve(config, async url => {
      const response = await fetch(url);
      const header = response.headers.get('content-security-policy-report-only');
      assert.match(header, /script-src 'self' 'unsafe-inline';/);
      assert.doesNotMatch(header, /nonce-|strict-dynamic|report-uri/);
      const body = await response.text();
      assert.ok(body.includes('<script>window.__SPORADES_CONNECTION_TOKEN="test-token";</script>'));
      assert.ok(body.includes('nonce="%SPORADES_NONCE%"'));
    });
  }
});

test('nonce augments an explicit script-src-elem override without mutating shared policy', async () => {
  const config = { security: { csp: { nonce: true, directives: { 'script-src': "'self'", 'script-src-elem': ["'none'"] } } } };
  await serve(config, async (url, policy) => {
    const before = JSON.stringify(policy);
    const response = await fetch(url);
    const header = response.headers.get('content-security-policy-report-only');
    const nonce = header.match(/'nonce-([^']+)'/)[1];
    assert.ok(header.includes(`script-src-elem 'nonce-${nonce}' 'strict-dynamic'`));
    await response.text();
    assert.equal(JSON.stringify(policy), before);
  });
});

test('CLI inspection and runtime agree on opt-in policy without retaining response nonces', () => {
  const security = { hsts: { maxAgeSeconds: 0 }, csp: { nonce: true, reportTo: '/csp-reports' } };
  for (const session of ['dev', 'public-dev', 'container', 'hosted']) {
    const runtime = http.resolveRuntimeSecurityPolicy({ security, __sporadesSession: session });
    const inspected = resolveEffectiveSecurityPolicy({ security }, session);
    assert.deepEqual(inspected.csp, runtime.csp);
    assert.equal(inspected.hsts, runtime.hsts);
    assert.equal(runtime.hsts, session === 'hosted' ? 'max-age=0' : undefined);
    assert.doesNotMatch(JSON.stringify(runtime.csp), /nonce-|strict-dynamic/);
  }
});
