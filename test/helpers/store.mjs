import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../dist/service/store.js';

function createTempDirectory() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'shadowbot-host-')));
}

export function tempDirectory(t) {
  const root = createTempDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export function storeFixture(t, publish = () => {}) {
  const root = createTempDirectory();
  let store;
  // node:test runs after-hooks in registration order. Windows cannot remove an open
  // SQLite file, so one hook closes the store before it removes the directory.
  t.after(() => {
    try { store?.db.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const path = join(root, 'active.db');
  const db = new DatabaseSync(path);
  db.exec(readFileSync('contract/schema.sql', 'utf8'));
  db.close();
  store = new Store(path, join(root, 'adapter.db'), publish);
  return { root, store, session: store.create(root, root, {}) };
}
