import { createServer } from 'node:http';
import { once } from 'node:events';

// Stateful loopback emulator of the OpenAI-compatible subset ctx.ai uses: Chat Completions and
// Responses, plus model listing and stored-object retrieval/deletion so tests can observe state.
//
// Coverage: bearer keys, seeded models, request validation, deterministic word-count usage per key,
// max-token truncation, json_schema output, `store` semantics (Responses default to stored, Chat
// Completions only with `store: true`), aborted-request accounting, and scripted faults (delay,
// HTTP error, raw body, redirect, explicit text). Not covered: streaming, tools, images, audio,
// files, real tokenization, rate-limit headers, or provider-specific error bodies beyond the shape
// below. Unsupported routes return 404 `unsupported_endpoint` rather than fake success.

const words = (text) => (typeof text === 'string' && text.trim() ? text.trim().split(/\s+/).length : 0);

function sampleFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sampleFromSchema(value)]));
    case 'array': return [];
    case 'string': return '';
    case 'number': case 'integer': return 0;
    case 'boolean': return false;
    default: return null;
  }
}

export async function startOpenAiCompatibleEmulator({ keys = ['sk-emulator-test'], models = ['emulator-small'] } = {}) {
  const seed = { keys: [...keys], models: [...models] };
  let state;
  const resetState = () => {
    state = {
      keys: new Set(seed.keys), models: new Set(seed.models), faults: [], requests: [],
      stored: new Map(), usage: new Map(), aborted: 0, sequence: 0,
    };
  };
  resetState();

  const send = (res, status, body, headers = {}) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const error = (res, status, code, message = code, type = 'invalid_request_error') => send(res, status, { error: { message, type, code, param: null } });

  function meter(key, prompt, completion) {
    const entry = state.usage.get(key) ?? { calls: 0, prompt: 0, completion: 0, total: 0 };
    entry.calls++; entry.prompt += prompt; entry.completion += completion; entry.total += prompt + completion;
    state.usage.set(key, entry);
  }

  // Shared generation for both APIs. Returns null after writing a validation error.
  function generate(fault, { maxTokens, schema, promptWords }) {
    let text = fault.text ?? (schema ? JSON.stringify(fault.json ?? sampleFromSchema(schema)) : `received ${promptWords} words`);
    let truncated = false;
    if (Number.isInteger(maxTokens) && words(text) > maxTokens) {
      text = text.trim().split(/\s+/).slice(0, maxTokens).join(' ');
      truncated = true;
    }
    return { text, truncated, completionWords: Math.max(1, words(text)) };
  }

  async function chatCompletions(req, res, body, key, fault) {
    if (!Array.isArray(body.messages) || !body.messages.length) return error(res, 400, 'invalid_messages', 'messages must be a non-empty array');
    for (const message of body.messages) {
      if (!['system', 'developer', 'user', 'assistant'].includes(message?.role) || typeof message.content !== 'string') return error(res, 400, 'invalid_messages');
    }
    if (body.max_tokens !== undefined && !(Number.isInteger(body.max_tokens) && body.max_tokens > 0)) return error(res, 400, 'invalid_max_tokens');
    const format = body.response_format;
    if (format !== undefined && (format.type !== 'json_schema' || typeof format.json_schema?.name !== 'string' || typeof format.json_schema?.schema !== 'object')) {
      return error(res, 400, 'invalid_response_format');
    }
    const promptWords = body.messages.reduce((sum, message) => sum + words(message.content), 0);
    const { text, truncated, completionWords } = generate(fault, { maxTokens: body.max_tokens, schema: format?.json_schema?.schema, promptWords });
    const id = `chatcmpl-${++state.sequence}`;
    const usage = fault.omitUsage ? undefined : { prompt_tokens: promptWords, completion_tokens: completionWords, total_tokens: promptWords + completionWords };
    const completion = {
      id, object: 'chat.completion', created: 1_800_000_000 + state.sequence, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text, refusal: null }, finish_reason: truncated ? 'length' : 'stop' }],
      ...(usage ? { usage } : {}),
    };
    if (body.store === true) state.stored.set(id, completion);
    meter(key, promptWords, completionWords);
    send(res, 200, completion);
  }

  async function responses(req, res, body, key, fault) {
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
    if (!Array.isArray(input) || !input.length) return error(res, 400, 'invalid_input');
    for (const item of input) if (!['system', 'developer', 'user', 'assistant'].includes(item?.role) || typeof item.content !== 'string') return error(res, 400, 'invalid_input');
    if (body.instructions !== undefined && typeof body.instructions !== 'string') return error(res, 400, 'invalid_instructions');
    // Mirrors the provider's documented lower bound.
    if (body.max_output_tokens !== undefined && !(Number.isInteger(body.max_output_tokens) && body.max_output_tokens >= 16)) return error(res, 400, 'integer_below_min_value');
    const format = body.text?.format;
    if (format !== undefined && (format.type !== 'json_schema' || typeof format.name !== 'string' || typeof format.schema !== 'object')) return error(res, 400, 'invalid_text_format');
    const promptWords = input.reduce((sum, item) => sum + words(item.content), words(body.instructions));
    const { text, truncated, completionWords } = generate(fault, { maxTokens: body.max_output_tokens, schema: format?.schema, promptWords });
    const id = `resp_${++state.sequence}`;
    const response = {
      id, object: 'response', created_at: 1_800_000_000 + state.sequence, model: body.model,
      status: truncated ? 'incomplete' : 'completed', incomplete_details: truncated ? { reason: 'max_output_tokens' } : null,
      store: body.store !== false,
      output: [
        { type: 'reasoning', id: `rs_${state.sequence}`, summary: [] },
        { type: 'message', id: `msg_${state.sequence}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
      ],
      ...(fault.omitUsage ? {} : { usage: { input_tokens: promptWords, output_tokens: completionWords, total_tokens: promptWords + completionWords } }),
    };
    if (body.store !== false) state.stored.set(id, response);
    meter(key, promptWords, completionWords);
    send(res, 200, response);
  }

  const server = createServer(async (req, res) => {
    let finished = false;
    res.on('finish', () => { finished = true; });
    res.on('close', () => { if (!finished) state.aborted++; });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://emulator.invalid');
    const authorization = req.headers.authorization ?? '';
    const key = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    let body = null;
    if (raw) { try { body = JSON.parse(raw); } catch { body = undefined; } }
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, key, body });

    if (!key || !state.keys.has(key)) return error(res, 401, 'invalid_api_key', 'Incorrect API key provided.');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return send(res, 200, { object: 'list', data: [...state.models].map(id => ({ id, object: 'model', created: 0, owned_by: 'emulator' })) });
    }
    const stored = url.pathname.match(/^\/v1\/(?:chat\/completions|responses)\/([^/]+)$/);
    if (stored && req.method === 'GET') return state.stored.has(stored[1]) ? send(res, 200, state.stored.get(stored[1])) : error(res, 404, 'not_found');
    if (stored && req.method === 'DELETE') {
      if (!state.stored.delete(stored[1])) return error(res, 404, 'not_found');
      return send(res, 200, { id: stored[1], deleted: true });
    }
    const handler = req.method === 'POST' && url.pathname === '/v1/chat/completions' ? chatCompletions
      : req.method === 'POST' && url.pathname === '/v1/responses' ? responses : null;
    if (!handler) return error(res, 404, 'unsupported_endpoint', `${req.method} ${url.pathname} is not emulated`);
    if (body === undefined || body === null || typeof body !== 'object') return error(res, 400, 'invalid_json');
    if (!state.models.has(body.model)) return error(res, 404, 'model_not_found', `The model '${body.model}' does not exist`);

    const fault = state.faults.shift() ?? {};
    if (fault.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
    if (res.destroyed) return;
    if (fault.redirectTo) { res.writeHead(307, { location: fault.redirectTo }); return res.end(); }
    if (fault.status) return error(res, fault.status, fault.code ?? 'server_error', fault.message ?? 'Emulated upstream failure.', 'server_error');
    if (fault.rawBody !== undefined) return send(res, 200, fault.rawBody);
    return handler(req, res, body, key, fault);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    url: `${origin}/v1`,
    /** Applies to the next generation request (FIFO). */
    enqueue(...faults) { state.faults.push(...faults); },
    addModel(id) { state.models.add(id); },
    removeModel(id) { state.models.delete(id); },
    requests: () => state.requests.map(request => structuredClone(request)),
    usage: (key) => ({ ...(state.usage.get(key) ?? { calls: 0, prompt: 0, completion: 0, total: 0 }) }),
    storedIds: () => [...state.stored.keys()],
    aborted: () => state.aborted,
    reset: resetState,
    async close() { server.closeAllConnections(); server.close(); await once(server, 'close').catch(() => {}); },
  };
}
