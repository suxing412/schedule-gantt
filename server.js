'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateProject, LIMITS } = require('./project-validation.js');
const { HttpError, displayName, editCode, hashEditCode, verifyEditCode, createAuth, createRateLimiter } = require('./server/auth.cjs');
const { json, send, error, requestPath, normalizeOrigins, checkOrigin, clientIp, readJson, staticFile } = require('./server/http.cjs');

const PROJECT_ID = /^[a-f0-9]{32}$/;
const PERSONAL_META = ['cols', 'lw', 'leftWidth', 'paneAuto', 'layoutVersion', 'nameAutoWidth', 'columnOrder', 'hiddenColumns', 'defView'];

function sharedProject(input) {
  let project;
  try { project = validateProject(input); } catch (err) {
    throw new HttpError(400, 'INVALID_PROJECT', String(err.message || err));
  }
  for (const key of PERSONAL_META) delete project.meta[key];
  for (const task of project.tasks) { delete task.fold;delete task.collapsed; }
  return project;
}

function publicRecord(record) {
  return { id: record.id, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt,
    updatedBy: record.updatedBy, project: sharedProject(record.project) };
}

function createApp(options = {}) {
  const { store, rootDir = __dirname, storageDriver = 'file', trustProxy = false, now = Date.now,
    publicDir = null, sessionTtlMs = 12 * 60 * 60 * 1000, maxBodyBytes = LIMITS.maxBytes + 64 * 1024 } = options;
  if (!store || !['get', 'create', 'compareAndSwap'].every(key => typeof store[key] === 'function')) throw new Error('A project store is required');
  if (!['file', 'external'].includes(storageDriver)) throw new Error('Invalid storage driver');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error('Invalid request body size');
  const allowedOrigins = normalizeOrigins(options.allowedOrigins || []);
  const auth = createAuth({ secret: options.sessionSecret, now, ttlMs: sessionTtlMs });
  const createLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 60 * 1000, ...options.rateLimits?.create, now });
  const loginLimiter = createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000, ...options.rateLimits?.login, now });
  const loginIpLimiter = createRateLimiter({ limit: 50, windowMs: 15 * 60 * 1000, ...options.rateLimits?.loginIp, now });
  const loginProjectLimiter = createRateLimiter({ limit: 50, windowMs: 15 * 60 * 1000, ...options.rateLimits?.loginProject, now });
  const loginGlobalLimiter = createRateLimiter({ limit: 300, windowMs: 60 * 1000, ...options.rateLimits?.loginGlobal, now });
  const runtime = { mode: 'shared', storage: storageDriver };
  const storeCall = async (operation, ...args) => {
    try { return await store[operation](...args); } catch (err) {
      options.onError?.(err);
      throw new HttpError(503, 'STORAGE_UNAVAILABLE', '排期存储暂时不可用，请稍后再试');
    }
  };
  const find = async id => {
    const record = await storeCall('get', id);
    if (!record) throw new HttpError(404, 'PROJECT_NOT_FOUND', '排期不存在');
    return record;
  };
  const wrongMethod = allow => {
    const err = new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方法不被允许');err.allow = allow;throw err;
  };
  return async function app(req, res) {
    try {
      const pathname = requestPath(req), method = req.method;
      if (pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(method)) checkOrigin(req, { allowedOrigins, trustProxy });
        if (pathname === '/api/projects') {
          if (method !== 'POST') wrongMethod('POST');
          createLimiter.consume(clientIp(req, trustProxy));
          const body = await readJson(req, maxBodyBytes);
          const name = displayName(body.displayName), code = editCode(body.editCode), project = sharedProject(body.project);
          const editCodeHash = await hashEditCode(code), timestamp = new Date(now()).toISOString();
          let record;
          for (let attempt = 0; attempt < 3; attempt++) {
            record = { id: crypto.randomBytes(16).toString('hex'), revision: 1, createdAt: timestamp,
              updatedAt: timestamp, updatedBy: name, project, editCodeHash };
            if (await storeCall('create', record)) {
              return json(res, 201, { ...publicRecord(record), session: auth.issue(record.id, name) });
            }
          }
          throw new HttpError(503, 'CREATE_FAILED', '暂时无法创建排期，请稍后再试');
        }
        const match = /^\/api\/projects\/([a-f0-9]{32})(\/session)?$/i.exec(pathname);
        if (!match) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
        const id = match[1].toLowerCase();
        if (match[2]) {
          if (method !== 'POST') wrongMethod('POST');
          const ip = clientIp(req, trustProxy), key = id + ':' + ip;
          loginIpLimiter.consume(ip);loginGlobalLimiter.consume('all');
          const body = await readJson(req, maxBodyBytes);
          const name = displayName(body.displayName), code = editCode(body.editCode);
          const record = await find(id);
          loginLimiter.consume(key);loginProjectLimiter.consume(id);
          if (!await verifyEditCode(code, record.editCodeHash)) throw new HttpError(401, 'INVALID_EDIT_CODE', '编辑码不正确');
          loginLimiter.clear(key);
          return json(res, 200, auth.issue(id, name));
        }
        if (method === 'GET') return json(res, 200, publicRecord(await find(id)));
        if (method !== 'PUT') wrongMethod('GET, PUT');
        const header = req.headers.authorization || '';
        const bearer = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
        const session = auth.verify(bearer && bearer[1], id);
        const body = await readJson(req, maxBodyBytes);
        if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 1 || body.baseRevision >= Number.MAX_SAFE_INTEGER) {
          throw new HttpError(400, 'INVALID_REVISION', 'baseRevision 必须是有效的正整数');
        }
        const project = sharedProject(body.project), current = await find(id);
        const conflict = async () => json(res, 409, { error: { code: 'REVISION_CONFLICT', message: '排期已被其他人修改，请加载最新版本后再保存' },
          latest: publicRecord(await find(id)) });
        if (current.revision !== body.baseRevision) return await conflict();
        const next = { ...current, revision: current.revision + 1, updatedAt: new Date(now()).toISOString(),
          updatedBy: session.displayName, project };
        if (!await storeCall('compareAndSwap', id, body.baseRevision, next)) return await conflict();
        return json(res, 200, publicRecord(next));
      }
      if (pathname === '/healthz') {
        if (method !== 'GET') wrongMethod('GET');
        return json(res, 200, { ok: true, mode: 'shared', storage: storageDriver });
      }
      if (!['GET', 'HEAD'].includes(method)) wrongMethod('GET, HEAD');
      if (pathname === '/runtime-config.js') {
        const contents = `window.SCHEDULE_RUNTIME=${JSON.stringify(runtime)};\n`;
        if (method === 'HEAD') { send(res, 200, '', 'text/javascript; charset=utf-8');return; }
        return send(res, 200, contents, 'text/javascript; charset=utf-8');
      }
      if (['/', '/index.html'].includes(pathname) || /^\/p\/[a-f0-9]{32}$/i.test(pathname)) {
        return await staticFile(res, rootDir, 'index.html', { html: true, runtime, head: method === 'HEAD' });
      }
      if (pathname === '/project-validation.js') return await staticFile(res, rootDir, 'project-validation.js', { head: method === 'HEAD' });
      if (pathname.startsWith('/frontend/assets/')) {
        return await staticFile(res, path.join(rootDir, 'frontend', 'assets'), pathname.slice('/frontend/assets/'.length), { head: method === 'HEAD' });
      }
      if (publicDir && pathname.startsWith('/public/')) return await staticFile(res, publicDir, pathname.slice('/public/'.length), { head: method === 'HEAD' });
      throw new HttpError(404, 'NOT_FOUND', '页面不存在');
    } catch (err) {
      if (!(err instanceof HttpError)) options.onError?.(err);
      error(res, err);
    }
  };
}

