import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFiles } from '../src/platform/files.js';

// A controllable IDB boundary: request success and transaction completion are
// deliberately separate, so a write cannot accidentally promise durability early.
function boundary() {
  const transactions = [];
  const db = {
    close() {},
    transaction() {
      const operations = [];
      const tx = {
        operations,
        objectStore() {
          return Object.fromEntries(['get', 'getAll', 'put', 'delete'].map(kind => [kind, value => {
            const request = { kind, value };
            operations.push(request);
            return request;
          }]));
        },
        abort() { this.aborted = true; queueMicrotask(() => this.onabort?.()); }
      };
      transactions.push(tx);
      return tx;
    }
  };
  const indexedDB = {
    open() {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess());
      return request;
    }
  };
  return { files: browserFiles(indexedDB), transactions };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('browser files resolve a write only after its transaction commits', async () => {
  const { files, transactions } = boundary();
  let done = false;
  const promise = files.write('documents/note.xml', new TextEncoder().encode('<document/>')).then(() => { done = true; });
  await settle();
  const tx = transactions[0];
  assert.equal(tx.operations[0].kind, 'put');
  assert.equal(tx.operations[0].value.name, 'documents/note.xml');
  tx.operations[0].onsuccess();
  await settle();
  assert.equal(done, false, 'a request that succeeded is not yet a commit');
  tx.oncomplete();
  await promise;
  assert.equal(done, true);
});

test('browser files report a transaction abort even after a request succeeded', async () => {
  const { files, transactions } = boundary();
  const rejection = assert.rejects(files.read('documents/note.xml'), /storage failure/);
  await settle();
  const tx = transactions[0];
  tx.operations[0].result = { name: 'documents/note.xml' };
  tx.operations[0].onsuccess();
  tx.error = new Error('storage failure');
  tx.abort();
  await rejection;
});

test('browser files say so when IndexedDB is unavailable', async () => {
  const files = browserFiles(undefined);
  await assert.rejects(files.list(), /IndexedDB is missing or blocked/);
  const status = await files.status();
  assert.equal(status.ok, false);
  assert.match(status.reason, /IndexedDB is missing or blocked/);
});
