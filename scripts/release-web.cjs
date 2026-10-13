'use strict';

// Build a standalone web handoff without desktop binaries, credentials or local data.
const fs = require('node:fs');
const path = require('node:path');
const {buildFrontend} = require('./build-frontend.cjs');
const root = path.resolve(__dirname, '..');

function createRelease({sourceRoot = root, destination} = {}) {
  buildFrontend({root: sourceRoot});
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const target = path.resolve(destination || path.join(sourceRoot, 'release', 'schedule-gantt-web-' + stamp));
  if (fs.existsSync(target)) throw new Error('交付目录已存在，请指定新的空目录：' + target);
  // Copy from an explicit source allowlist. Never copy .env, .data, .git or node_modules.
  const files = ['index.html', 'project-validation.js', 'DEPLOYMENT.md', '.env.example'];
  const trees = ['frontend', 'server'];
  for (const item of [...files, ...trees, 'server.js', 'scripts/build-frontend.cjs']) {
    if (!fs.existsSync(path.join(sourceRoot, item))) throw new Error('缺少交付文件：' + item);
  }
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const testFiles = fs.readdirSync(path.join(sourceRoot, 'test')).filter(name => /^(server-.*|shared.*|validation)\.test\.cjs$/.test(name));
  fs.mkdirSync(target, {recursive: true});
  const copyFile = relative => {
    const output = path.join(target, relative);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.copyFileSync(path.join(sourceRoot, relative), output);
  };
  for (const file of [...files, 'server.js', 'scripts/build-frontend.cjs']) copyFile(file);
  for (const tree of trees) {
    fs.cpSync(path.join(sourceRoot, tree), path.join(target, tree), {
      recursive: true,
      filter: source => {
        if (fs.lstatSync(source).isSymbolicLink()) throw new Error('交付源码中不允许符号链接：' + source);
        const name = path.basename(source);
        return name !== 'node_modules' && name !== '.data' && name !== '.env' && !name.startsWith('.env.') && name !== '.git';
      }
    });
  }
  const pkg = {
    name: 'schedule-gantt-web', version: sourcePackage.version, private: true,
    description: '共享排期工具：单端口 Node.js 服务，支持外接云数据库',
    main: 'server.js', engines: {node: '>=22'}, license: 'MIT',
    scripts: {build: 'node scripts/build-frontend.cjs', prestart: 'node scripts/build-frontend.cjs', start: 'node server.js', test: 'node --test test/*.test.cjs'},
    dependencies: {}
  };
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(target, 'package-lock.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
    packages: {'': {name: pkg.name, version: pkg.version, license: pkg.license, engines: pkg.engines}}
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(target, 'test'));
  for (const file of testFiles) copyFile('test/' + file);
  fs.writeFileSync(path.join(target, '.gitignore'), 'node_modules/\n.data/\n.env\n.env.*\n!.env.example\n');
  fs.writeFileSync(path.join(target, 'README.md'), [
    '# 共享排期网页 · 部署交付', '',
    'Node.js 22+，单端口 HTTP 服务。运行 `npm start`，打开 http://localhost:3000。无需 Electron，无第三方运行依赖。', '',
    '**本地默认使用开发文件存储；云数据库适配器尚需部署方接入。** 生产模式要求真实的外部适配器与会话密钥，未配置时拒绝启动。', '',
    '完整启动、环境变量、部署与验收步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。',
    '云端表结构和事务接口见 [server/ADAPTER-CONTRACT.md](server/ADAPTER-CONTRACT.md)。',
    '适配器模板见 [server/adapters/cloud.example.cjs](server/adapters/cloud.example.cjs)。', '',
    '源码在 frontend/，修改后运行 `npm run build`。测试运行 `npm test`。', ''
  ].join('\n'));
  return target;
}

module.exports = {createRelease};
if (require.main === module) {
  try { console.log('网页交付目录：' + createRelease({destination: process.argv[2]})); }
  catch (error) { console.error('交付失败：' + error.message); process.exitCode = 1; }
}
