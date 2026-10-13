'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRelease} = require('../scripts/release-web.cjs');

const fixturePrefix = 'schedule-gantt-web-release-test-';
const secretSentinel = 'FAKE_LOCAL_CREDENTIAL_MUST_NOT_SHIP';

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), fixturePrefix));
  const sourceRoot = path.join(temporary, 'source');
  const destination = path.join(temporary, 'handoff');
  t.after(() => {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith(fixturePrefix));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const files = {
    'frontend/manifest.json': JSON.stringify({styles: ['styles/base.css'], scripts: ['scripts/app.js']}),
    'frontend/shell.html': '<!DOCTYPE html>\n<style><!-- @styles --></style>\n<!-- @component workspace -->\n<!-- @component utilities -->\n<!-- @component dialogs -->\n<script><!-- @scripts --></script>',
    'frontend/styles/base.css': 'body { color: #123456; }',
    'frontend/scripts/app.js': 'const releaseFixture = {ready: true};',
    'frontend/components/workspace.html': '<main>Independent web fixture</main>',
    'frontend/components/utilities.html': '<aside>Utility</aside>',
    'frontend/components/dialogs.html': '<dialog>Editor</dialog>',
    'frontend/assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'frontend/README.md': 'Editable frontend sources.',
    'server.js': "'use strict'; require('./server/app.cjs');\n",
    'server/app.cjs': "module.exports = {kind: 'standalone'};\n",
    'server/ADAPTER-CONTRACT.md': 'Storage adapter contract.',
    'server/adapters/cloud.example.cjs': "module.exports = {example: true};\n",
    'project-validation.js': 'module.exports = {validate: input => input};\n',
    'DEPLOYMENT.md': 'Deployment instructions for the fixture.',
    '.env.example': 'PORT=3000\nSESSION_SECRET=replace-on-deployment\n',
    'scripts/build-frontend.cjs': fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-frontend.cjs'), 'utf8'),
    'package.json': JSON.stringify({name: 'desktop-source', version: '2.3.4', main: 'main.js',
      scripts: {start: 'electron .'}, dependencies: {desktopOnly: '1.0.0'}, devDependencies: {electron: '31.0.0'}}),
    'test/server-api.test.cjs': "require('node:test')('server fixture',()=>{});\n",
    'test/shared-client.test.cjs': "require('node:test')('shared fixture',()=>{});\n",
    'test/validation.test.cjs': "require('node:test')('validation fixture',()=>{});\n",
    'test/desktop-only.test.cjs': secretSentinel,
    '.env': secretSentinel,
    '.env.production': secretSentinel,
    '.data/projects.json': secretSentinel,
    '.git/config': secretSentinel,
    'node_modules/private/index.js': secretSentinel,
    'main.js': secretSentinel,
    'preload.js': secretSentinel,
    'dist/desktop.exe': secretSentinel,
    'frontend/.env': secretSentinel,
    'frontend/nested/.env.local': secretSentinel,
    'frontend/nested/node_modules/private.js': secretSentinel,
    'frontend/nested/.data/project.json': secretSentinel,
    'server/.env': secretSentinel,
    'server/nested/.env.production': secretSentinel,
    'server/nested/.data/sessions.json': secretSentinel,
    'server/nested/node_modules/private.js': secretSentinel,
    'server/nested/.git/config': secretSentinel,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, contents);
  }
  const remove = relative => {
    const target = path.resolve(sourceRoot, relative);
    assert.ok(target.startsWith(path.resolve(sourceRoot) + path.sep));
    fs.rmSync(target, {recursive: true});
  };
  return {sourceRoot, destination, files, remove};
}

function listFiles(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), {withFileTypes: true}).flatMap(entry => {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    return entry.isDirectory() ? listFiles(root, relative) : [relative];
  }).sort();
}

