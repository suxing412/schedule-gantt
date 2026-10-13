'use strict';

// This is an integration template, NOT an operational cloud adapter.
// Implement against the cloud database selected during deployment. Do not replace
// durable storage with process memory or browser localStorage in production.
// The complete contract and record schema are in ../ADAPTER-CONTRACT.md.
async function createStore(config) {
  // TODO: Initialize the server-side cloud SDK using deployment credentials.
  // TODO: Return { get(id), create(record), compareAndSwap(id, revision, next), close? }.
  // get must return the complete private record or null.
  // create must use an atomic unique-ID insert (existing ID => false).
  // compareAndSwap must atomically match both id and revision and write next
  // (missing ID or mismatched revision => false). Use a transaction or a
  // conditional database update, never an unprotected get-then-write sequence.
  // Do not log project contents, editCodeHash, access codes, or credentials.
  void config;
  throw new Error('Cloud storage is not connected. Implement server/adapters/cloud.example.cjs against your cloud database and configure STORAGE_ADAPTER_MODULE to use it.');
}

module.exports = { createStore };
