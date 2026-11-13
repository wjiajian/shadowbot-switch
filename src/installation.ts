import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { UserError } from './errors.js';
import { harnessID } from './harnesses.js';
import type { HarnessRelease } from './harnesses.js';
import { legacyRuntimeDirectory, legacyRuntimeHarness, legacyVersion } from './legacy.js';

export const protocolVersion = '1.18.12';
export const originalHash = 'de2e62ab0e3f27a3ea7ff9ef4c4fe7097f0d6df01118b2e7c5f57726256d6314';
export type Mode = string;
export type Backend = string;
export interface Installation {
  agentPath: string;
  originalHash: string;
  launcherHash: string;
  runtimeRelease?: string;
  piVersion?: string;
  runtime?: { harness: string; release: string };
  harnesses?: Record<string, HarnessRelease>;
  database: string;
  users: string;
  resources: string;
  hostSkills?: string;
}

export function runtimeDirectory(home: string, installation: Installation, harness?: string) {
  const current = harness && installation.harnesses?.[harness];
  const pointer = current ? { harness, release: current.release } : installation.runtime;
  if (pointer) {
    if (!/^[0-9a-f]{64}$/.test(pointer.release)) throw new Error('Invalid installation release ID');
    return join(home, 'harnesses', harnessID(pointer.harness!), 'releases', pointer.release);
  }
  return legacyRuntimeDirectory(home, installation);
}

export const runtimeHarness = (installation: Installation) => installation.runtime?.harness ?? legacyRuntimeHarness();
export const installedVersion = (installation: Installation, harness: string) => installation.harnesses?.[harness]?.version ?? legacyVersion(installation, harness);

export function installationHome(): string {
  const root = process.env.SHADOWBOT_SWITCH_HOME ?? process.env.SHADOWBOT_PI_HOME;
  if (!root) throw new Error('ShadowBot Switch installation directory is unavailable');
  return resolve(root);
}

export function readJson<T>(path: string): T {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch { throw new UserError(`无法读取 ${path}。检查文件是否存在及访问权限。`); }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')) as T; }
  catch { throw new UserError(`JSON 格式错误：${path}。检查引号、逗号和括号。`); }
}

export function atomicWrite(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data, { flag: 'wx', flush: true });
  renameSync(temporary, path);
}

export function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function mode(home: string): Mode {
  const value = readJson<{mode: Mode}>(join(home, 'backend.json')).mode;
  return value === 'observe' ? value : harnessID(value);
}
