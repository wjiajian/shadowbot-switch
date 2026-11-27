import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { within } from './config-paths.js';
import { UserError } from './errors.js';
import { atomicWrite, readJson } from './installation.js';
import type { Installation } from './installation.js';
import { runtimeStates } from './runtime-state.js';

const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
function customPaths(home: string): string[] {
  const file = within(home, 'apps.json');
  if (!existsSync(file)) return [];
  const registry = readJson<{ version: number; custom: string[] }>(file);
  if (registry?.version !== 1 || !Array.isArray(registry.custom) || !registry.custom.every(p => typeof p === 'string' && isAbsolute(p))) throw new UserError('apps.json 格式无效。');
  return registry.custom;
}
export function applicationList(home: string, install: Installation) {
  const paths = new Map<string, { name: string; path: string; source: string; exists: boolean; custom: boolean }>();
  const add = (input: string, source: string) => {
    const exists = lstatSync(input, { throwIfNoEntry: false })?.isDirectory() === true;
    if (!exists && source !== 'custom') return;
    const path = exists ? realpathSync.native(input) : input;
    const custom = source === 'custom' || paths.get(key(path))?.custom === true;
    paths.set(key(path), { name: basename(path), path, source, exists, custom });
  };
  for (const path of customPaths(home)) add(path, 'custom');
  const directories = (path: string) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(path, d.name)) : [];
  for (const user of directories(install.users)) for (const app of directories(join(user, 'apps'))) add(app, 'discovered');
  for (const state of runtimeStates(home, true)) {
    if (state.live || !paths.has(key(state.root))) add(state.root, state.live ? 'running' : 'discovered');
  }
  return [...paths.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function editApplication(home: string, install: Installation, input: string, add: boolean) {
  if (!isAbsolute(input)) throw new UserError('请填写应用的绝对路径。');
  let path = resolve(input);
  const custom = customPaths(home), warnings: string[] = [];
  if (add) {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new UserError('请选择存在的普通目录。');
    path = realpathSync.native(path);
    const canonicalHome = realpathSync.native(home);
    if ([parse(path).root, dirname(canonicalHome), canonicalHome].some(p => key(p) === key(path)) || basename(path).toLowerCase() === '.shadowbot-switch') throw new UserError('请选择应用根目录。');
    const parts = relative(install.users, path).split(sep);
    if (parts.length !== 3 || parts[0] === '..' || key(parts[1]) !== 'apps') warnings.push('不在影刀用户应用目录下，请确认是应用根目录。');
  }
  const remaining = custom.filter(p => key(p) !== key(path));
  if (!add && remaining.length === custom.length) throw new UserError('这个路径没有手动添加。');
  if (add) remaining.push(path);
  atomicWrite(within(home, 'apps.json'), JSON.stringify({ version: 1, custom: remaining }, null, 2) + '\n');
  return { message: add ? '已添加应用路径。' : '已移除应用路径。', path, warnings };
}
