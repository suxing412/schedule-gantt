'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createStore } = require('../server/storage.cjs');

const ID = '0123456789abcdef0123456789abcdef';
const OTHER = 'abcdef0123456789abcdef0123456789';
const DATE = '2026-10-10T10:00:00.000Z';

function record(changes = {}) {
  return {
    id: ID, revision: 1, createdAt: DATE, updatedAt: DATE, updatedBy: '张三',
    editCodeHash: 'scrypt$private-salt$private-hash',
    project: { tasks: [{ id: 'task-1', name: 'Prototype', s: '2026-10-10', e: '2026-10-12' }] },
    ...changes
  };
}

async function directory(t) {
  const root = await fs.realpath(os.tmpdir());
  const location = await fs.mkdtemp(path.join(root, 'schedule-storage-test-'));
  t.after(async () => {
    const relative = path.relative(root, location);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(location, { recursive: true, force: true });
  });
  return location;
}

async function fileStore(t) {
  const dataDir = await directory(t);
  return { dataDir, store: await createStore({ driver: 'file', dataDir }) };
}

async function externalStore(t, code, config = {}) {
  const folder = await directory(t);
  const filename = path.join(folder, 'adapter.cjs');
  await fs.writeFile(filename, code, 'utf8');
  const store = await createStore({ ...config, driver: 'external', adapterModule: filename });
  t.after(() => { delete require.cache[filename]; });
  return { store, adapter: require(filename), filename };
}

const memoryAdapter = `
const records = new Map();
const state = { records, closed: false, config: null };
module.exports = { state, async createStore(config) {
  state.config = config;
  return {
    get: async id => records.get(id) || null,
    create: async record => { if (records.has(record.id)) return false; records.set(record.id, record); return true; },
    compareAndSwap: async (id, revision, next) => {
      if (records.get(id)?.revision !== revision) return false;
      records.set(id, next); return true;
    },
    close: async () => { state.closed = true; }
  };
} };
`;

test('file storage persists complete private records across reopening and clones caller data', async t => {
  const { dataDir, store } = await fileStore(t);
  assert.equal(await store.get(ID), null);
  const input = record();
  const create = store.create(input);
  input.project.tasks[0].name = 'Changed after create';
  assert.equal(await create, true);
  const result = await store.get(ID);
  assert.equal(result.project.tasks[0].name, 'Prototype');
  assert.equal(result.editCodeHash, record().editCodeHash);
  result.project.tasks[0].name = 'Changed after get';
  await store.close();
  const reopened = await createStore({ driver: 'file', dataDir });
  assert.deepEqual(await reopened.get(ID), record());
  assert.deepEqual(await fs.readdir(dataDir), [ID + '.json']);
});

test('file storage atomically rejects duplicate creation across store instances', async t => {
  const { dataDir, store } = await fileStore(t);
  const second = await createStore({ driver: 'file', dataDir: path.join(dataDir, '.') });
  const results = await Promise.all(Array.from({ length: 20 }, (_, n) =>
    (n % 2 ? store : second).create(record({ updatedBy: String(n) }))));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await store.get(ID)).updatedBy, String(results.indexOf(true)));
});

test('compareAndSwap allows exactly one concurrent writer and leaves winner data intact', async t => {
  const { dataDir, store } = await fileStore(t);
  const second = await createStore({ driver: 'file', dataDir });
  await store.create(record());
  const results = await Promise.all(Array.from({ length: 24 }, (_, n) =>
    (n % 2 ? store : second).compareAndSwap(ID, 1, record({ revision: 2, updatedBy: String(n) }))));
  assert.equal(results.filter(Boolean).length, 1);
  const saved = await store.get(ID);
  assert.equal(saved.revision, 2);
  assert.equal(saved.updatedBy, String(results.indexOf(true)));
  assert.equal(await second.compareAndSwap(ID, 1, record({ revision: 2 })), false);
  assert.equal(await second.compareAndSwap(OTHER, 1, record({ id: OTHER, revision: 2 })), false);
  assert.deepEqual(await second.get(ID), saved);
});

test('CAS takes a snapshot before asynchronous IO and saves all committed revisions', async t => {
  const { store } = await fileStore(t);
  await store.create(record());
  const next = record({ revision: 2 });
  const update = store.compareAndSwap(ID, 1, next);
  next.project.tasks[0].name = 'Mutated draft';
  assert.equal(await update, true);
  assert.equal((await store.get(ID)).project.tasks[0].name, 'Prototype');
  assert.equal(await store.compareAndSwap(ID, 2, record({ revision: 3, updatedBy: '李四' })), true);
  assert.equal((await store.get(ID)).revision, 3);
});

