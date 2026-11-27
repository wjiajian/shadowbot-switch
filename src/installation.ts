import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { UserError } from './errors.js';
import { harnessID } from './harnesses.js';
import type { HarnessRelease } from './harnesses.js';
import { legacyRuntimeDirectory, legacyRuntimeHarness, legacyVersion } from './legacy.js';

export const protocolVersion = '1.18.12';
export type Mode = string;
export type Backend = string;
export interface Installation {
  agentPath: string;
  originalHash?: string;
  launcherHash?: string;
  runtimeRelease?: string;
  piVersion?: string;
  runtime?: { harness: string; release: string };
  bundled?: { id: string; version?: string };
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
  const fd = openSync(temporary, 'wx');
  try {
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function ownsAgent(home: string, install: Installation) {
  try {
    const locator = readJson<{home?: string}>(install.agentPath + '.shadowbot-pi.json');
    return typeof locator?.home === 'string' && !!locator.home.trim() && resolve(locator.home).toLowerCase() === resolve(home).toLowerCase();
  } catch { return false; }
}

export const hostVersion = (install: Installation) => install.bundled?.version ?? protocolVersion;

export function mode(home: string): Mode {
  const value = readJson<{mode: Mode}>(join(home, 'backend.json')).mode;
  return value === 'observe' ? value : harnessID(value);
}
