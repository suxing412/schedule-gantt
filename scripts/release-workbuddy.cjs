'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {buildFrontend} = require('./build-frontend.cjs');
const {verifyVendor} = require('./vendor-workbuddy-sdk.cjs');
const root = path.resolve(__dirname, '..');
const REQUIRED_CLOUD_FILES = [
  'cloud/migrations/001_schedule_rpc.sql', 'cloud/migrations/002_collab_external.sql', 'cloud/migrations/003_tool_actions.sql',
  'cloud/ai/http.cjs', 'cloud/ai/mcp.cjs', 'cloud/ai/operations.cjs', 'cloud/ai/operation-definitions.cjs',
  'cloud/ai/operation-definitions.json', 'cloud/ai/read-tools.cjs', 'frontend/scripts/project.js',
  'cloud/HANDOFF-PROMPT.md', 'cloud/AI-TOOLS.md', 'cloud/RPC.md', 'cloud/VALIDATION.md',
  'examples/全功能示例排期_星火行动.json'
];

function rootDocument(contents) {
  // A cloud/ document copied to the package root keeps valid relative links.
  return contents.replace(/\]\((?![a-z][a-z\d+.-]*:|#|\/)([^)\s]+)\)/gi, '](cloud/$1)');
}

function collectTree(sourceRoot, relative, output) {
  for (const entry of fs.readdirSync(path.join(sourceRoot, relative), {withFileTypes: true})) {
    if (entry.name.startsWith('.') || ['node_modules', 'release', 'dist'].includes(entry.name)) continue;
    const item = relative + '/' + entry.name;
    if (entry.isSymbolicLink()) throw new Error('交付源码中不允许符号链接：' + item);
    if (entry.isDirectory()) collectTree(sourceRoot, item, output);
    else if (/\.(?:c?js|json|css|html|svg|txt|md|sql|png|jpe?g|webp|ico)$/i.test(entry.name)) output.push(item);
  }
}

function createRelease({sourceRoot = root, destination} = {}) {
  sourceRoot = path.resolve(sourceRoot);
  const target = path.resolve(destination || path.join(sourceRoot, 'release', 'schedule-gantt-workbuddy'));
  if (fs.existsSync(target)) throw new Error('交付目录已存在，请指定新的空目录：' + target);
  verifyVendor(sourceRoot);
  buildFrontend({root: sourceRoot});
  const files = ['LICENSE', 'index.html', 'project-validation.js', 'cloud/serve.cjs', 'cloud/DEPLOYMENT.md', 'cloud/README.md', 'scripts/build-frontend.cjs', 'scripts/vendor-workbuddy-sdk.cjs'];
  for (const required of [...files, ...REQUIRED_CLOUD_FILES, 'cloud/tests', 'package.json', 'test']) {
    const filename = path.join(sourceRoot, required);
    if (!fs.existsSync(filename)) throw new Error('缺少交付文件：' + required);
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('交付源码中不允许符号链接：' + required);
  }
  for (const tree of ['frontend', 'cloud/migrations', 'cloud/tests', 'cloud/ai', 'examples']) {
    if (fs.existsSync(path.join(sourceRoot, tree))) collectTree(sourceRoot, tree, files);
  }
  const cloudDocs = fs.readdirSync(path.join(sourceRoot, 'cloud')).filter(name => /\.md$/.test(name));
  for (const name of cloudDocs) if (!files.includes('cloud/' + name)) files.push('cloud/' + name);
  const tests = ['cloud-transport.test.cjs', 'workbuddy-client.test.cjs', 'shared-client.test.cjs', 'validation.test.cjs', 'ai-operations.test.cjs', 'ai-read-tools.test.cjs', 'ai-http.test.cjs', 'ai-mcp.test.cjs', 'browser-tools.test.cjs', 'task-highlights.test.cjs', 'timeline-zoom.test.cjs', 'bar-geometry.test.cjs', 'workbuddy-api-server.test.cjs'].filter(name => fs.existsSync(path.join(sourceRoot, 'test', name)));
  for (const name of tests) files.push('test/' + name);
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const pkg = {
    name: 'schedule-gantt-workbuddy', version: sourcePackage.version, private: true,
    description: 'WorkBuddy 共享排期：前端、私有数据库 RPC 与 AI 工具 API，单端口服务',
    main: 'cloud/serve.cjs', engines: {node: '>=22'}, license: 'MIT',
    scripts: {start: 'node cloud/serve.cjs', build: 'node scripts/build-frontend.cjs', 'ai:mcp': 'node cloud/ai/mcp.cjs', 'check:sdk': 'node scripts/vendor-workbuddy-sdk.cjs --check', 'check:workbuddy-sdk': 'node scripts/vendor-workbuddy-sdk.cjs --check', test: 'node --test test/*.test.cjs'}, dependencies: {}
  };
  // Preflight all source files before creating the final handoff directory.
  for (const relative of files) {
    const filename = path.join(sourceRoot, relative);
    if (fs.lstatSync(filename).isSymbolicLink() || !fs.statSync(filename).isFile()) throw new Error('无效交付源文件：' + relative);
  }
  fs.mkdirSync(target, {recursive: true});
  for (const relative of files) {
    const output = path.join(target, relative);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.copyFileSync(path.join(sourceRoot, relative), output);
  }
  for (const name of ['README.md', 'DEPLOYMENT.md', 'HANDOFF-PROMPT.md']) {
    fs.writeFileSync(path.join(target, name), rootDocument(fs.readFileSync(path.join(sourceRoot, 'cloud', name), 'utf8')));
  }
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(target, 'package-lock.json'), JSON.stringify({name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: {'': {name: pkg.name, version: pkg.version, license: pkg.license, engines: pkg.engines}}}, null, 2) + '\n');
  fs.writeFileSync(path.join(target, '.env.example'), ['NODE_ENV=production', 'HOST=0.0.0.0', 'PORT=3000', '# Required for HTTP AI tools: trusted WorkBuddy cloud endpoint.', '# The browser alone can use its own origin when this is omitted.', 'WORKBUDDY_ENDPOINT=', '# Inject platform publicConfig.publishableKey in deployment environment.', 'WORKBUDDY_PUBLISHABLE_KEY=', ''].join('\n'));
  fs.writeFileSync(path.join(target, '.gitignore'), 'node_modules/\n.env\n.env.*\n!.env.example\n');
  return target;
}

module.exports = {createRelease};
if (require.main === module) {
  try { console.log('WorkBuddy 交付目录：' + createRelease({destination: process.argv[2]})); }
  catch (error) { console.error('交付失败：' + error.message); process.exitCode = 1; }
}
