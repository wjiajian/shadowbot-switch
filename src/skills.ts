import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import ignore from 'ignore';
import { parse } from 'yaml';

export type Skill = { name: string; description: string; filePath: string; baseDir: string; source: string; disableModelInvocation: boolean };
export function loadSkillsFromDir({ dir, source }: { dir: string; source: string }) {
  const skills: Skill[] = [];
  const diagnostics: { type: 'warning' | 'error'; path: string; message: string }[] = [];
  const seen = new Set<string>();
  const rules = ignore();
  const relativePath = (path: string) => relative(dir, path).split(sep).join('/');
  const load = (path: string) => {
    const declared = basename(path) === 'SKILL.md';
    try {
      const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      const data = header ? parse(header[1]) : {};
      if (typeof data?.description !== 'string' || !data.description.trim()) {
        if (declared) diagnostics.push({ type: 'error', path, message: 'Skill 需要有效的 description。' });
        return;
      }
      const name = typeof data.name === 'string' && data.name ? data.name : basename(dirname(path));
      // Keep naming and length issues as warnings when the skill remains loadable.
      if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) diagnostics.push({ type: 'warning', path, message: 'Skill 名称建议使用不超过 64 字符的小写字母、数字和连字符。' });
      if (data.description.length > 1024) diagnostics.push({ type: 'warning', path, message: 'Skill description 超过 1024 字符。' });
      skills.push({ name, description: data.description, filePath: path, baseDir: dirname(path), source, disableModelInvocation: data['disable-model-invocation'] === true });
    } catch (error) {
      if (declared) diagnostics.push({ type: 'error', path, message: error instanceof Error ? error.message : 'Invalid Skill' });
    }
  };
  const visit = (folder: string, rootFiles = false) => {
    const canonical = realpathSync(folder);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const prefix = relativePath(folder);
    for (const name of ['.gitignore', '.ignore', '.fdignore']) {
      const path = join(folder, name);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        const negated = line.startsWith('!');
        const pattern = (negated ? line.slice(1) : line).replace(/^\//, '');
        rules.add(`${negated ? '!' : ''}${prefix ? prefix + '/' : ''}${pattern}`);
      }
    }
    const path = join(folder, 'SKILL.md');
    if (existsSync(path) && statSync(path).isFile() && !rules.ignores(relativePath(path))) { load(path); return; }
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(folder, entry.name);
      try {
        const stat = entry.isSymbolicLink() ? statSync(path) : entry;
        if (rules.ignores(relativePath(path) + (stat.isDirectory() ? '/' : ''))) continue;
        if (stat.isDirectory()) visit(path);
        else if (stat.isFile() && rootFiles && entry.name.endsWith('.md')) load(path);
      } catch { /* Broken links are not skills. */ }
    }
  };
  if (existsSync(dir)) visit(dir, true);
  return { skills, diagnostics };
}
