import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { within } from './config-paths.js';
import { UserError } from './errors.js';
import { atomicWrite, readJson } from './installation.js';

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const kinds = ['import', 'skill-remove', 'mcp-remove', 'rules-save', 'rules-remove', 'settings-save', 'pre-restore'] as const;
type Kind = typeof kinds[number];
type Scope = { type: 'installation' } | { type: 'application'; app: string };
type Entry = { stored: string | null; target: string; type: 'file' | 'directory'; existed: boolean };
type Manifest = { version: 1; id: string; createdAt: string; scope: Scope; kind: Kind; source?: string; entries: Entry[] };
export const backupScope = (app?: string): Scope => app ? { type: 'application', app } : { type: 'installation' };

function allowedTarget(home: string, scope: Scope, target: string) {
  if (typeof target !== 'string' || !isAbsolute(target) || resolve(target) !== target) throw new UserError('备份目标路径无效。');
  const root = scope.type === 'application' ? scope.app : home;
  if (scope.type === 'application' && realpathSync.native(root) !== root) throw new UserError('备份应用路径已变化。');
  const rel = relative(root, target).split(sep).join('/');
  if (!(scope.type === 'application' ? /^(?:AGENTS\.md$|\.(?:pi|shadowbot-switch)\/.+)/i : /^(?:agent|skills)\/.+/).test(rel)) {
    throw new UserError(`备份目标越出了配置目录：${target}`);
  }
  return within(root, rel);
}

function checkTree(path: string): Entry['type'] {
  const info = lstatSync(path);
  if (info.isFile()) return 'file';
  if (!info.isDirectory()) throw new UserError(`配置中包含链接或特殊文件：${path}`);
  for (const name of readdirSync(path)) checkTree(join(path, name));
  return 'directory';
}

function copy(source: string, target: string, type: Entry['type']) {
  if (type === 'file') atomicWrite(target, readFileSync(source));
  else { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true, force: false, errorOnExist: true }); }
}

type BackupRequest = { kind: Kind; scope: Scope; source?: string; entries: { stored: string; target: string; type: Entry['type'] }[] };
export function createBackup(home: string, request: BackupRequest, move = false) {
  const id = randomUUID();
  const path = within(home, `config-backups/${id}`);
  mkdirSync(path, { recursive: true });
  const moved: { target: string; storage: string; local?: string }[] = [];
  try {
    const entries = request.entries.map(({ target, stored, type }) => {
      allowedTarget(home, request.scope, target);
      const existed = existsSync(target);
      if (existed) {
        if (checkTree(target) !== type) throw new UserError(`备份目标类型已变化：${target}`);
        const storage = within(path, stored);
        if (move) {
          mkdirSync(dirname(storage), { recursive: true });
          try {
            renameSync(target, storage);
            moved.push({ target, storage });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            // Applications and the installation may be on different drives.
            copy(target, storage, type);
            const local = target + '.' + id + '.remove';
            renameSync(target, local);
            moved.push({ target, storage, local });
          }
        } else copy(target, storage, type);
      }
      return { target, stored: existed ? stored : null, existed, type };
    });
    const manifest: Manifest = { version: 1, id, kind: request.kind, createdAt: new Date().toISOString(), scope: request.scope, source: request.source, entries };
    // An edited manifest cannot authorize a different application root.
    if (request.scope.type === 'application') atomicWrite(path + '.app', request.scope.app);
    atomicWrite(path + '.backup.json', JSON.stringify(manifest, null, 2) + '\n');
    for (const e of moved) if (e.local) rmSync(e.local, { recursive: true, force: true });
    return { id, path };
  } catch (error) {
    try {
      for (const e of moved.reverse()) {
        if (e.local) {
          copy(e.storage, e.target, 'directory');
          rmSync(e.local, { recursive: true, force: true });
        } else renameSync(e.storage, e.target);
      }
    } catch { throw new UserError(`备份操作失败，回滚未完成。请从此处取回原文件：${path}`); }
    rmSync(path + '.backup.json', { force: true });
    rmSync(path, { recursive: true, force: true });
    rmSync(path + '.app', { force: true });
    throw error;
  }
}