test('corrupt JSON blocks reads, creation and CAS without leaking or overwriting private contents', async t => {
  const { dataDir, store } = await fileStore(t);
  const filename = path.join(dataDir, ID + '.json');
  const damaged = '{"editCodeHash":"a-private-secret", broken';
  await fs.writeFile(filename, damaged, 'utf8');
  const damagedError = error => {
    assert.equal(error.code, 'STORE_CORRUPT_RECORD');
    assert.doesNotMatch(error.message, /a-private-secret|broken/);
    return true;
  };
  await assert.rejects(store.get(ID), damagedError);
  await assert.rejects(store.create(record()), damagedError);
  await assert.rejects(store.compareAndSwap(ID, 1, record({ revision: 2 })), damagedError);
  assert.equal(await fs.readFile(filename, 'utf8'), damaged);
  // A rejected operation must not poison the shared directory queue.
  assert.equal(await store.create(record({ id: OTHER })), true);
});

test('wrong record identity or malformed metadata on disk is corruption, not a missing record', async t => {
  const { dataDir, store } = await fileStore(t);
  for (const value of [record({ id: OTHER }), record({ revision: 0 }), { id: ID, revision: 1 }, null]) {
    const text = JSON.stringify(value);
    await fs.writeFile(path.join(dataDir, ID + '.json'), text, 'utf8');
    await assert.rejects(store.get(ID), { code: 'STORE_CORRUPT_RECORD' });
    await assert.rejects(store.create(record()), { code: 'STORE_CORRUPT_RECORD' });
    assert.equal(await fs.readFile(path.join(dataDir, ID + '.json'), 'utf8'), text);
  }
});

test('all storage entry points reject traversal and noncanonical IDs before filesystem access', async t => {
  const { dataDir, store } = await fileStore(t);
  for (const id of ['../outside', '..\\outside', 'f'.repeat(33), 'A'.repeat(32), 'a'.repeat(31), '', null, 17]) {
    await assert.rejects(store.get(id), { code: 'STORE_INVALID_ID' });
    await assert.rejects(store.create(record({ id })), { code: 'STORE_INVALID_ID' });
    await assert.rejects(store.compareAndSwap(id, 1, record({ id, revision: 2 })), { code: 'STORE_INVALID_ID' });
  }
  assert.deepEqual(await fs.readdir(dataDir), []);
});

test('invalid record revisions, identities and non-JSON data cannot overwrite a project', async t => {
  const { store } = await fileStore(t);
  await store.create(record());
  for (const revision of [0, -1, 1.2, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.compareAndSwap(ID, revision, record({ revision: 2 })), { code: 'STORE_INVALID_RECORD' });
  }
  for (const next of [record({ id: OTHER, revision: 2 }), record({ revision: 3 }), record({ updatedAt: 'bad' }), record({ project: null })]) {
    await assert.rejects(store.compareAndSwap(ID, 1, next), { code: 'STORE_INVALID_RECORD' });
  }
  const circular = record();
  circular.project.self = circular;
  await assert.rejects(store.create(circular), { code: 'STORE_INVALID_RECORD' });
  assert.deepEqual(await store.get(ID), record());
});

test('file store creates nested directories and does not treat IO errors as a missing record', async t => {
  const base = await directory(t);
  const dataDir = path.join(base, 'nested', 'data');
  const store = await createStore({ driver: 'file', dataDir });
  await store.create(record());
  // A directory in place of another record is an IO error, never an overwrite target.
  await fs.mkdir(path.join(dataDir, OTHER + '.json'));
  await assert.rejects(store.create(record({ id: OTHER })));
  assert.deepEqual(await store.get(ID), record());
  assert.ok((await fs.readdir(dataDir)).every(name => !name.endsWith('.tmp')));
});

test('failed atomic replacement preserves committed data and cleans temporary files', async t => {
  const { dataDir, store } = await fileStore(t);
  await store.create(record());
  const rename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('simulated rename failure'), { code: 'EACCES' }); };
  try {
    await assert.rejects(store.compareAndSwap(ID, 1, record({ revision: 2 })), { code: 'EACCES' });
  } finally {
    fs.rename = rename;
  }
  assert.deepEqual(await store.get(ID), record());
  assert.deepEqual(await fs.readdir(dataDir), [ID + '.json']);
  assert.equal(await store.compareAndSwap(ID, 1, record({ revision: 2 })), true);
});

