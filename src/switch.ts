import { HarnessRegistry } from './harnesses.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { atomicWrite, mode, readJson } from './installation.js';
import type { Backend, Installation, Mode } from './installation.js';

type Pointers = Record<string, string>;
type Journal = { previous: Mode; source: Backend; destination: Backend; stage?: string };
type StagedSnapshot = { id: string; database: string; pointers: Pointers };
const pointerPattern = /^[^/]+\/apps\/[^/]+\/(?:copilot\/agent|xbot_extensions\/[^/]+\/\.dev\/agent)\/sessions\/current-session\.json$/i;
const snapshotID = /^[a-f0-9-]{36}$/;

export function assertHostStopped() {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `
    $browserBridge = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ShadowBot/support_X64/Chrome/ShadowBot.ChromeBridge.exe'
    @(Get-Process -Name 'ShadowBot*', 'opencode' -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessName -ne 'shadowbot-pi' -and ($_.ProcessName -ne 'ShadowBot.ChromeBridge' -or $_.Path -ne $browserBridge)
    }).Count`;
  const count = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();
  if (count !== '0') throw new Error('Exit ShadowBot and all OpenCode processes before switching');
}

function schemaOf(db: DatabaseSync) {
  return JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map(row => [row.type, row.name, row.tbl_name, String(row.sql).replace(/\s+/g, ' ').trim()]));
}

export function verifySchema(path: string, schema: string) {
  const expected = new DatabaseSync(':memory:');
  const actual = new DatabaseSync(path, { readOnly: true });
  try {
    expected.exec(schema);
    if (schemaOf(expected) !== schemaOf(actual)) throw new Error('ShadowBot SQLite schema mismatch');
    const result = actual.prepare('PRAGMA quick_check(1)').get();
    if (result?.quick_check !== 'ok') throw new Error('ShadowBot SQLite quick_check failed');
  } finally {
    actual.close();
    expected.close();
  }
}

function directories(path: string) {
  return existsSync(path) ? readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => join(path, entry.name)) : [];
}

function findPointers(users: string): Pointers {
  const pointers: Pointers = {};
  const include = (directory: string) => {
    const path = join(directory, 'sessions', 'current-session.json');
    if (existsSync(path)) {
      checkedPointer(users, relative(users, path).split(sep).join('/'));
      pointers[relative(users, path).split(sep).join('/')] = readFileSync(path, 'utf8');
    }
  };
  for (const user of directories(users)) {
    for (const app of directories(join(user, 'apps'))) {
      include(join(app, 'copilot', 'agent'));
      for (const extension of directories(join(app, 'xbot_extensions'))) include(join(extension, '.dev', 'agent'));
    }
  }
  return pointers;
}

function checkedPointer(users: string, key: string) {
  if (!pointerPattern.test(key) || key.split('/').some(segment => segment === '.' || segment === '..' || /[:\\]/.test(segment))) {
    throw new Error('Invalid session pointer path');
  }
  const root = resolve(users);
  const target = resolve(root, key);
  if (!target.startsWith(root + sep)) throw new Error('Session pointer path escapes the user directory');
  // Ensure a junction or symlink cannot redirect an update to a project file.
  let current = root;
  for (const segment of key.split('/')) {
    if (existsSync(current) && !readdirSync(current, { withFileTypes: true }).every(entry => entry.name.toLowerCase() !== segment.toLowerCase() || !entry.isSymbolicLink())) {
      throw new Error('Session pointer path contains a link');
    }
    current = join(current, segment);
  }
  return target;
}

async function copyDatabase(source: string, destination: string) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination, { rate: 128 });
  } finally {
    db.close();
  }
  // Normalize the staged database to a self-contained main file.
  const staged = new DatabaseSync(destination);
  try {
    staged.exec('PRAGMA journal_mode=DELETE');
  } finally {
    staged.close();
  }
}

function backendPaths(home: string, backend: Backend) {
  const dir = join(home, 'backends', backend);
  const id = readJson<{ id: string }>(join(dir, 'snapshot.json')).id;
  if (!snapshotID.test(id)) throw new Error('Invalid backend snapshot ID');
  return { database: join(dir, `${id}.db`), pointers: join(dir, `${id}.json`) };
}

async function saveSnapshot(home: string, backend: Backend, source: string | undefined, pointers: Pointers, schema: string) {
  const dir = join(home, 'backends', backend);
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const path = join(dir, `${id}.db`);
  const previous = existsSync(join(dir, 'snapshot.json')) ? backendPaths(home, backend) : undefined;
  if (source) await copyDatabase(source, path);
  else {
    const db = new DatabaseSync(path);
    try { db.exec(schema); } finally { db.close(); }
  }
  verifySchema(path, schema);
  atomicWrite(join(dir, `${id}.json`), JSON.stringify(pointers));
  atomicWrite(join(dir, 'snapshot.json'), JSON.stringify({ id }));
  if (previous) {
    rmSync(previous.database, { force: true });
    rmSync(previous.pointers, { force: true });
  }
}

function stagePath(installation: Installation, id: string) {
  if (!snapshotID.test(id)) throw new Error('Invalid staged database ID');
  return join(dirname(installation.database), `shadowbot-pi-${id}.db`);
}

