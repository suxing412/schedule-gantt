'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { HttpError } = require('./auth.cjs');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'"
};
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function send(res, status, body, contentType, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': contentType,
    'Content-Length': bytes.length, ...headers });
  res.end(bytes);
}
function json(res, status, data, headers) { send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', headers); }
function error(res, err) {
  const known = err instanceof HttpError;
  const headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
  if (err.allow) headers.Allow = err.allow;
  if (err.status === 413) headers.Connection = 'close';
  json(res, known ? err.status : 500, { error: { code: known ? err.code : 'INTERNAL_ERROR',
    message: known ? err.message : '服务暂时无法处理请求，请稍后再试' } }, headers);
}

function requestPath(req) {
  const url = req.url || '';
  if (url.length > 4096 || !url.startsWith('/') || url.startsWith('//') || url.includes('#')) {
    throw new HttpError(400, 'INVALID_URL', '请求地址无效');
  }
  let pathname;
  try { pathname = decodeURIComponent(url.split('?')[0]); } catch {
    throw new HttpError(400, 'INVALID_URL', '请求地址编码无效');
  }
  if (/[\\\u0000-\u001f\u007f]/.test(pathname) || pathname.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new HttpError(400, 'INVALID_URL', '请求地址无效');
  }
  return pathname;
}

function normalizeOrigins(origins) {
  return (origins || []).map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value.replace(/\/$/, '')) {
      throw new Error('Allowed origins must be complete http(s) origins without paths');
    }
    return url.origin;
  });
}

function checkOrigin(req, { allowedOrigins, trustProxy }) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'ORIGIN_DENIED', '不允许跨站编辑请求');
  const host = req.headers.host;
  if (typeof host !== 'string' || !host || /[\s/@\\?#]/.test(host)) throw new HttpError(403, 'ORIGIN_DENIED', '请求主机无效');
  const forwarded = trustProxy && req.headers['x-forwarded-proto'];
  const scheme = req.socket.encrypted || (typeof forwarded === 'string' && forwarded.split(',').at(-1).trim() === 'https') ? 'https' : 'http';
  let expected;
  try { expected = new URL(`${scheme}://${host}`).origin; } catch {
    throw new HttpError(403, 'ORIGIN_DENIED', '请求来源无效');
  }
  const origin = req.headers.origin;
  if (!origin) return; // CLI/API clients use Bearer authentication and may omit Origin.
  if (allowedOrigins.length ? !allowedOrigins.includes(origin) : origin !== expected) throw new HttpError(403, 'ORIGIN_DENIED', '请求来源不被允许');
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const value = req.headers['x-forwarded-for'];
    // A single trusted edge must overwrite this header; use the hop adjacent to that edge.
    if (typeof value === 'string') {
      const address = value.split(',').at(-1).trim();
      if (address && address.length <= 128) return address;
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function readJson(req, maxBytes) {
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType) ||
      (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    req.resume();
    return Promise.reject(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json UTF-8 请求'));
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    req.resume();
    return Promise.reject(new HttpError(413, 'BODY_TOO_LARGE', '请求数据过大'));
  }
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);req.removeListener('end', onEnd);req.removeListener('aborted', onAborted);
      // Keep the request error listener until the stream ends; disconnect errors must not crash the process.
      if (err) { req.resume();reject(err); } else resolve(value);
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { chunks = [];finish(new HttpError(413, 'BODY_TOO_LARGE', '请求数据过大')); }
      else chunks.push(chunk);
    };
    const onEnd = () => {
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        return finish(new HttpError(400, 'INVALID_JSON', 'JSON 数据无效'));
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return finish(new HttpError(400, 'INVALID_JSON', '请求必须是 JSON 对象'));
      finish(null, value);
    };
    const onAborted = () => finish(new HttpError(400, 'REQUEST_ABORTED', '请求已中断'));
    req.on('data', onData);req.once('end', onEnd);req.once('aborted', onAborted);
    req.once('error', err => finish(err));
  });
}

async function staticFile(res, rootDir, relativePath, { html = false, runtime = null, head = false } = {}) {
  if (relativePath.split(/[\\/]/).some(segment => segment.startsWith('.'))) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
  const candidate = path.resolve(rootDir, relativePath), root = path.resolve(rootDir);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
  let realRoot, realFile, contents;
  try {
    [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
    if (!realFile.startsWith(realRoot + path.sep)) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
    contents = await fs.readFile(realFile);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') throw new HttpError(404, 'NOT_FOUND', '页面不存在');
    throw err;
  }
  if (html && runtime) {
    contents = Buffer.from(contents.toString('utf8')
      .replace(/<html\b[^>]*>/i, tag => tag.slice(0, -1) + ` data-schedule-mode="shared" data-schedule-storage="${runtime.storage}">`)
      .replace(/<head\b[^>]*>/i, '$&\n<base href="/">\n<script src="/runtime-config.js"></script>'));
  }
  const contentType = MIME[path.extname(relativePath).toLowerCase()];
  if (!contentType) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
  if (head) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Cache-Control': html ? 'no-store' : 'public, max-age=3600', 'Content-Type': contentType, 'Content-Length': contents.length });
    res.end();
  } else send(res, 200, contents, contentType, html ? {} : { 'Cache-Control': 'public, max-age=3600' });
}

module.exports = { HttpError, json, send, error, requestPath, normalizeOrigins, checkOrigin, clientIp, readJson, staticFile };