test('configuration never silently falls back to file or in-memory storage', async () => {
  for (const config of [{}, { driver: 'memory' }, { driver: 'file' }, { driver: 'file', dataDir: ' ' }, { driver: 'external' }]) {
    await assert.rejects(createStore(config), { code: 'STORE_CONFIG' });
  }
});

test('external adapter receives config, private records, isolated values and close calls', async t => {
  const { store, adapter, filename } = await externalStore(t, memoryAdapter, { cloudEnvironment: 'development' });
  assert.equal(adapter.state.config.cloudEnvironment, 'development');
  assert.equal(adapter.state.config.adapterModule, filename);
  assert.equal(await store.get(ID), null);
  const input = record();
  assert.equal(await store.create(input), true);
  input.project.tasks[0].name = 'Changed';
  const result = await store.get(ID);
  assert.deepEqual(result, record());
  result.project.tasks[0].name = 'Also changed';
  assert.deepEqual(adapter.state.records.get(ID), record());
  assert.equal(await store.create(record()), false);
  assert.equal(await store.compareAndSwap(ID, 1, record({ revision: 2 })), true);
  assert.equal(await store.compareAndSwap(ID, 1, record({ revision: 2 })), false);
  await store.close();
  assert.equal(adapter.state.closed, true);
});

test('external adapter module paths may be relative to process.cwd()', async t => {
  const { filename } = await externalStore(t, memoryAdapter);
  const store = await createStore({ driver: 'external', adapterModule: path.relative(process.cwd(), filename) });
  assert.equal(await store.create(record()), true);
  assert.deepEqual(await store.get(ID), record());
});

test('external adapter factory and method contract must be complete', async t => {
  const base = await directory(t);
  const invalid = ['module.exports = {};', 'exports.createStore = () => null;',
    'exports.createStore = () => ({get(){}, create(){}});',
    'exports.createStore = () => ({get(){}, create(){}, compareAndSwap(){}, close: true});'];
  for (let index = 0; index < invalid.length; index++) {
    const filename = path.join(base, index + '.cjs');
    await fs.writeFile(filename, invalid[index], 'utf8');
    await assert.rejects(createStore({ driver: 'external', adapterModule: filename }), { code: 'STORE_ADAPTER' });
    delete require.cache[filename];
  }
  await assert.rejects(createStore({ driver: 'external', adapterModule: path.join(base, 'missing.cjs') }), { code: 'MODULE_NOT_FOUND' });
});

test('malformed external results and invalid caller IDs fail without a success fallback', async t => {
  const { store, adapter } = await externalStore(t, memoryAdapter);
  adapter.state.records.set(ID, { id: ID });
  await assert.rejects(store.get(ID), { code: 'STORE_ADAPTER' });
  adapter.state.records.set(ID, record({ id: OTHER }));
  await assert.rejects(store.get(ID), { code: 'STORE_ADAPTER' });
  await assert.rejects(store.get('../unsafe'), { code: 'STORE_INVALID_ID' });
  const malformed = await externalStore(t, 'exports.createStore = () => ({ get: async () => undefined, create: async () => 1, compareAndSwap: async () => ({ok:true}) });');
  await assert.rejects(malformed.store.get(ID), { code: 'STORE_ADAPTER' });
  await assert.rejects(malformed.store.create(record()), { code: 'STORE_ADAPTER' });
  await assert.rejects(malformed.store.compareAndSwap(ID, 1, record({ revision: 2 })), { code: 'STORE_ADAPTER' });
});

test('external adapter errors propagate and the provided cloud template refuses to start', async t => {
  const { store } = await externalStore(t, 'exports.createStore = () => ({ get: async () => { throw new Error("database unavailable"); }, create: async () => { throw new Error("database unavailable"); }, compareAndSwap: async () => { throw new Error("database unavailable"); } });');
  await assert.rejects(store.get(ID), /database unavailable/);
  await assert.rejects(store.create(record()), /database unavailable/);
  await assert.rejects(store.compareAndSwap(ID, 1, record({ revision: 2 })), /database unavailable/);
  await assert.rejects(createStore({ driver: 'external', adapterModule: path.join(__dirname, '..', 'server', 'adapters', 'cloud.example.cjs') }), /Cloud storage is not connected/);
});
