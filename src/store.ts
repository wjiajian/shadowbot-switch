import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AssistantMessage, Message, Part, Session, ToolPart } from '@opencode-ai/sdk/v2';
import { protocolVersion } from './installation.js';

type Json = Record<string, unknown>;
export type Frame = { id: string; type: string; properties: Json };
type Row = { id: string; data: string };
type MessageRow = Row & { time_created: number; session_id: string };
type PartRow = Row & { message_id: string; session_id: string };
export type Meta = {
  id: string; root: string; session: string; native_file: string | null; native_leaf: string | null;
  running: number; owner_pid: number; sequence: number; revert_leaf: string | null; cutoff: string | null;
};

export function databaseBusy(error: unknown) {
  if (!(error instanceof Error)) return false;
  const { code, errcode } = error as Error & { code?: string; errcode?: number };
  return code === 'ERR_SQLITE_ERROR' && errcode !== undefined && [5, 6].includes(errcode & 0xff);
}

let previousTime = 0;
let counter = 0;
export function id(prefix: 'ses' | 'msg' | 'prt' | 'per' | 'que' | 'evt') {
  const time = Math.max(previousTime, Date.now());
  counter = time === previousTime ? counter + 1 : 0;
  previousTime = time;
  return `${prefix}_${time.toString(16).padStart(11, '0')}${counter.toString(16).padStart(5, '0')}${randomBytes(5).toString('hex')}`;
}

export function failure(message: string, aborted = false): AssistantMessage['error'] {
  return { name: aborted ? 'MessageAbortedError' : 'UnknownError', data: { message } };
}

function message(row: MessageRow): Message {
  return { ...JSON.parse(row.data), id: row.id, sessionID: row.session_id };
}

function part(row: PartRow): Part {
  return { ...JSON.parse(row.data), id: row.id, sessionID: row.session_id, messageID: row.message_id };
}

export class Store {
  readonly db: DatabaseSync;
  private publish: (frame: Frame, directory: string, root: string) => void;

  constructor(database: string, adapter: string, publish: (frame: Frame, directory: string, root: string) => void) {
    this.publish = publish;
    mkdirSync(dirname(adapter), { recursive: true });
    this.db = new DatabaseSync(database, { timeout: 3000, enableForeignKeyConstraints: true });
    this.db.prepare('ATTACH DATABASE ? AS adapter').run(adapter);
    this.db.exec(`
      PRAGMA main.journal_mode=DELETE;
      PRAGMA adapter.journal_mode=DELETE;
      PRAGMA main.synchronous=FULL;
      PRAGMA adapter.synchronous=FULL;
      CREATE TABLE IF NOT EXISTS adapter.session (
        id TEXT PRIMARY KEY, root TEXT NOT NULL, session TEXT NOT NULL, native_file TEXT, native_leaf TEXT,
        running INTEGER NOT NULL DEFAULT 0, owner_pid INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER NOT NULL DEFAULT 0, revert_leaf TEXT, cutoff TEXT
      );
      CREATE TABLE IF NOT EXISTS adapter.message_map (
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, native_entry TEXT NOT NULL, PRIMARY KEY (session_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS adapter.removed_message (
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, PRIMARY KEY (session_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS adapter.tool_map (
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL, part_id TEXT NOT NULL, PRIMARY KEY (session_id, call_id)
      );
    `);
    // Preserve existing Pi transcripts while giving the shared projection neutral columns.
    const migrations = [['session', 'pi_file', 'native_file'], ['session', 'pi_leaf', 'native_leaf'], ['message_map', 'pi_entry', 'native_entry']]
      .filter(([table, previous]) => this.db.prepare(`PRAGMA adapter.table_info(${table})`).all().some(column => column.name === previous));
    if (migrations.length) this.transaction(() => {
      for (const [table, previous, next] of migrations) this.db.exec(`ALTER TABLE adapter.${table} RENAME COLUMN ${previous} TO ${next}`);
    });
    if (!this.db.prepare('PRAGMA adapter.table_info(session)').all().some(column => column.name === 'owner_pid')) {
      this.db.exec('ALTER TABLE adapter.session ADD COLUMN owner_pid INTEGER NOT NULL DEFAULT 0');
    }
    if (this.db.prepare('SELECT 1 FROM main.session s LEFT JOIN adapter.session a ON s.id=a.id WHERE a.id IS NULL LIMIT 1').get()) {
      this.db.close();
      throw new Error('Active history contains sessions that do not belong to this harness');
    }
  }

  transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = body();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  meta(sessionID: string) {
    return this.db.prepare('SELECT * FROM adapter.session WHERE id=?').get(sessionID) as Meta | undefined;
  }

