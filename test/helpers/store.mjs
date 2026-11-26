import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../dist/service/store.js';

export function tempDirectory(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'shadowbot-host-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export function storeFixture(t, publish = () => {}) {
  const root = tempDirectory(t);
  const path = join(root, 'active.db');
  const db = new DatabaseSync(path);
  db.exec(readFileSync('contract/schema.sql', 'utf8'));
  db.close();
  const store = new Store(path, join(root, 'adapter.db'), publish);
  t.after(() => store.db.close());
  return { root, store, session: store.create(root, root, {}) };
}
