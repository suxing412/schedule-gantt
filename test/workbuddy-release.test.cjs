'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const {createServer, runtimeConfiguration, safeFile} = require('../cloud/serve.cjs');
const {createRelease} = require('../scripts/release-workbuddy.cjs');
const root = path.resolve(__dirname, '..');
const SENTINEL = 'PRIVATE_TEST_CONFIG_MUST_NOT_SHIP';
const PREFIX = 'schedule-workbuddy-release-';

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const sourceRoot = path.join(temporary, 'source');
  const destination = path.join(temporary, 'handoff');
  t.after(() => {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith(PREFIX));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const files = {
    'LICENSE': 'MIT fixture license',
    'frontend/manifest.json': JSON.stringify({styles: ['styles/base.css'], scripts: ['scripts/app.js']}),
    'frontend/shell.html': '<!DOCTYPE html><html><head><style><!-- @styles --></style></head><body><!-- @component workspace --><!-- @component utilities --><!-- @component dialogs --><script src="project-validation.js"></script><script><!-- @scripts --></script></body></html>',
    'frontend/styles/base.css': 'body { color: #123456; }',
    'frontend/scripts/app.js': 'window.fixtureApp = true;',
    'frontend/components/workspace.html': '<main>WorkBuddy release fixture</main>',
    'frontend/components/utilities.html': '<aside></aside>',
    'frontend/components/dialogs.html': '<dialog></dialog>',
    'cloud/migrations/001_schedule_rpc.sql': '-- Private tables and narrow RPCs',
    'cloud/migrations/002_collab_external.sql': '-- External credentials and presence',
    'cloud/migrations/003_tool_actions.sql': '-- Atomic actions',
    'cloud/tests/rpc.sql': '-- Isolated SQL tests',
    'cloud/README.md': 'Read [API](AI-TOOLS.md) and [deployment](DEPLOYMENT.md)',
    'cloud/DEPLOYMENT.md': 'Apply SQL, inject public config, npm start; [checks](tests/README.md)',
    'cloud/HANDOFF-PROMPT.md': 'Upgrade existing V1 with 002 then 003.',
    'cloud/AI-TOOLS.md': 'HTTP and MCP tools.',
    'cloud/RPC.md': 'RPC contracts.',
    'cloud/VALIDATION.md': 'Verification record.',
    'cloud/tests/README.md': 'Disposable database only.',
    'examples/全功能示例排期_星火行动.json': '{"tasks":[],"groups":[],"flags":[]}',
    'project-validation.js': 'window.ProjectValidation = {};',
    'package.json': JSON.stringify({name: 'source-app', version: '3.2.1'}),
    'test/cloud-transport.test.cjs': "require('node:test')('cloud fixture',()=>{});",
    'test/shared-client.test.cjs': "require('node:test')('shared fixture',()=>{});",
    'test/validation.test.cjs': "require('node:test')('validation fixture',()=>{});",
    'test/workbuddy-release.test.cjs': SENTINEL,
    '.env': SENTINEL, '.data/a.json': SENTINEL, 'server.js': SENTINEL, 'main.js': SENTINEL,
    'frontend/.env': SENTINEL, 'frontend/.data/private.json': SENTINEL,
    'frontend/nested/node_modules/private.js': SENTINEL, 'frontend/nested/key.pem': SENTINEL,
    'cloud/migrations/.env': SENTINEL, 'cloud/tests/.private.json': SENTINEL
  };
  for (const relative of ['cloud/serve.cjs', 'project-validation.js', 'frontend/scripts/project.js', 'scripts/build-frontend.cjs', 'scripts/vendor-workbuddy-sdk.cjs', 'frontend/assets/workbuddy-sdk.js', 'frontend/assets/workbuddy-sdk.LICENSE.txt', 'frontend/assets/workbuddy-sdk.manifest.json', ...fs.readdirSync(path.join(root,'cloud/ai')).filter(name=>/\.(cjs|json)$/.test(name)).map(name=>'cloud/ai/'+name)]) files[relative] = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const [relative, contents] of Object.entries(files)) {
    const filename = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(filename), {recursive: true});
    fs.writeFileSync(filename, contents);
  }
  return {temporary, sourceRoot, destination};
}

function walk(folder) {
  return fs.readdirSync(folder, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]);
}

