'use strict';

// WorkBuddy hosts the frontend and stateless AI tool gateway. Shared data and
// authorization live in database RPCs, never in this process or local files.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const projectRoot = path.resolve(__dirname, '..');
const MIME = {'.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8'};

function runtimeConfiguration(env = process.env) {
  const endpoint = String(env.WORKBUDDY_ENDPOINT || '').trim();
  const publishableKey = String(env.WORKBUDDY_PUBLISHABLE_KEY || '').trim();
  let configError = null;
  let endpointOrigin = '';
  const frameOrigins = [];
  if (!publishableKey) configError = {code: 'CLOUD_CONFIG_MISSING', message: '尚未配置 WorkBuddy 云服务。请部署方设置 WORKBUDDY_PUBLISHABLE_KEY，并按需设置 WORKBUDDY_ENDPOINT，然后重启服务。'};
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && url.protocol === 'http:' && loopback))) throw new Error('Invalid endpoint');
      endpointOrigin = url.origin;
    } catch (_) {
      configError = {code: 'CLOUD_CONFIG_INVALID', message: 'WorkBuddy 端点配置无效。请使用不含用户名、密码、查询参数或片段的 HTTPS 地址；本地开发可使用 HTTP localhost。'};
    }
  }
  if (publishableKey && (!publishableKey.startsWith('wbpk_') || publishableKey.length > 4096 || /[\s\u0000-\u001f]/.test(publishableKey))) configError = {code: 'CLOUD_CONFIG_INVALID', message: 'WorkBuddy 公开密钥配置无效。请使用平台 publicConfig 中的 publishableKey，不能填写数据库密码或服务端密钥。'};
  if (env.WORKBUDDY_FRAME_ANCESTORS) {
    try {
      for (const entry of String(env.WORKBUDDY_FRAME_ANCESTORS).split(',')) {
        const url = new URL(entry.trim());
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (!entry.trim() || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.hostname.includes('*') || (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && url.protocol === 'http:' && loopback))) throw new Error('Invalid parent origin');
        if (!frameOrigins.includes(url.origin)) frameOrigins.push(url.origin);
      }
    } catch (_) { frameOrigins.length = 0; configError = {code:'CLOUD_CONFIG_INVALID', message:'嵌入预览来源配置无效。WORKBUDDY_FRAME_ANCESTORS 仅接受逗号分隔的明确 HTTPS origin，不允许通配符或路径。'}; }
  }
  return {
    runtime: {mode: 'workbuddy', storage: 'workbuddy', configured: !configError, configError, cloud: {endpoint: configError ? '' : endpoint, publishableKey: configError ? '' : publishableKey}},
    endpointOrigin: configError ? '' : endpointOrigin,
    frameOrigins: configError ? [] : frameOrigins
  };
}

function injectRuntime(html) {
  if (!/<html\b/i.test(html) || !/<head\b[^>]*>/i.test(html)) throw new Error('Invalid frontend build');
  return html.replace(/<html\b([^>]*)>/i, (_, attrs) => '<html' + attrs.replace(/\sdata-schedule-(?:mode|storage)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '') + ' data-schedule-mode="workbuddy" data-schedule-storage="workbuddy">')
    .replace(/<head\b[^>]*>/i, match => match + '\n<base href="/">\n<link rel="service-desc" type="application/vnd.oai.openapi+json" href="/api/openapi.json">\n<link rel="alternate" type="text/plain" href="/llms.txt" title="AI tools">\n<script src="/runtime-config.js"></script>\n<script src="/frontend/assets/workbuddy-sdk.js"></script>');
}

function safeFile(root, relative) {
  const resolvedRoot = fs.realpathSync(root);
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep)) return null;
  try {
    // A link inside assets must not turn the public allowlist into access to
    // another file, including files elsewhere inside the project directory.
    let segment = path.resolve(root);
    for (const component of path.relative(root, file).split(path.sep)) {
      segment = path.join(segment, component);
      if (fs.lstatSync(segment).isSymbolicLink()) return null;
    }
    const actual = fs.realpathSync(file);
    if (!actual.startsWith(resolvedRoot + path.sep) || !fs.statSync(actual).isFile()) return null;
    return actual;
  } catch (_) { return null; }
}