function environmentOptions(env = process.env) {
  const production = env.NODE_ENV === 'production', storageDriver = env.STORAGE_DRIVER || 'file';
  if (!['file', 'external'].includes(storageDriver)) throw new Error('STORAGE_DRIVER must be file or external');
  if (production && storageDriver !== 'external') throw new Error('Production requires STORAGE_DRIVER=external');
  if (storageDriver === 'external' && !env.STORAGE_ADAPTER_MODULE) throw new Error('External storage requires STORAGE_ADAPTER_MODULE');
  if (production && !path.isAbsolute(env.STORAGE_ADAPTER_MODULE)) throw new Error('Production requires an absolute STORAGE_ADAPTER_MODULE path');
  if (production && (!env.SESSION_SECRET || Buffer.byteLength(env.SESSION_SECRET) < 32)) throw new Error('Production requires SESSION_SECRET with at least 32 bytes');
  if (env.SESSION_SECRET && Buffer.byteLength(env.SESSION_SECRET) < 32) throw new Error('SESSION_SECRET must contain at least 32 bytes');
  if (env.TRUST_PROXY && !['0', '1'].includes(env.TRUST_PROXY)) throw new Error('TRUST_PROXY must be 0 or 1');
  return {
    storageDriver, adapterModule: env.STORAGE_ADAPTER_MODULE,
    dataDir: path.resolve(env.DATA_DIR || env.SCHEDULE_DATA_DIR || path.join(__dirname, '.data')),
    sessionSecret: env.SESSION_SECRET || undefined,
    allowedOrigins: [...(env.PUBLIC_ORIGIN ? [env.PUBLIC_ORIGIN] : []), ...(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)],
    trustProxy: env.TRUST_PROXY === '1', publicDir: env.PUBLIC_DIR ? path.resolve(env.PUBLIC_DIR) : null
  };
}