async function listen(t, options) {
  const server = createServer(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('WorkBuddy handoff includes editable sources, verified SDK and SQL but no private storage or credentials', t => {
  const f = fixture(t);
  assert.equal(createRelease(f), f.destination);
  const pkg = JSON.parse(fs.readFileSync(path.join(f.destination, 'package.json')));
  assert.equal(pkg.name, 'schedule-gantt-workbuddy');
  assert.equal(pkg.version, '3.2.1');
  assert.equal(pkg.scripts.start, 'node cloud/serve.cjs');
  assert.equal(pkg.scripts.prestart, undefined);
  assert.deepEqual(pkg.dependencies, {});
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(fs.readFileSync(path.join(f.destination, 'LICENSE'), 'utf8'), 'MIT fixture license');
  assert.ok(fs.existsSync(path.join(f.destination, 'cloud/migrations/001_schedule_rpc.sql')));
  for (const relative of ['cloud/migrations/002_collab_external.sql','cloud/migrations/003_tool_actions.sql','cloud/ai/http.cjs','cloud/ai/mcp.cjs','frontend/scripts/project.js','HANDOFF-PROMPT.md']) assert.ok(fs.existsSync(path.join(f.destination,relative)),relative);
  assert.match(fs.readFileSync(path.join(f.destination,'README.md'),'utf8'), /\]\(cloud\/AI-TOOLS\.md\)/);
  assert.match(fs.readFileSync(path.join(f.destination,'DEPLOYMENT.md'),'utf8'), /\]\(cloud\/tests\/README\.md\)/);
  assert.ok(fs.existsSync(path.join(f.destination, 'test/cloud-transport.test.cjs')));
  for (const file of walk(f.destination)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(SENTINEL));
  assert.equal(fs.existsSync(path.join(f.destination, 'server.js')), false);
  assert.match(fs.readFileSync(path.join(f.destination, '.env.example'), 'utf8'), /WORKBUDDY_PUBLISHABLE_KEY=\n/);
});

test('existing release is preserved without overwrite', t => {
  const f = fixture(t);
  fs.mkdirSync(f.destination);
  fs.writeFileSync(path.join(f.destination, 'keep.txt'), 'keep');
  assert.throws(() => createRelease(f), /交付目录已存在/);
  assert.equal(fs.readFileSync(path.join(f.destination, 'keep.txt'), 'utf8'), 'keep');
});

for (const missing of ['cloud/serve.cjs', 'cloud/migrations/001_schedule_rpc.sql', 'cloud/migrations/002_collab_external.sql', 'cloud/migrations/003_tool_actions.sql', 'cloud/ai/http.cjs', 'cloud/ai/read-tools.cjs', 'cloud/ai/mcp.cjs', 'cloud/HANDOFF-PROMPT.md', 'frontend/scripts/project.js', 'cloud/DEPLOYMENT.md', 'frontend/assets/workbuddy-sdk.js', 'examples/全功能示例排期_星火行动.json']) {
  test('missing ' + missing + ' cannot produce a release', t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.sourceRoot, missing));
    assert.throws(() => createRelease(f));
    assert.equal(fs.existsSync(f.destination), false);
  });
}

test('modified SDK fails checksum before handoff creation', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.sourceRoot, 'frontend/assets/workbuddy-sdk.js'), '\n// tampered');
  assert.throws(() => createRelease(f), /checksum/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('unconfigured service remains WorkBuddy mode, serves setup config, and distinguishes liveness/readiness', async t => {
  const f = fixture(t); createRelease(f);
  const origin = await listen(t, {root: f.destination, env: {}});
  const html = await (await fetch(origin + '/')).text();
  assert.match(html, /data-schedule-mode="workbuddy"/);
  assert.match(html, /<base href="\/">/);
  assert.ok(html.indexOf('/runtime-config.js') < html.indexOf('/frontend/assets/workbuddy-sdk.js'));
  assert.ok(html.indexOf('/frontend/assets/workbuddy-sdk.js') < html.indexOf('window.fixtureApp'));
  const context = {window: {}};
  vm.runInNewContext(await (await fetch(origin + '/runtime-config.js')).text(), context);
  assert.equal(context.window.SCHEDULE_RUNTIME.mode, 'workbuddy');
  assert.equal(context.window.SCHEDULE_RUNTIME.configured, false);
  assert.equal(context.window.SCHEDULE_RUNTIME.configError.code, 'CLOUD_CONFIG_MISSING');
  const health = await fetch(origin + '/healthz');
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), {ok:false, mode:'workbuddy', storage:'workbuddy', buildReady:true, configured:false});
  assert.equal((await fetch(origin + '/livez')).status, 200);
});

