import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join, relative } from 'node:path';
import { appConfigDirectory, outsideWorkspace } from './config-paths.js';

export const maxRuleBytes = 32 * 1024;
type RuleFile = { scope: string; path: string; canonical: string; content: string };

export function decodeRuleContent(data: Uint8Array) {
  if (data.byteLength > maxRuleBytes) throw new Error('规则文件超过 32 KiB，请缩小文件');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data).trim(); }
  catch { throw new Error('规则文件不是有效 UTF-8，请使用 UTF-8 保存'); }
}

function unchanged(before: BigIntStats, after: BigIntStats) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

// Read a bounded snapshot through one descriptor. Reject files replaced or edited
// during the read instead of sending partial instructions to the model.
function readRules(path: string, root: string) {
  const canonicalRoot = realpathSync.native(root);
  const canonical = realpathSync.native(path);
  const local = relative(canonicalRoot, canonical);
  if (outsideWorkspace(local)) throw new Error('链接目标超出规则所在目录');
  const pathBefore = statSync(canonical, { bigint: true });
  if (!pathBefore.isFile()) throw new Error('规则路径不是普通文件');
  if (pathBefore.size > BigInt(maxRuleBytes)) throw new Error('规则文件超过 32 KiB，请缩小文件');
  const fd = openSync(canonical, 'r');
  try {
    // Compare path metadata only with path metadata, and handle metadata only
    // with handle metadata: Windows filesystems can report them differently.
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size !== pathBefore.size) throw new Error('规则文件在读取期间发生变化，请重试');
    const buffer = Buffer.alloc(maxRuleBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    // Handle stats alone cannot detect a rename that replaces the path while
    // the descriptor still points to the old file; retain the path snapshot.
    if (size !== Number(before.size) || !unchanged(before, fstatSync(fd, { bigint: true })) ||
      realpathSync.native(path) !== canonical || !unchanged(pathBefore, statSync(canonical, { bigint: true }))) {
      throw new Error('规则文件在读取期间发生变化，请重试');
    }
    const content = decodeRuleContent(buffer.subarray(0, size));
    return { canonical, content };
  } finally { closeSync(fd); }
}

export function loadAgentRules(agentDir: string | undefined, root?: string) {
  const files: RuleFile[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const sources = [
    ...(agentDir ? [{ scope: 'Installation', root: agentDir, paths: [join(agentDir, 'AGENTS.md')] }] : []),
    ...(root ? [{ scope: 'Application', root, paths: [join(root, 'AGENTS.md'), join(appConfigDirectory(root), 'AGENTS.md')] }] : []),
  ];
  for (const source of sources) {
    for (const path of source.paths) {
      try {
        if (!lstatSync(path, { throwIfNoEntry: false })) continue;
        const file = readRules(path, source.root);
        const key = process.platform === 'win32' ? file.canonical.toLowerCase() : file.canonical;
        if (!seen.has(key)) files.push({ ...file, path, scope: source.scope });
        seen.add(key);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const reason = code === 'ENOENT' || code === 'ENOTDIR' ? '规则路径或链接目标不可用，请检查断链或文件是否已被移除' :
          code ?? (error instanceof Error ? error.message : '读取失败');
        warnings.push(`${path}：${reason}`);
      }
      // An existing empty or invalid root file must not revive fallback rules.
      break;
    }
  }
  const sections = files.filter(file => file.content).map(file => `## ${file.scope} rules\n\n${file.content}`);
  const instructions = sections.length ? [
    'Project instructions from AGENTS.md. Application rules take precedence over installation rules when they conflict. These rules do not override tool permissions.',
    ...sections,
  ].join('\n\n') : '';
  return { files, warnings, instructions };
}

export function agentRules(agentDir: string, root: string) {
  const result = loadAgentRules(agentDir, root);
  for (const warning of result.warnings) console.error(`AGENTS.md: ${warning}；本轮已跳过该规则文件。`);
  return result.instructions;
}