async function stageSnapshot(home: string, installation: Installation, backend: Backend, schema: string): Promise<StagedSnapshot> {
  const snapshot = backendPaths(home, backend);
  const pointers = readJson<Pointers>(snapshot.pointers);
  for (const key of Object.keys(pointers)) checkedPointer(installation.users, key);
  const id = randomUUID();
  const database = stagePath(installation, id);
  try {
    await copyDatabase(snapshot.database, database);
    verifySchema(database, schema);
    return { id, database, pointers };
  } catch (error) {
    rmSync(database, { force: true });
    throw error;
  }
}

function applySnapshot(installation: Installation, stage: StagedSnapshot, checkStopped: () => void) {
  const active = installation.database;
  const previous = findPointers(installation.users);
  checkStopped();
  if (existsSync(active)) {
    const db = new DatabaseSync(active, { timeout: 1500 });
    try {
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (checkpoint?.busy !== 0) throw new Error('ShadowBot SQLite database is busy');
      const result = db.prepare('PRAGMA journal_mode=DELETE').get();
      if (result?.journal_mode !== 'delete') throw new Error('ShadowBot SQLite connections are still active');
    } finally {
      db.close();
    }
  }
  if (['-wal', '-shm', '-journal'].some(suffix => existsSync(active + suffix))) {
    throw new Error('ShadowBot SQLite sidecar files are still present');
  }
  checkStopped();
  // The rename consumes the staged file. Recovery can distinguish a failure before the
  // replacement from an interruption that may already have changed the database or pointers.
  renameSync(stage.database, active);
  for (const key of new Set([...Object.keys(previous), ...Object.keys(stage.pointers)])) {
    const path = checkedPointer(installation.users, key);
    if (Object.hasOwn(stage.pointers, key)) atomicWrite(path, stage.pointers[key]);
    else rmSync(path, { force: true });
  }
}

async function restoreSnapshot(home: string, installation: Installation, backend: Backend, schema: string, checkStopped: () => void) {
  const stage = await stageSnapshot(home, installation, backend, schema);
  try {
    applySnapshot(installation, stage, checkStopped);
  } finally {
    rmSync(stage.database, { force: true });
  }
}

export async function switchBackend(home: string, installation: Installation, destination: Backend, schema: string, checkStopped = assertHostStopped, registry = new HarnessRegistry()) {
  destination = registry.get(destination).id;
  checkStopped();
  const pending = join(home, 'switch.pending.json');
  const log = join(home, 'switch-log.jsonl');
  const record = (action: string, from: Mode, to: Backend) => {
    const line = JSON.stringify({ at: new Date().toISOString(), action, from, to });
    // Each record contains only backend modes and a timestamp.
    atomicWrite(log, (existsSync(log) ? readFileSync(log, 'utf8') : '') + line + '\n');
  };
  if (existsSync(pending)) {
    const interrupted = readJson<Journal>(pending);
    if (registry.get(interrupted.destination).id !== interrupted.destination ||
        interrupted.source !== registry.selected(interrupted.previous).id || interrupted.source === interrupted.destination) {
      throw new Error('Invalid backend recovery journal');
    }
    const staged = interrupted.stage === undefined ? undefined : stagePath(installation, interrupted.stage);
    if (staged && existsSync(staged)) {
      record('discarded', interrupted.previous, interrupted.destination);
    } else {
      await restoreSnapshot(home, installation, interrupted.source, schema, checkStopped);
      atomicWrite(join(home, 'backend.json'), JSON.stringify({ mode: interrupted.previous }));
      record('recovered', interrupted.previous, interrupted.destination);
    }
    rmSync(pending);
    if (staged) rmSync(staged, { force: true });
  }
  const previous = mode(home);
  const source = registry.selected(previous).id;
  if (source === destination) {
    atomicWrite(join(home, 'backend.json'), JSON.stringify({ mode: destination }));
    return;
  }
  verifySchema(installation.database, schema);
  await saveSnapshot(home, source, installation.database, findPointers(installation.users), schema);
  if (!existsSync(join(home, 'backends', destination, 'snapshot.json'))) {
    if (registry.get(destination).kind === 'bundled') throw new Error('Original session snapshot is missing');
    await saveSnapshot(home, destination, undefined, {}, schema);
  }
  const stage = await stageSnapshot(home, installation, destination, schema);
  try {
    checkStopped();
    atomicWrite(pending, JSON.stringify({ previous, source, destination, stage: stage.id } satisfies Journal));
    record('started', previous, destination);
    applySnapshot(installation, stage, checkStopped);
    atomicWrite(join(home, 'backend.json'), JSON.stringify({ mode: destination }));
    record('committed', previous, destination);
    rmSync(pending);
  } catch (error) {
    if (existsSync(pending)) {
      if (existsSync(stage.database)) record('discarded', previous, destination);
      else {
        await restoreSnapshot(home, installation, source, schema, checkStopped);
        atomicWrite(join(home, 'backend.json'), JSON.stringify({ mode: previous }));
        record('rolled-back', previous, destination);
      }
      rmSync(pending);
    }
    throw error;
  } finally {
    // A journal that could not be removed still needs the staging file as its marker.
    if (!existsSync(pending)) rmSync(stage.database, { force: true });
  }
}
