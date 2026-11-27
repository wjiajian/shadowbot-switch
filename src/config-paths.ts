import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { UserError } from './errors.js';

export function outsideWorkspace(fromRoot: string) {
  return isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`);
}

export const appConfigDirectory = (root: string) => join(root, '.shadowbot-switch');
export const appConfigDirectories = (root: string) => [join(root, '.pi'), appConfigDirectory(root)];
// Old application configuration remains readable; new commands only write the neutral directory.
export function appConfigFiles(root: string | undefined, name: string) {
  return root ? appConfigDirectories(root).map(path => join(path, name)) : [];
}
export function appSkillDirectories(root?: string) {
  return root ? [join(appConfigDirectory(root), 'skills'), join(root, '.pi', 'skills')].filter(existsSync) : [];
}


export function configPathStat(path: string) {
  try { return lstatSync(path, { throwIfNoEntry: false }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '未知错误';
    throw new UserError(`无法检查配置路径：${path}（${code}）。检查目录结构和读取权限。`);
  }
}

export function within(root: string, name: string) {
  if (process.platform === 'win32' && name.split('/').some(p => /[ .]$|[<>"|?*]|^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) throw new UserError(`无效配置路径：${name}`);
  if (!name || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))) throw new UserError(`无效配置路径：${name}`);
  const path = resolve(root, name);
  if (!path.startsWith(resolve(root) + sep)) throw new UserError('配置路径越出了目标目录。');
  let cursor = root;
  for (const part of name.split('/')) {
    const info = configPathStat(cursor);
    if (info?.isSymbolicLink()) throw new UserError(`目标目录包含链接：${cursor}`);
    if (info && !info.isDirectory()) throw new UserError(`目标路径不是目录：${cursor}`);
    cursor = join(cursor, part);
  }
  if (configPathStat(path)?.isSymbolicLink()) throw new UserError(`目标文件是链接：${path}`);
  return path;
}
