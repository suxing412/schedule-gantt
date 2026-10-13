'use strict';

/*
 * Dependency-free stdio MCP adapter. Supported wire revisions are pinned;
 * this is not a Streamable HTTP MCP server.
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 * https://modelcontextprotocol.io/specification/2025-11-25/server/tools
 */
const { StringDecoder } = require('node:string_decoder');

const SUPPORTED_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2024-11-05']);
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const own = (object, name) => Object.prototype.hasOwnProperty.call(object, name);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const failure = (code, message, extra = {}) => ({ ok: false, error: { code, message }, ...extra });

class AdapterError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function readConfig(env = process.env) {
  let url;
  try { url = new URL(env.SCHEDULE_API_URL); }
  catch { throw new AdapterError('CONFIGURATION_ERROR', 'Set SCHEDULE_API_URL to the deployed schedule origin (for example https://your-app.app.workbuddy.host).'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new AdapterError('CONFIGURATION_ERROR', 'SCHEDULE_API_URL must be an HTTPS origin with no path, credentials, query, or fragment; HTTP is allowed only on loopback for development.');
  }
  const projectId = env.SCHEDULE_PROJECT_ID || '';
  if (!/^[a-f0-9]{32}$/.test(projectId)) {
    throw new AdapterError('CONFIGURATION_ERROR', 'Set SCHEDULE_PROJECT_ID to the 32-character lowercase hexadecimal project ID from its share link.');
  }
  const apiKey = env.SCHEDULE_API_KEY || '';
  if (apiKey && !/^[a-f0-9]{64}$/.test(apiKey)) {
    throw new AdapterError('CONFIGURATION_ERROR', 'SCHEDULE_API_KEY must be the 64-character lowercase hexadecimal AI key; omit it for public read-only access.');
  }
  const displayName = (env.SCHEDULE_DISPLAY_NAME || 'AI助手').trim();
  if (!displayName || displayName.length > 64) {
    throw new AdapterError('CONFIGURATION_ERROR', 'SCHEDULE_DISPLAY_NAME must contain 1 to 64 characters.');
  }
  return { origin: url.origin, projectId, apiKey, displayName };
}

async function readJson(response, signal) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) {
    if (response.body) await response.body.cancel();
    throw new AdapterError('RESPONSE_TOO_LARGE', 'The HTTP response exceeds the 10 MiB limit.');
  }
  const reader = response.body && response.body.getReader();
  if (!reader) throw new AdapterError('INVALID_RESPONSE', 'The HTTP service returned an empty response.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new AdapterError('TIMEOUT', 'The request was interrupted or exceeded 20 seconds. Its result is unknown; read the project before deciding whether to write again.');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new AdapterError('RESPONSE_TOO_LARGE', 'The HTTP response exceeds the 10 MiB limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AdapterError('INVALID_RESPONSE', 'The HTTP service returned invalid JSON. Read the project before retrying a write.'); }
}

