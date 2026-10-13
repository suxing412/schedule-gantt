'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const {spawn} = require('node:child_process');
const {test} = require('node:test');
const {compileFrontend, buildFrontend} = require('../scripts/build-frontend.cjs');

function fixture(t, cleanupAfterTest = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-frontend-test-'));
  const cleanup = () => fs.rmSync(root, {recursive: true, force: true});
  if (cleanupAfterTest) t.after(cleanup);
  function write(file, contents) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, contents, 'utf8');
  }
  write('frontend/manifest.json', JSON.stringify({styles: ['styles/main.css'], scripts: ['scripts/state.js', 'scripts/view.js']}));
  write('frontend/shell.html', '<!DOCTYPE html>\n<style>\n<!-- @styles -->\n</style>\n<body>\n<!-- @component workspace -->\n<!-- @component utilities -->\n<!-- @component dialogs -->\n<script>\n<!-- @scripts -->\n</script>\n</body>');
  write('frontend/styles/main.css', ':root { --accent: #155eef; }');
  write('frontend/scripts/state.js', "'use strict';\nconst selection = {name: 'Task'};");
  write('frontend/scripts/view.js', 'globalThis.visibleName = selection.name;');
  write('frontend/components/workspace.html', '<main id="workspace">Workspace</main>');
  write('frontend/components/utilities.html', '<div id="toasts"></div>');
  write('frontend/components/dialogs.html', '<dialog id="editor"></dialog>');
  return {root, write, cleanup};
}

test('frontend build preserves classic shared state, component order and deterministic output', t => {
  const {root} = fixture(t);
  const result = buildFrontend({root});
  assert.equal(result.changed, true);
  assert.equal(result.html, compileFrontend(root));
  assert.equal(buildFrontend({root}).changed, false);
  assert.equal(buildFrontend({root, check: true}).changed, false);
  assert.equal((result.html.match(/<script>/g) || []).length, 1);
  assert.ok(result.html.indexOf('id="workspace"') < result.html.indexOf('id="editor"'));
  assert.doesNotMatch(result.html, /<!-- @/);
  const context = vm.createContext({});
  vm.runInContext(result.html.split('<script>')[1].split('</script>')[0], context);
  assert.equal(context.visibleName, 'Task');
});

test('frontend build detects stale files and retains last working build after source syntax errors', t => {
  const {root, write} = fixture(t);
  const original = buildFrontend({root}).html;
  write('frontend/scripts/view.js', 'globalThis.visibleName = selection.name + " updated";');
  assert.throws(() => buildFrontend({root, check: true}), /stale/);
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), original);
  write('frontend/scripts/view.js', 'const invalid = ;');
  assert.throws(() => buildFrontend({root}), SyntaxError);
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), original);
});

test('frontend build rejects invalid source manifests and duplicate template slots', t => {
  const {root, write} = fixture(t);
  write('frontend/manifest.json', JSON.stringify({styles: ['../secret.css'], scripts: ['scripts/state.js']}));
  assert.throws(() => compileFrontend(root), /escapes its directory/);
  write('frontend/manifest.json', JSON.stringify({styles: ['styles/main.css'], scripts: ['scripts/state.js', 'scripts/state.js']}));
  assert.throws(() => compileFrontend(root), /Duplicate/);
  write('frontend/manifest.json', JSON.stringify({styles: ['styles/main.css'], scripts: ['scripts/state.js']}));
  write('frontend/shell.html', '<!-- @styles --><!-- @styles -->');
  assert.throws(() => compileFrontend(root), /exactly one frontend slot/);
});

test('web preview rebuilds edited sources and confines public assets', async t => {
  const {root, write, cleanup} = fixture(t, false);
  for (const file of ['build-frontend.cjs', 'preview.cjs']) {
    write('scripts/' + file, fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8'));
  }
  write('frontend/assets/chevron.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  write('frontend/assets/private.txt', 'private');
  write('project-validation.js', 'globalThis.ProjectValidation = {};');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'scripts/preview.cjs')], {
    cwd: root, windowsHide: true, env: {...process.env, SCHEDULE_PREVIEW_PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    cleanup();
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Preview did not start')), 10000);
    child.stdout.on('data', () => {clearTimeout(timeout); resolve();});
    child.once('error', error => {clearTimeout(timeout); reject(error);});
    child.once('exit', code => {clearTimeout(timeout); reject(new Error('Preview exited: ' + code));});
  });
  const base = 'http://127.0.0.1:' + port;
  const first = await fetch(base);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /Workspace/);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  write('frontend/components/workspace.html', '<main>Updated workspace</main>');
  assert.match(await (await fetch(base)).text(), /Updated workspace/);
  const asset = await fetch(base + '/frontend/assets/chevron.svg');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /^image\/svg\+xml/);
  assert.equal((await fetch(base + '/frontend/assets/private.txt')).status, 404);
  assert.equal((await fetch(base + '/frontend/assets/%2e%2e%2fshell.html')).status, 404);
  assert.equal((await fetch(base + '/frontend/scripts/state.js')).status, 404);
  assert.equal((await fetch(base, {method: 'POST'})).status, 405);
  const head = await fetch(base, {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