  owned(sessionID: string, root: string) {
    const meta = this.meta(sessionID);
    return meta?.root.toLowerCase() === root.toLowerCase() ? meta : undefined;
  }

  get(sessionID: string) {
    const meta = this.meta(sessionID);
    return meta ? JSON.parse(meta.session) as Session : undefined;
  }

  list(root: string) {
    return this.db.prepare('SELECT session FROM adapter.session WHERE root = ? COLLATE NOCASE').all(root)
      .map(row => JSON.parse(String(row.session)) as Session).sort((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id));
  }

  create(root: string, directory: string, options: { title?: string; parentID?: string; permission?: Session['permission'] }) {
    const time = Date.now();
    const sessionID = id('ses');
    const projectID = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 32);
    const session: Session = {
      id: sessionID, directory, projectID, path: '.', slug: sessionID, version: protocolVersion,
      title: options.title || `New session - ${new Date(time).toISOString()}`,
      time: { created: time, updated: time }, parentID: options.parentID, permission: options.permission,
    };
    this.transaction(() => {
      this.db.prepare('INSERT INTO main.project (id, worktree, time_created, time_updated, sandboxes) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING')
        .run(projectID, root, time, time, '[]');
      this.db.prepare(`INSERT INTO main.session (id, project_id, parent_id, directory, path, slug, version, title, permission, time_created, time_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionID, projectID, session.parentID ?? null, directory, '.', session.slug,
        session.version, session.title, options.permission ? JSON.stringify(options.permission) : null, time, time);
      this.db.prepare('INSERT INTO adapter.session (id, root, session) VALUES (?, ?, ?)').run(sessionID, root, JSON.stringify(session));
    });
    this.event(sessionID, 'session.created', { info: session });
    return session;
  }

  private writeSession(session: Session) {
    this.db.prepare('UPDATE adapter.session SET session=? WHERE id=?').run(JSON.stringify(session), session.id);
    this.db.prepare('UPDATE main.session SET title=?, time_updated=?, time_archived=?, revert=? WHERE id=?')
      .run(session.title, session.time.updated, session.time.archived ?? null, session.revert ? JSON.stringify(session.revert) : null, session.id);
  }

  update(session: Session) {
    this.transaction(() => this.writeSession(session));
    this.event(session.id, 'session.updated', { info: session });
    return session;
  }

  delete(session: Session) {
    const meta = this.meta(session.id);
    if (!meta) return;
    this.transaction(() => {
      this.db.prepare('DELETE FROM main.session WHERE id=?').run(session.id);
      this.db.prepare('DELETE FROM adapter.session WHERE id=?').run(session.id);
    });
    this.publish({ id: id('evt'), type: 'session.deleted', properties: { info: session } }, session.directory, meta.root);
  }

  event(sessionID: string, type: string, properties: Json) {
    const row = this.db.prepare('UPDATE adapter.session SET sequence=sequence+1 WHERE id=? RETURNING session,root').get(sessionID);
    if (row) this.publish({ id: id('evt'), type, properties }, (JSON.parse(String(row.session)) as Session).directory, String(row.root));
  }

  putMessage(info: Message) {
    const { id, sessionID, ...data } = info;
    this.db.prepare(`INSERT INTO main.message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data WHERE session_id=excluded.session_id`)
      .run(id, sessionID, info.time.created, Date.now(), JSON.stringify(data));
    this.event(sessionID, 'message.updated', { info });
  }

  putPart(record: Part, emit = true) {
    const { id, sessionID, messageID, ...data } = record;
    this.db.prepare(`INSERT INTO main.part (id,session_id,message_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data WHERE session_id=excluded.session_id AND message_id=excluded.message_id`)
      .run(id, sessionID, messageID, Date.now(), Date.now(), JSON.stringify(data));
    if (emit) this.event(sessionID, 'message.part.updated', { part: record, time: Date.now() });
  }

  message(sessionID: string, messageID: string) {
    const row = this.db.prepare('SELECT * FROM main.message WHERE id=? AND session_id=?').get(messageID, sessionID) as MessageRow | undefined;
    return row ? this.withParts(row) : undefined;
  }

  messages(sessionID: string, includeHidden = false) {
    const rows = this.db.prepare('SELECT * FROM main.message WHERE session_id=? ORDER BY rowid').all(sessionID) as MessageRow[];
    const cutoff = includeHidden ? null : this.meta(sessionID)?.cutoff;
    const boundary = cutoff ? rows.findIndex(row => row.id === cutoff) : -1;
    return (boundary < 0 ? rows : rows.slice(0, boundary)).map(row => this.withParts(row));
  }

  private withParts(row: MessageRow) {
    const rows = this.db.prepare('SELECT * FROM main.part WHERE message_id=? ORDER BY rowid').all(row.id) as PartRow[];
    return { info: message(row), parts: rows.map(part) };
  }

  mapMessage(sessionID: string, messageID: string, entryID: string) {
    this.db.prepare(`INSERT INTO adapter.message_map VALUES (?,?,?) ON CONFLICT (session_id,message_id)
      DO UPDATE SET native_entry=excluded.native_entry`).run(sessionID, messageID, entryID);
  }

  mapped(sessionID: string, messageID: string) {
    const row = this.db.prepare('SELECT native_entry FROM adapter.message_map WHERE session_id=? AND message_id=?').get(sessionID, messageID);
    return row ? String(row.native_entry) : undefined;
  }

  mapTool(sessionID: string, callID: string, partID: string) {
    this.db.prepare(`INSERT INTO adapter.tool_map VALUES (?,?,?) ON CONFLICT(session_id,call_id) DO UPDATE SET part_id=excluded.part_id`)
      .run(sessionID, callID, partID);
  }

  claim(sessionID: string) {
    return this.db.prepare('UPDATE adapter.session SET running=1, owner_pid=? WHERE id=? AND running=0').run(process.pid, sessionID).changes === 1;
  }

  complete(sessionID: string) {
    this.db.prepare('UPDATE adapter.session SET running=0, owner_pid=0 WHERE id=?').run(sessionID);
  }

  native(sessionID: string, file: string | undefined, leaf: string | null) {
    this.db.prepare('UPDATE adapter.session SET native_file=?, native_leaf=? WHERE id=?').run(file ?? null, leaf, sessionID);
  }

  setRevert(session: Session, leaf: string | null, previous: string | null) {
    this.transaction(() => {
      this.db.prepare('UPDATE adapter.session SET native_leaf=?, cutoff=?, revert_leaf=? WHERE id=?')
        .run(leaf, session.revert?.messageID ?? null, previous, session.id);
      this.writeSession(session);
    });
    this.event(session.id, 'session.updated', { info: session });
    return session;
  }

  wasMessageRemoved(sessionID: string, messageID: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM adapter.removed_message WHERE session_id=? AND message_id=?').get(sessionID, messageID));
  }

  commitRevert(sessionID: string) {
    const meta = this.meta(sessionID);
    if (!meta?.cutoff) return;
    this.removeMessages(this.get(sessionID)!, meta.cutoff, meta.native_leaf);
  }

  removeMessages(session: Session, cutoff: string, leaf: string | null) {
    const sessionID = session.id;
    const updated = { ...session, time: { ...session.time, updated: Date.now() } };
    delete updated.revert;
    const removed = this.transaction(() => {
      const rows = this.db.prepare(`DELETE FROM main.message WHERE session_id=? AND rowid >=
        (SELECT rowid FROM main.message WHERE session_id=? AND id=?) RETURNING id`).all(sessionID, sessionID, cutoff) as { id: string }[];
      const remember = this.db.prepare('INSERT OR IGNORE INTO adapter.removed_message VALUES (?,?)');
      for (const { id } of rows) remember.run(sessionID, id);
      this.db.prepare('UPDATE adapter.session SET native_leaf=?, cutoff=NULL, revert_leaf=NULL WHERE id=?').run(leaf, sessionID);
      this.writeSession(updated);
      return rows;
    });
    for (const { id } of removed) this.event(sessionID, 'message.removed', { sessionID, messageID: id });
    this.event(sessionID, 'session.updated', { info: updated });
  }

  running(root: string) {
    return this.db.prepare('SELECT * FROM adapter.session WHERE root=? COLLATE NOCASE AND running=1').all(root) as Meta[];
  }

  takeOver(meta: Meta) {
    return this.db.prepare('UPDATE adapter.session SET owner_pid=? WHERE id=? AND running=1 AND owner_pid=?')
      .run(process.pid, meta.id, meta.owner_pid).changes === 1;
  }

  finishInterrupted(meta: Meta, detail: string) {
    const history = this.messages(meta.id, true);
    for (const item of history) {
      if (item.info.role === 'assistant' && (!item.info.time.completed || (item === history.at(-1) && item.info.finish === 'tool-calls'))) {
        item.info.time.completed = Date.now();
        item.info.error = failure(detail, true);
        item.info.finish = 'error';
        this.putMessage(item.info);
      }
      for (const record of item.parts) {
        if (record.type === 'tool' && ['pending', 'running'].includes(record.state.status)) {
          const state = record.state as Extract<ToolPart['state'], { status: 'running' | 'pending' }>;
          record.state = { status: 'error', input: state.input, error: detail,
            time: { start: state.status === 'running' ? state.time.start : Date.now(), end: Date.now() } };
          this.putPart(record);
        }
      }
    }
    this.complete(meta.id);
  }

  close() { this.db.close(); }
}