function createAdapter({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  const config = readConfig(env);
  let session = null;
  let loginPromise = null;
  let catalogPromise = null;
  const secrets = new Set(config.apiKey ? [config.apiKey] : []);
  const redact = value => {
    let text = JSON.stringify(value);
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return JSON.parse(text);
  };

  async function request(path, { method = 'GET', body, token, signal } = {}) {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && Buffer.byteLength(serialized) > MAX_BYTES) {
      throw new AdapterError('REQUEST_TOO_LARGE', 'The HTTP request exceeds the 10 MiB limit.');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(config.origin + path, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: 'Bearer ' + token } : {})
        },
        ...(serialized === undefined ? {} : { body: serialized })
      });
      const result = await readJson(response, controller.signal);
      if (!response.ok && (!object(result) || result.ok !== false || !object(result.error))) {
        throw new AdapterError('HTTP_ERROR', 'The schedule HTTP service returned status ' + response.status + '. No request was retried.');
      }
      return { status: response.status, result };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (controller.signal.aborted) {
        throw new AdapterError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT', 'The request was interrupted or exceeded 20 seconds. Its result is unknown; read the project before deciding whether to write again.');
      }
      // Network exceptions may contain a credential-bearing request; do not forward them.
      throw new AdapterError('NETWORK_ERROR', 'The schedule service could not be reached. No request was retried; read the project before retrying a write.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function catalog(signal) {
    if (!catalogPromise) {
      catalogPromise = (async () => {
        const { result } = await request('/api/tools', { signal });
        if (!object(result) || result.version !== '2' || !Array.isArray(result.tools)) {
          throw new AdapterError('INVALID_CATALOG', 'The service did not return the expected version 2 tool catalog.');
        }
        const names = new Set();
        return result.tools.map(raw => {
          if (!object(raw) || !/^[a-zA-Z0-9_.-]{1,128}$/.test(raw.name || '') || names.has(raw.name) ||
              !object(raw.inputSchema) || raw.inputSchema.type !== 'object') {
            throw new AdapterError('INVALID_CATALOG', 'The service returned an invalid or duplicate tool definition.');
          }
          names.add(raw.name);
          const readOnly = raw.annotations?.readOnlyHint === true;
          const requiresRevision = raw['x-requiresRevision'] === true || (!readOnly && raw['x-requiresRevision'] !== false);
          const inputSchema = clone(raw.inputSchema);
          if (requiresRevision) {
            inputSchema.properties = {
              ...(inputSchema.properties || {}),
              expectedRevision: {
                type: 'integer', minimum: 1,
                description: 'The revision read from this project before this write. A conflict is never automatically retried.'
              }
            };
            inputSchema.required = [...new Set([...(inputSchema.required || []), 'expectedRevision'])];
          }
          return {
            name: raw.name, description: typeof raw.description === 'string' ? raw.description : raw.name,
            inputSchema, ...(object(raw.annotations) ? { annotations: clone(raw.annotations) } : {}),
            readOnly, requiresRevision, requiresAuth: raw.requiresAuth === true || !readOnly
          };
        });
      })().catch(error => { catalogPromise = null; throw error; });
    }
    return catalogPromise;
  }

  async function getSession(signal) {
    if (session && Date.parse(session.expiresAt) > now() + 1000) return session;
    session = null;
    if (!config.apiKey) {
      throw new AdapterError('API_KEY_REQUIRED', 'Set SCHEDULE_API_KEY to this project’s AI key to use authorized tools. Public read tools work without a key.');
    }
    if (!loginPromise) {
      loginPromise = (async () => {
        const { result } = await request('/api/projects/' + config.projectId + '/sessions/external', {
          method: 'POST', body: { apiKey: config.apiKey, displayName: config.displayName }, signal
        });
        if (result?.ok !== true) {
          return { error: object(result) ? result : failure('AUTHENTICATION_FAILED', 'The AI key could not be verified.') };
        }
        const value = result.data;
        if (!object(value) || !/^[a-f0-9]{64}$/.test(value.token || '') ||
            !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now()) {
          throw new AdapterError('INVALID_SESSION', 'The service returned an invalid or expired external session.');
        }
        secrets.add(value.token);
        session = { token: value.token, expiresAt: value.expiresAt };
        return session;
      })().finally(() => { loginPromise = null; });
    }
    return loginPromise;
  }

  return {
    config: { origin: config.origin, projectId: config.projectId, displayName: config.displayName, canAuthenticate: !!config.apiKey },
    redact,
    async list(signal) {
      return (await catalog(signal)).map(({ readOnly, requiresRevision, requiresAuth, ...tool }) => tool);
    },
    async call(name, args, signal) {
      const definition = (await catalog(signal)).find(tool => tool.name === name);
      if (!definition) return { unknownTool: true };
      if (!object(args)) return failure('INVALID_ARGUMENTS', 'Tool arguments must be a JSON object.');
      if (own(args, 'projectId')) return failure('INVALID_ARGUMENTS', 'The project is fixed by SCHEDULE_PROJECT_ID; projectId is not a tool argument.');
      const businessArgs = { ...args };
      let expectedRevision;
      if (definition.requiresRevision) {
        expectedRevision = businessArgs.expectedRevision;
        delete businessArgs.expectedRevision;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
          return failure('INVALID_REVISION', 'A write requires expectedRevision, a positive integer from the latest project read.');
        }
      }
      let token;
      if (definition.requiresAuth) {
        const authenticated = await getSession(signal);
        if (authenticated.error) return authenticated.error;
        token = authenticated.token;
      }
      const { status, result } = await request('/api/tools/call', {
        method: 'POST', token, signal,
        body: {
          name, arguments: businessArgs, projectId: config.projectId,
          ...(expectedRevision === undefined ? {} : { expectedRevision })
        }
      });
      if (status === 401 || ['SESSION_EXPIRED', 'INVALID_SESSION', 'UNAUTHORIZED', 'SESSION_INVALID'].includes(result?.error?.code) ||
          (name === 'session.revoke' && result?.ok === true)) session = null;
      // Even a 401/409 never repeats this call. A subsequent user-directed call may authenticate again.
      if (!object(result) || typeof result.ok !== 'boolean') {
        throw new AdapterError('INVALID_RESPONSE', 'The tool service returned an invalid result. Read the project before retrying a write.');
      }
      return result;
    }
  };
}

