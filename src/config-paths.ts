import { existsSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

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