async function createServer(options = {}) {
  const env = options.env || process.env;
  const config = options.store ? { ...options } : { ...environmentOptions(env), ...options };
  if (env.NODE_ENV === 'production') {
    if (config.storageDriver !== 'external') throw new Error('Production requires STORAGE_DRIVER=external');
    if (!config.adapterModule || !path.isAbsolute(config.adapterModule)) throw new Error('Production requires an absolute STORAGE_ADAPTER_MODULE path');
    if (!config.sessionSecret || Buffer.byteLength(config.sessionSecret) < 32) throw new Error('Production requires SESSION_SECRET with at least 32 bytes');
  }
  if (!config.store) {
    const { createStore } = require('./server/storage.cjs');
    config.store = await createStore({ driver: config.storageDriver, dataDir: config.dataDir, adapterModule: config.adapterModule });
  }
  const app = createApp(config), server = http.createServer(app);
  server.requestTimeout = 20000;server.headersTimeout = 10000;server.keepAliveTimeout = 5000;
  server.on('clientError', (err, socket) => {
    if (!socket.writable) return;
    const body = JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'HTTP 请求无效' } });
    socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
  server.projectStore = config.store;
  return server;
}

async function main() {
  const host = process.env.HOST || '0.0.0.0', portText = process.env.PORT || '3000';
  if (!/^\d+$/.test(portText) || Number(portText) < 0 || Number(portText) > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  const config = environmentOptions();
  if (!config.sessionSecret) console.warn('Development: using a temporary session secret; editor sessions expire on restart.');
  const server = await createServer({ ...config, onError: err => console.error('Server operation failed:', err.message) });
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(Number(portText), host, resolve); });
  const address = server.address(), displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  console.log(`Schedule server listening on http://${displayHost.includes(':') ? '[' + displayHost + ']' : displayHost}:${address.port} (storage: ${config.storageDriver}).`);
  if (config.storageDriver === 'file') console.warn('Development file storage is active; production requires an external transactional adapter.');
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;stopping = true;
    const force = setTimeout(() => process.exit(1), 10000);force.unref();
    server.close(async () => {
      try { await server.projectStore.close?.();clearTimeout(force);process.exitCode = 0; } catch (err) {
        console.error('Storage shutdown failed:', err.message);process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', shutdown);process.once('SIGTERM', shutdown);
}

if (require.main === module) main().catch(err => { console.error('Server startup failed:', err.message);process.exitCode = 1; });
module.exports = { createApp, createServer, environmentOptions, sharedProject, publicRecord };