function createMcpServer(options = {}) {
  const adapter = options.adapter || createAdapter(options);
  let state = 'new';
  const pending = new Map();
  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });

  async function handle(message) {
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (own(message, 'id') && !(typeof message.id === 'string' || Number.isSafeInteger(message.id))) ||
        (own(message, 'params') && !object(message.params))) {
      return error(null, -32600, 'Invalid JSON-RPC request.');
    }
    const isRequest = own(message, 'id');
    const { id, method } = message;
    const params = message.params || {};
    if (!isRequest) {
      if (method === 'notifications/initialized' && state === 'initializing') state = 'ready';
      if (method === 'notifications/cancelled') pending.get(params.requestId)?.abort();
      return null;
    }
    if (method === 'ping') return result(id, {});
    if (method === 'initialize') {
      if (state !== 'new') return error(id, -32600, 'This connection has already been initialized.');
      if (typeof params.protocolVersion !== 'string' || !object(params.capabilities) ||
          !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        return error(id, -32602, 'initialize requires protocolVersion, capabilities, and clientInfo with name and version.');
      }
      state = 'initializing';
      return result(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'schedule-gantt', version: '2.0.0' },
        instructions: 'This connection operates on one configured schedule. Read its revision before a write; preview changes when useful. Never automatically repeat a failed or timed-out write. A version conflict requires reading the current project and reviewing the intended change again.'
      });
    }
    if (state !== 'ready') return error(id, -32002, 'Initialize the connection and send notifications/initialized first.');
    if (method !== 'tools/list' && method !== 'tools/call') return error(id, -32601, 'Method not found.');
    if (pending.has(id)) return error(id, -32600, 'A request with this ID is already running.');
    if (pending.size >= 32) return error(id, -32000, 'Too many concurrent requests.');
    const controller = new AbortController();
    pending.set(id, controller);
    try {
      if (method === 'tools/list') {
        if (params.cursor !== undefined) return error(id, -32602, 'This server does not use paginated tool cursors.');
        return result(id, { tools: await adapter.list(controller.signal) });
      }
      if (typeof params.name !== 'string' || (params.arguments !== undefined && !object(params.arguments))) {
        return error(id, -32602, 'tools/call requires a name and object arguments.');
      }
      const value = await adapter.call(params.name, params.arguments || {}, controller.signal);
      if (value?.unknownTool) return error(id, -32602, 'Unknown tool.');
      const safe = adapter.redact(value);
      return result(id, { content: [{ type: 'text', text: JSON.stringify(safe) }], isError: safe.ok !== true });
    } catch (cause) {
      const safe = failure(cause instanceof AdapterError ? cause.code : 'INTERNAL_ERROR',
        cause instanceof AdapterError ? cause.message : 'The MCP adapter could not complete this request.');
      if (method === 'tools/list') return error(id, -32000, safe.error.message);
      return result(id, { content: [{ type: 'text', text: JSON.stringify(adapter.redact(safe)) }], isError: true });
    } finally { pending.delete(id); }
  }
  return { handle, redact: adapter.redact, close() { for (const controller of pending.values()) controller.abort(); } };
}

function startStdio({ input = process.stdin, output = process.stdout, errorOutput = process.stderr, ...options } = {}) {
  let server;
  try { server = createMcpServer(options); }
  catch (cause) {
    errorOutput.write((cause instanceof AdapterError ? cause.message : 'Unable to initialize the MCP adapter.') + '\n');
    return { failed: true };
  }
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  let closed = false;
  let discarding = false;
  const send = message => {
    if (message && !closed) output.write(JSON.stringify(server.redact(message)) + '\n');
  };
  const parse = line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
    Promise.resolve(server.handle(message)).then(send, () => send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error.' } }));
  };
  const consume = text => {
    if (discarding) {
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      text = text.slice(newline + 1);
      discarding = false;
    }
    buffered += text;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_BYTES) send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message exceeds the 10 MiB limit.' } });
      else parse(line);
    }
    if (Buffer.byteLength(buffered) > MAX_BYTES) {
      buffered = ''; discarding = true;
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message exceeds the 10 MiB limit.' } });
    }
  };
  input.on('data', chunk => consume(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
  input.on('end', () => { consume(decoder.end()); buffered = ''; closed = true; server.close(); });
  input.on('error', () => { closed = true; server.close(); });
  output.on('error', () => { closed = true; server.close(); });
  return { failed: false, close() { closed = true; server.close(); } };
}

if (require.main === module) {
  if (startStdio().failed) process.exitCode = 1;
}

module.exports = { SUPPORTED_VERSIONS, MAX_BYTES, readConfig, createAdapter, createMcpServer, startStdio };