test('web handoff is independently runnable and includes editable sources without local credentials or desktop artifacts', t => {
  const f = fixture(t);
  assert.equal(createRelease({sourceRoot: f.sourceRoot, destination: f.destination}), f.destination);
  const read = relative => fs.readFileSync(path.join(f.destination, relative), 'utf8');
  const pkg = JSON.parse(read('package.json')), lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'schedule-gantt-web');
  assert.equal(pkg.version, '2.3.4');
  assert.equal(pkg.main, 'server.js');
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.equal(pkg.scripts.build, 'node scripts/build-frontend.cjs');
  assert.equal(pkg.scripts.prestart, 'node scripts/build-frontend.cjs');
  assert.equal(pkg.scripts.test, 'node --test test/*.test.cjs');
  assert.deepEqual(pkg.dependencies, {});
  assert.equal(Object.hasOwn(pkg, 'devDependencies'), false);
  assert.doesNotMatch(read('package.json'), /electron|desktopOnly/i);
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.deepEqual(lock.packages[''], {name: pkg.name, version: pkg.version, license: pkg.license, engines: pkg.engines});
  assert.deepEqual(Object.keys(lock.packages), ['']);

  const expectedSources = Object.keys(f.files).filter(relative =>
    (relative.startsWith('frontend/') || relative.startsWith('server/') ||
      ['server.js', 'project-validation.js', 'DEPLOYMENT.md', '.env.example', 'scripts/build-frontend.cjs',
        'test/server-api.test.cjs', 'test/shared-client.test.cjs', 'test/validation.test.cjs'].includes(relative)) &&
    f.files[relative] !== secretSentinel);
  for (const relative of expectedSources) assert.equal(read(relative), f.files[relative], `Complete source: ${relative}`);
  assert.match(read('index.html'), /Independent web fixture/);
  assert.match(read('index.html'), /const releaseFixture/);
  assert.match(read('README.md'), /DEPLOYMENT\.md/);
  assert.match(read('.gitignore'), /!\.env\.example/);
  const shipped = listFiles(f.destination);
  for (const relative of shipped) {
    assert.doesNotMatch(read(relative), new RegExp(secretSentinel), `Excluded private artifact: ${relative}`);
    assert.equal(relative.split('/').some(part => ['.data', '.git', 'node_modules'].includes(part)), false, relative);
    assert.equal(relative.split('/').some(part => part === '.env' || part.startsWith('.env.') && part !== '.env.example'), false, relative);
  }
  for (const relative of ['main.js', 'preload.js', 'dist/desktop.exe', 'test/desktop-only.test.cjs']) assert.equal(shipped.includes(relative), false);
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, '.env'), 'utf8'), secretSentinel, 'Source credentials stay untouched');
});

test('an existing destination is rejected without modifying its contents', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.destination, 'nested'), {recursive: true});
  fs.writeFileSync(path.join(f.destination, 'README.md'), 'Existing release');
  fs.writeFileSync(path.join(f.destination, 'nested', 'keep.txt'), 'Keep this file');
  assert.throws(() => createRelease({sourceRoot: f.sourceRoot, destination: f.destination}), /交付目录已存在/);
  assert.deepEqual(listFiles(f.destination), ['README.md', 'nested/keep.txt']);
  assert.equal(fs.readFileSync(path.join(f.destination, 'README.md'), 'utf8'), 'Existing release');
  assert.equal(fs.readFileSync(path.join(f.destination, 'nested', 'keep.txt'), 'utf8'), 'Keep this file');
});

for (const missing of ['DEPLOYMENT.md', '.env.example', 'project-validation.js', 'server.js', 'server',
  'scripts/build-frontend.cjs', 'frontend/components/workspace.html', 'package.json', 'test']) {
  test(`missing required input ${missing} never leaves a partial handoff directory`, t => {
    const f = fixture(t);
    f.remove(missing);
    assert.throws(() => createRelease({sourceRoot: f.sourceRoot, destination: f.destination}));
    assert.equal(fs.existsSync(f.destination), false, 'A failed release must not look ready for delivery');
  });
}
