import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

export function ruleCandidates(agentDir?: string, root?: string) {
  return [
    ...(agentDir ? [{ scope: 'Installation', root: agentDir, paths: [join(agentDir, 'AGENTS.md')] }] : []),
    ...(root ? [{ scope: 'Application', root, paths: [join(root, 'AGENTS.md'), join(appConfigDirectory(root), 'AGENTS.md')] }] : []),
  ];
}

export function loadAgentRules(agentDir: string | undefined, root?: string) {
  const files: RuleFile[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const source of ruleCandidates(agentDir, root)) {
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

export function inspectRuleFile(path: string, root: string, previewLimit = 64 * 1024) {
  const result = { exists: false, link: false, readonlyReason: null as string | null, bytes: 0,
    sha256: 'absent', utf8Valid: true, tooLarge: false, bom: false, eol: 'none', content: '', preview: '' };
  try {
    if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return { ...result, exists: !!lstatSync(path, { throwIfNoEntry: false }), link: true, readonlyReason: 'link' };
    }
    let parent = root;
    for (const part of relative(root, path).split(sep).slice(0, -1)) {
      parent = join(parent, part);
      const stat = lstatSync(parent, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) { result.link = true; result.readonlyReason = 'link'; }
      else if (stat && !stat.isDirectory()) return { ...result, readonlyReason: 'not-file' };
    }
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return result;
    result.exists = true;
    result.link ||= info.isSymbolicLink();
    if (result.link) result.readonlyReason = 'link';
    const canonical = realpathSync.native(path);
    if (outsideWorkspace(relative(realpathSync.native(root), canonical))) return { ...result, link: true, readonlyReason: 'link' };
    const initial = statSync(canonical, { bigint: true });
    if (!initial.isFile()) return { ...result, readonlyReason: result.readonlyReason ?? 'not-file' };
    const fd = openSync(canonical, 'r');
    try {
      const before = fstatSync(fd, { bigint: true });
      const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
      const chunk = Buffer.alloc(64 * 1024);
      const sample = Buffer.alloc(Math.min(Number(initial.size), Math.max(maxRuleBytes, previewLimit)));
      let size = 0, lf = false, crlf = false, loneCR = false, pendingCR = false;
      while (size <= Number(initial.size)) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, Number(initial.size) - size + 1), null);
        if (!n) break;
        const bytes = chunk.subarray(0, n);
        hash.update(bytes);
        if (size < sample.length) bytes.copy(sample, size);
        for (const byte of bytes) {
          if (byte === 10) {
            if (pendingCR) crlf = true; else lf = true;
          } else if (pendingCR) loneCR = true;
          pendingCR = byte === 13;
        }
        if (result.utf8Valid) try { decoder.decode(bytes, { stream: true }); } catch { result.utf8Valid = false; }
        size += n;
      }
      try { decoder.decode(); } catch { result.utf8Valid = false; }
      if (size !== Number(initial.size) || !unchanged(before, fstatSync(fd, { bigint: true })) ||
        realpathSync.native(path) !== canonical || !unchanged(initial, statSync(canonical, { bigint: true }))) throw new Error();
      result.bytes = size;
      result.sha256 = hash.digest('hex');
      result.tooLarge = size > maxRuleBytes;
      result.bom = sample.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
      result.eol = loneCR || pendingCR || (lf && crlf) ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
      if (result.utf8Valid && !result.tooLarge) result.content = new TextDecoder().decode(sample);
      else result.preview = new TextDecoder().decode(sample.subarray(0, previewLimit));
    } finally { closeSync(fd); }
  } catch { result.readonlyReason ??= 'unreadable'; }
  return result;
}
