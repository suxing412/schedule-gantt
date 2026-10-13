'use strict';

// Reproducible browser dependency: pin the official npm archive and verify SRI
// before copying only the SDK's browser bundle and its complete license notices.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const ROOT = path.resolve(__dirname, '..');
const VERSION = '0.1.3';
const URL = 'https://registry.npmjs.org/@tencent-ai/workbuddy-cloud-sdk/-/workbuddy-cloud-sdk-' + VERSION + '.tgz';
const INTEGRITY = 'sha512-hKWPy+2Dt/NcSA40J+4l4ILu7tVLEeiv2bQaCIl/po0mDwQHxDHrcxcs/uvv4HzWGM8RYpVRgSd1M8HGLi+WNQ==';
const FILES = {
  'package/lib/index.global.js': 'workbuddy-sdk.js',
  'package/LICENSE': 'workbuddy-sdk.LICENSE.txt',
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function readEntries(archive) {
  if (archive.length > 8 * 1024 * 1024) throw new Error('SDK archive exceeds size limit');
  const actual = 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64');
  if (actual !== INTEGRITY) throw new Error('WorkBuddy SDK archive integrity mismatch');
  const tar = zlib.gunzipSync(archive, {maxOutputLength: 16 * 1024 * 1024});
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const name = [string(345, 155), string(0, 100)].filter(Boolean).join('/');
    const rawSize = string(124, 12).trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('Invalid SDK tar entry size');
    const size = Number.parseInt(rawSize, 8);
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length) throw new Error('Truncated SDK archive');
    if (Object.hasOwn(FILES, name)) {
      if (entries.has(name) || ![0, 48].includes(header[156])) throw new Error('Invalid SDK archive entry');
      entries.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (entries.size !== Object.keys(FILES).length) throw new Error('Required SDK files missing');
  return entries;
}

function verifyVendor(root = ROOT) {
  const dir = path.join(root, 'frontend', 'assets');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'workbuddy-sdk.manifest.json'), 'utf8'));
  if (manifest.version !== VERSION || manifest.integrity !== INTEGRITY || manifest.source !== URL) throw new Error('Unexpected SDK manifest');
  for (const name of Object.values(FILES)) {
    const contents = fs.readFileSync(path.join(dir, name));
    if (manifest.files?.[name]?.sha256 !== sha256(contents)) throw new Error('SDK file checksum mismatch: ' + name);
  }
  return manifest;
}

async function vendor({root = ROOT, archivePath} = {}) {
  let archive;
  if (archivePath) archive = fs.readFileSync(archivePath);
  else {
    const response = await fetch(URL, {signal: AbortSignal.timeout(30000), redirect: 'error'});
    if (!response.ok) throw new Error('SDK download failed: HTTP ' + response.status);
    archive = Buffer.from(await response.arrayBuffer());
  }
  const entries = readEntries(archive);
  const dir = path.join(root, 'frontend', 'assets');
  const manifest = {name: '@tencent-ai/workbuddy-cloud-sdk', version: VERSION, source: URL, integrity: INTEGRITY, license: 'MIT', browserGlobal: 'WorkBuddyCloud', files: {}};
  fs.mkdirSync(dir, {recursive: true});
  for (const [entry, name] of Object.entries(FILES)) {
    const content = entries.get(entry);
    fs.writeFileSync(path.join(dir, name), content);
    manifest.files[name] = {bytes: content.length, sha256: sha256(content)};
  }
  fs.writeFileSync(path.join(dir, 'workbuddy-sdk.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return verifyVendor(root);
}

module.exports = {vendor, verifyVendor, readEntries};
if (require.main === module) {
  const argv = process.argv.slice(2), archiveIndex = argv.indexOf('--archive');
  Promise.resolve().then(() => argv.includes('--check') ? verifyVendor() : vendor({archivePath: archiveIndex >= 0 ? argv[archiveIndex + 1] : undefined}))
    .then(manifest => console.log('Verified WorkBuddy SDK ' + manifest.version))
    .catch(error => {console.error(error.message); process.exitCode = 1;});
}
