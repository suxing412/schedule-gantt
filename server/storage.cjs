'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const ID = /^[a-f0-9]{32}$/;
// Shared by every store in this Node process, including stores opened on the same directory.
// File storage is deliberately a single-process development adapter, not a distributed database.
const directoryQueues = new Map();

class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

function requireId(id) {
  if (typeof id !== 'string' || !ID.test(id)) {
    throw new StorageError('STORE_INVALID_ID', 'Project ID must contain exactly 32 lowercase hexadecimal characters.');
  }
  return id;
}

function requireRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new StorageError('STORE_INVALID_RECORD', 'Project revision must be a positive safe integer.');
  }
}

function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
}

function copyRecord(record, expectedId) {
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(record));
  } catch {
    throw new StorageError('STORE_INVALID_RECORD', 'Project record must be JSON serializable.');
  }
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
    throw new StorageError('STORE_INVALID_RECORD', 'Project record must be an object.');
  }
  requireId(copy.id);
  requireRevision(copy.revision);
  if ((expectedId !== undefined && copy.id !== expectedId) ||
      !copy.project || typeof copy.project !== 'object' || Array.isArray(copy.project) ||
      !isIsoDate(copy.createdAt) || !isIsoDate(copy.updatedAt) ||
      typeof copy.updatedBy !== 'string' ||
      typeof copy.editCodeHash !== 'string' || copy.editCodeHash.length === 0) {
    throw new StorageError('STORE_INVALID_RECORD', 'Project record has missing or invalid metadata.');
  }
  return copy;
}

function copyNext(id, revision, record) {
  requireId(id);
  requireRevision(revision);
  const next = copyRecord(record, id);
  if (next.revision !== revision + 1) {
    throw new StorageError('STORE_INVALID_RECORD', 'The next project revision must increase by exactly one.');
  }
  return next;
}

function serialize(directory, operation) {
  const previous = directoryQueues.get(directory) || Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  directoryQueues.set(directory, settled);
  settled.then(() => {
    if (directoryQueues.get(directory) === settled) directoryQueues.delete(directory);
  });
  return result;
}

async function createFileStore(config) {
  if (typeof config.dataDir !== 'string' || !config.dataDir.trim()) {
    throw new StorageError('STORE_CONFIG', 'File storage requires a dataDir directory.');
  }
  await fs.mkdir(path.resolve(config.dataDir), { recursive: true, mode: 0o700 });
  // Resolve aliases before selecting the queue, so two stores cannot bypass the same lock.
  let directory = await fs.realpath(path.resolve(config.dataDir));
  const queueKey = process.platform === 'win32' ? directory.toLowerCase() : directory;

  async function read(id) {
    let contents;
    try {
      contents = await fs.readFile(path.join(directory, id + '.json'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return copyRecord(JSON.parse(contents), id);
    } catch {
      // Never include the source JSON or parser message: records contain private hashes.
      throw new StorageError('STORE_CORRUPT_RECORD', 'Stored project data is damaged. Restore it before writing this project.');
    }
  }

  async function write(record) {
    const temporary = path.join(directory, '.' + record.id + '.' + randomBytes(12).toString('hex') + '.tmp');
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, path.join(directory, record.id + '.json'));
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  return {
    async get(id) {
      requireId(id);
      return serialize(queueKey, () => read(id));
    },
    async create(record) {
      const copy = copyRecord(record);
      return serialize(queueKey, async () => {
        if (await read(copy.id)) return false;
        await write(copy);
        return true;
      });
    },
    async compareAndSwap(id, expectedRevision, nextRecord) {
      const next = copyNext(id, expectedRevision, nextRecord);
      return serialize(queueKey, async () => {
        const previous = await read(id);
        if (!previous || previous.revision !== expectedRevision) return false;
        await write(next);
        return true;
      });
    },
    async close() {}
  };
}

async function createExternalStore(config) {
  if (typeof config.adapterModule !== 'string' || !config.adapterModule.trim()) {
    throw new StorageError('STORE_CONFIG', 'External storage requires an adapterModule path.');
  }
  const filename = path.resolve(config.adapterModule);
  const exported = require(filename);
  if (!exported || typeof exported.createStore !== 'function') {
    throw new StorageError('STORE_ADAPTER', 'The storage adapter must export createStore(config).');
  }
  const adapter = await exported.createStore({ ...config });
  if (!adapter || !['get', 'create', 'compareAndSwap'].every(method => typeof adapter[method] === 'function') ||
      (adapter.close !== undefined && typeof adapter.close !== 'function')) {
    throw new StorageError('STORE_ADAPTER', 'The storage adapter must implement get, create, compareAndSwap, and an optional close method.');
  }
  async function booleanResult(operation) {
    const value = await operation;
    if (typeof value !== 'boolean') {
      throw new StorageError('STORE_ADAPTER', 'The storage adapter must return a boolean from create and compareAndSwap.');
    }
    return value;
  }
  return {
    async get(id) {
      requireId(id);
      const record = await adapter.get(id);
      if (record === null) return null;
      try { return copyRecord(record, id); }
      catch { throw new StorageError('STORE_ADAPTER', 'The storage adapter returned an invalid project record.'); }
    },
    async create(record) {
      return booleanResult(adapter.create(copyRecord(record)));
    },
    async compareAndSwap(id, expectedRevision, nextRecord) {
      return booleanResult(adapter.compareAndSwap(id, expectedRevision, copyNext(id, expectedRevision, nextRecord)));
    },
    async close() { if (adapter.close) await adapter.close(); }
  };
}

async function createStore(config = {}) {
  if (config.driver === 'file') return createFileStore(config);
  if (config.driver === 'external') return createExternalStore(config);
  throw new StorageError('STORE_CONFIG', 'Storage driver must be file or external.');
}

module.exports = { createStore, StorageError };