function manifestAt(home: string, id: string) {
  if (!uuid.test(id)) throw new UserError('备份编号无效。');
  const path = within(home, `config-backups/${id}`);
  if (!lstatSync(path).isDirectory()) throw new UserError('备份目录无效。');
  const file = within(home, `config-backups/${id}.backup.json`);
  if (!existsSync(file)) throw new UserError('旧备份缺少清单，请打开目录手动恢复。');
  const m = readJson<Manifest>(file);
  const anchor = within(home, `config-backups/${id}.app`);
  const app = existsSync(anchor) ? readFileSync(anchor, 'utf8') : null;
  if (m?.version !== 1 || m.id !== id || !kinds.includes(m.kind) || !Number.isFinite(Date.parse(m.createdAt)) ||
      !Array.isArray(m.entries) || !m.scope || (app !== null ? m.scope.type !== 'application' || app !== m.scope.app : m.scope.type !== 'installation')) {
    throw new UserError('备份清单损坏或范围无效。');
  }
  const targets = new Set<string>();
  for (const e of m.entries) {
    if (!e || !['file', 'directory'].includes(e.type) || typeof e.existed !== 'boolean' ||
        (e.existed ? typeof e.stored !== 'string' : e.stored !== null)) throw new UserError('备份条目无效。');
    const target = allowedTarget(home, m.scope, e.target).toLowerCase();
    if (targets.has(target)) throw new UserError('备份含重复目标。');
    targets.add(target);
    if (e.stored !== null) within(path, e.stored);
  }
  for (const target of targets) {
    let p = dirname(target);
    while (dirname(p) !== p) {
      if (targets.has(p)) throw new UserError('备份目标互相重叠。');
      p = dirname(p);
    }
  }
  return m;
}

function action(e: Entry) {
  if (!e.existed) return 'delete';
  if (!existsSync(e.target)) return 'create';
  return e.type === 'directory' ? 'replace-directory' : 'overwrite';
}

export function listBackups(home: string, { limit, offset }: { limit: number; offset: number }) {
  const root = within(home, 'config-backups');
  const items = (existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []).filter(e => e.isDirectory() && uuid.test(e.name)).map(e => {
    const id = e.name, path = join(root, id);
    const legacy = { id, kind: 'legacy', scope: null, restorable: false, fileCount: 0, files: [], truncated: false, createdAt: lstatSync(path).mtime.toISOString() };
    if (!lstatSync(path + '.backup.json', { throwIfNoEntry: false })) return legacy;
    try {
      const m = manifestAt(home, id);
      return { id, createdAt: m.createdAt, kind: m.kind, scope: m.scope, source: m.source, restorable: true,
        fileCount: m.entries.length, truncated: m.entries.length > 50, files: m.entries.slice(0, 50).map(e => ({ target: e.target, type: e.type, action: action(e) })) };
    } catch { return { ...legacy, damaged: true }; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { total: items.length, items: items.slice(offset, offset + limit) };
}

export function restoreBackup(home: string, id: string, { dryRun }: { dryRun: boolean }) {
  const m = manifestAt(home, id), path = within(home, `config-backups/${id}`);
  for (const e of m.entries) {
    if (e.stored !== null && checkTree(within(path, e.stored)) !== e.type) throw new UserError(`备份文件类型不符：${e.stored}`);
    if (existsSync(e.target) && checkTree(e.target) !== e.type) throw new UserError(`目标类型不符：${e.target}`);
  }
  const files = m.entries.map(e => ({ target: e.target, action: action(e) }));
  if (dryRun) return { dryRun, id, files };
  const before = createBackup(home, { scope: m.scope, kind: 'pre-restore', source: id,
    entries: m.entries.map((e, i) => ({ ...e, stored: String(i) })) });
  const applied: { target: string; moved?: string; snapshot: string; type: Entry['type'] }[] = [];
  try {
    for (const [i, e] of m.entries.entries()) {
      allowedTarget(home, m.scope, e.target);
      // Keep the old entry on the same volume until every replacement succeeds.
      const moveAside = !e.existed || e.type === 'directory';
      const moved = moveAside && existsSync(e.target) ? e.target + '.' + randomUUID() + '.restore' : undefined;
      if (moved) renameSync(e.target, moved);
      applied.push({ target: e.target, moved, snapshot: join(before.path, String(i)), type: e.type });
      if (e.stored !== null) copy(within(path, e.stored), e.target, e.type);
    }
    for (const { moved } of applied) if (moved) rmSync(moved, { recursive: true, force: true });
  } catch {
    let rolledBack = true;
    for (const { target, moved, snapshot, type } of applied.reverse()) {
      try {
        allowedTarget(home, m.scope, target);
        rmSync(target, { recursive: true, force: true });
        // Cleanup may already have removed part of the moved tree.
        if (existsSync(snapshot)) copy(snapshot, target, type);
        if (moved) rmSync(moved, { recursive: true, force: true });
      } catch { rolledBack = false; }
    }
    throw new UserError(`恢复失败，${rolledBack ? '已回滚' : '请检查未完成的回滚'}。原备份：${path}。恢复前备份：${before.path}`);
  }
  return { message: '已恢复配置。', restored: files.length, backup: before.id };
}