function buildReady(root) {
  return ['index.html', 'project-validation.js', 'frontend/assets/workbuddy-sdk.js'].every(relative => !!safeFile(root, relative));
}

function createServer({root = projectRoot, env = process.env} = {}) {
  root = path.resolve(root);
  const config = runtimeConfiguration(env);
  // Never derive an upstream target from an untrusted Host/Origin header. The
  // browser can use its own origin; external tool calls need the explicit URL.
  const toolHandler = require('./ai/http.cjs').createToolHandler({
    endpoint: config.runtime.cloud.endpoint,
    publishableKey: config.runtime.cloud.publishableKey
  });
  const csp = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "connect-src 'self'" + (config.endpointOrigin ? ' ' + config.endpointOrigin : ''), "base-uri 'self'", "object-src 'none'", "frame-ancestors 'self'" + (config.frameOrigins.length ? ' ' + config.frameOrigins.join(' ') : '')].join('; ');
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, type, body) => {
      res.writeHead(status, {'Content-Type': type, 'Content-Length': Buffer.byteLength(body)});
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    let pathname;
    try {
      const raw = String(req.url || '').split('?')[0];
      if (!raw.startsWith('/') || /[\\\u0000-\u001f]/.test(raw)) throw new Error('Invalid path');
      pathname = decodeURIComponent(raw);
      if (/[\\\u0000-\u001f]/.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid path');
    } catch (_) { return send(400, 'text/plain; charset=utf-8', 'Invalid request path'); }
    try {
      if (await toolHandler(req, res, pathname)) return;
    } catch (_) {
      if (res.headersSent) return res.destroy();
      return send(500, 'application/json; charset=utf-8', JSON.stringify({ok:false,error:{code:'INTERNAL_ERROR',message:'工具服务暂时不可用，请稍后重试。'}}));
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return send(405, 'text/plain; charset=utf-8', 'Method not allowed'); }
    if (pathname === '/livez') return send(200, 'application/json; charset=utf-8', '{"ok":true}');
    if (pathname === '/healthz') {
      const built = buildReady(root);
      const status = {ok: built && config.runtime.configured, mode: 'workbuddy', storage: 'workbuddy', buildReady: built, configured: config.runtime.configured};
      return send(status.ok ? 200 : 503, 'application/json; charset=utf-8', JSON.stringify(status));
    }
    if (pathname === '/runtime-config.js') {
      const json = JSON.stringify(config.runtime).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      return send(200, 'text/javascript; charset=utf-8', 'window.SCHEDULE_RUNTIME=' + json + ';\n');
    }
    let relative;
    const isHTML = pathname === '/' || pathname === '/index.html' || /^\/p\/[a-f0-9]{32}\/?$/.test(pathname);
    if (isHTML) relative = 'index.html';
    else if (pathname === '/project-validation.js') relative = 'project-validation.js';
    else if (/^\/frontend\/assets\/[a-zA-Z0-9_./-]+$/.test(pathname) && MIME[path.extname(pathname)]) relative = pathname.slice(1);
    else return send(404, 'text/plain; charset=utf-8', 'Not found');
    const filename = safeFile(root, relative);
    if (!filename) return send(404, 'text/plain; charset=utf-8', 'Not found');
    try {
      const body = isHTML ? injectRuntime(fs.readFileSync(filename, 'utf8')) : fs.readFileSync(filename);
      return send(200, isHTML ? 'text/html; charset=utf-8' : MIME[path.extname(filename)], body);
    } catch (_) { return send(503, 'text/plain; charset=utf-8', 'Frontend build unavailable. Run npm run build.'); }
  });
}

module.exports = {createServer, runtimeConfiguration, injectRuntime, safeFile};
if (require.main === module) {
  const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('PORT must be an integer between 0 and 65535.'); process.exitCode = 1; }
  else {
    const server = createServer();
    server.on('error', () => { console.error('WorkBuddy web server could not start. Check HOST and PORT.'); process.exitCode = 1; });
    server.listen(port, process.env.HOST || '0.0.0.0', () => {
      console.log('WorkBuddy web server listening on port ' + server.address().port);
      if (!runtimeConfiguration().runtime.configured) console.log('Cloud configuration missing or invalid. Open the website for setup instructions.');
    });
  }
}