test('configured service supports direct share navigation and confines CSP to its cloud origin', async t => {
  const f = fixture(t); createRelease(f);
  const origin = await listen(t, {root: f.destination, env: {NODE_ENV:'production', WORKBUDDY_ENDPOINT:'https://example.app.workbuddy.host', WORKBUDDY_PUBLISHABLE_KEY:'wbpk_fixture_public'}});
  const page = await fetch(origin + '/p/' + 'a'.repeat(32));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https:\/\/example\.app\.workbuddy\.host;/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /\*/);
  assert.equal((await fetch(origin + '/healthz')).status, 200);
  assert.equal((await fetch(origin + '/frontend/assets/workbuddy-sdk.js')).status, 200);
  assert.equal((await fetch(origin + '/project-validation.js')).status, 200);
  const runtime = await fetch(origin + '/runtime-config.js');
  assert.equal(runtime.headers.get('cache-control'), 'no-store');
  assert.match(await runtime.text(), /wbpk_fixture_public/);
});

test('same-origin endpoint default and endpoint/key rejection are explicit and fail closed', () => {
  const valid = runtimeConfiguration({NODE_ENV:'production',WORKBUDDY_PUBLISHABLE_KEY:'wbpk_fixture'}).runtime;
  assert.equal(valid.configured, true); assert.equal(valid.cloud.endpoint, '');
  for (const endpoint of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?token=abc', 'javascript:alert(1)']) {
    const result = runtimeConfiguration({NODE_ENV:'production', WORKBUDDY_PUBLISHABLE_KEY:'wbpk_fixture', WORKBUDDY_ENDPOINT:endpoint}).runtime;
    assert.equal(result.configured, false); assert.equal(result.cloud.publishableKey, '');
  }
  assert.equal(runtimeConfiguration({WORKBUDDY_PUBLISHABLE_KEY:'wbpk_fixture',WORKBUDDY_ENDPOINT:'http://127.0.0.1:3001'}).runtime.configured, true);
  assert.equal(runtimeConfiguration({WORKBUDDY_PUBLISHABLE_KEY:'service_role_secret'}).runtime.configured, false);
});

test('static whitelist does not expose migration, credentials, tests, private server, or mutation routes', async t => {
  const f = fixture(t); createRelease(f);
  fs.writeFileSync(path.join(f.destination, '.env'), SENTINEL);
  const origin = await listen(t, {root:f.destination, env:{}});
  for (const url of ['/cloud/migrations/001_schedule_rpc.sql', '/cloud/serve.cjs', '/.env', '/package.json', '/frontend/scripts/app.js', '/test/cloud-transport.test.cjs', '/api/projects', '/p/not-valid']) {
    const response = await fetch(origin + url); assert.equal(response.status,404,url); assert.doesNotMatch(await response.text(),new RegExp(SENTINEL));
  }
  assert.equal((await fetch(origin + '/', {method:'POST',body:'ignored'})).status,405);
  const head = await fetch(origin + '/', {method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),'');
  for (const rawPath of ['/frontend/assets/%2e%2e/%2e%2e/.env','/frontend/assets/%5c..%5c.env','/frontend/assets/%00.js']) {
    const status = await new Promise((resolve,reject)=> {const req=http.get(origin,{path:rawPath},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
    assert.equal(status,400,rawPath);
  }
});

test('iframe preview origins are opt-in explicit origins and cannot weaken CSP with wildcards or paths', async t => {
  const f = fixture(t); createRelease(f);
  const origin = await listen(t, {root:f.destination,env:{NODE_ENV:'production',WORKBUDDY_PUBLISHABLE_KEY:'wbpk_fixture',WORKBUDDY_FRAME_ANCESTORS:'https://preview.example.com, https://console.example.com/'}});
  const response = await fetch(origin + '/');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/preview\.example\.com https:\/\/console\.example\.com$/);
  for (const invalid of ['*','https://*.example.com','https://example.com/path','https://user:pass@example.com','https://example.com?x=1','http://example.com']) {
    const result = runtimeConfiguration({NODE_ENV:'production',WORKBUDDY_PUBLISHABLE_KEY:'wbpk_fixture',WORKBUDDY_FRAME_ANCESTORS:invalid});
    assert.equal(result.runtime.configured,false,invalid);
    assert.deepEqual(result.frameOrigins,[],invalid);
  }
});

test('public assets cannot escape through a directory link even when its target is inside the release', t => {
  const f = fixture(t); createRelease(f);
  const privateDir = path.join(f.destination, 'private-files');
  fs.mkdirSync(privateDir);
  fs.writeFileSync(path.join(privateDir, 'config.js'), SENTINEL);
  const link = path.join(f.destination, 'frontend/assets/link');
  fs.symlinkSync(privateDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(safeFile(f.destination, 'frontend/assets/link/config.js'), null);
});
