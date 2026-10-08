import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import http from 'node:http';

// Loaded only in the verifier process: alter fixture OTLP delivery, leaving the
// installed CLI, SDK exporter, generated Capsule and credentials untouched.
const originalCreateServer = http.createServer;
const droppedCounterPath = process.env.SPORADES_OTLP_DROPPED_COUNTER;
const droppedTraceId = process.env.SPORADES_OTLP_DROP_TRACE_ID ?? '33333333333333333333333333333333';
const fault = process.env.SPORADES_OTLP_FAULT ?? 'drop-failure';
const isWork = span => ['1'.repeat(32), '2'.repeat(32)].includes(span.traceId);

function filterSpans(body, predicate) {
  let removed = 0;
  for (const resource of body.resourceSpans ?? []) for (const scope of resource.scopeSpans ?? []) {
    scope.spans = (scope.spans ?? []).filter(span => { if (predicate(span)) return true; removed++; return false; });
  }
  return removed;
}

function filterMetrics(body, predicate) {
  let removed = 0;
  for (const resource of body.resourceMetrics ?? []) for (const scope of resource.scopeMetrics ?? []) {
    scope.metrics = (scope.metrics ?? []).filter(metric => { if (predicate(metric)) return true; removed++; return false; });
  }
  return removed;
}

function deliverLater(listener, receiver, request, body) {
  setTimeout(() => {
    const silentResponse = { writeHead() { return this; }, end() {} };
    void listener.call(receiver, replayRequest(request, Buffer.from(JSON.stringify(body))), silentResponse);
  }, 7000);
}

function attribute(attributes, key) {
  return attributes?.find(entry => entry.key === key)?.value?.stringValue;
}

function shouldDrop(span) {
  return span.traceId === droppedTraceId
    || attribute(span.attributes, 'http.route') === '/fail'
    || attribute(span.attributes, 'url.path') === '/fail'
    || span.name === 'GET /fail'
    || (typeof span.name === 'string' && span.name.endsWith(' /fail'));
}

function recordDrops(count) {
  if (!droppedCounterPath || count === 0) return;
  let previous = 0;
  if (existsSync(droppedCounterPath)) {
    try { previous = Number(readFileSync(droppedCounterPath, 'utf8')) || 0; } catch { /* start a fresh counter */ }
  }
  writeFileSync(droppedCounterPath, String(previous + count));
  appendFileSync(droppedCounterPath, '\n');
}

http.createServer = function createServer(listener, ...args) {
  if (typeof listener !== 'function') return originalCreateServer.call(this, listener, ...args);
  return originalCreateServer.call(this, function interceptFixtureReceiver(request, response) {
    if (request.socket?.localPort !== 5219 || !['/v1/traces', '/v1/metrics'].includes(request.url)) {
      return listener.call(this, request, response);
    }
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = Buffer.concat(chunks);
      let parsed;
      try { parsed = JSON.parse(input.toString('utf8')); } catch {
        const replay = replayRequest(request, input);
        return listener.call(this, replay, response);
      }
      if (fault === 'delay-work' && request.url === '/v1/traces') {
        const delayed = structuredClone(parsed);
        filterSpans(delayed, isWork);
        const deferred = filterSpans(parsed, span => !isWork(span));
        recordDrops(deferred);
        if (deferred) deliverLater(listener, this, request, delayed);
      } else if (fault === 'delay-metric' && request.url === '/v1/metrics') {
        const delayed = structuredClone(parsed);
        filterMetrics(delayed, metric => metric.name === 'process.memory.rss');
        const deferred = filterMetrics(parsed, metric => metric.name !== 'process.memory.rss');
        recordDrops(deferred);
        if (deferred) deliverLater(listener, this, request, delayed);
      } else if (fault === 'drop-failure' && request.url === '/v1/traces') {
        recordDrops(filterSpans(parsed, span => !shouldDrop(span)));
      }
      const replay = replayRequest(request, Buffer.from(JSON.stringify(parsed)));
      return listener.call(this, replay, response);
    })().catch(error => {
      response.writeHead(500);
      response.end(String(error));
    });
  }, ...args);
};

function replayRequest(original, bytes) {
  const replay = Readable.from([bytes]);
  for (const key of ['url', 'method', 'httpVersion', 'httpVersionMajor', 'httpVersionMinor', 'socket', 'connection', 'rawHeaders', 'trailers', 'rawTrailers']) {
    replay[key] = original[key];
  }
  replay.headers = { ...original.headers, 'content-length': String(bytes.length) };
  delete replay.headers['transfer-encoding'];
  return replay;
}

syncBuiltinESMExports();
