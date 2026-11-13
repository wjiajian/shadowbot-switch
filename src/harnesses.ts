import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, runtimeDirectory } from './installation.js';
import type { Installation } from './installation.js';
import type { HarnessAdapter } from './adapter.js';
import { UserError } from './errors.js';

export type Capabilities = { skills: boolean; mcp: boolean };
export type Launch = { executable: string; args: string[] };
export type Harness = {
  id: string; name: string; aliases: string[]; kind: 'managed' | 'bundled';
  version?: string; versionPackage?: string; adapter?: string; launch?: Launch; capabilities: Capabilities;
};
export type HarnessRelease = { release: string; version: string; adapter: string; launch: Launch; capabilities: Capabilities; legacy?: boolean };

export function harnessID(value: string) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value) || value === 'observe') throw new UserError(`无效 harness 标识：${value}`);
  return value;
}
export function relativeFile(value: string) {
  if (typeof value !== 'string' || !value || value.split('/').some(p => !p || p === '.' || p === '..' || /[:\\\x00-\x1f]/.test(p))) throw new Error('Invalid runtime relative path');
  return value;
}
export function registryDirectory() {
  const service = dirname(fileURLToPath(import.meta.url));
  const bundled = join(service, '..', 'harnesses');
  return existsSync(bundled) ? bundled : resolve(service, '..', '..', 'harnesses');
}
export class HarnessRegistry {
  private entries = new Map<string, Harness>();
  private aliases = new Map<string, string>();
  constructor(directory = registryDirectory()) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const spec = readJson<Harness>(join(directory, entry.name, 'harness.json'));
      if (harnessID(spec.id) !== entry.name || !['managed', 'bundled'].includes(spec.kind) || !spec.name ||
          !Array.isArray(spec.aliases) || typeof spec.capabilities?.skills !== 'boolean' || typeof spec.capabilities?.mcp !== 'boolean') throw new Error('Invalid harness registration');
      if (spec.kind === 'managed') {
        relativeFile(spec.adapter!); relativeFile(spec.launch?.executable!);
        if (!Array.isArray(spec.launch?.args) || !spec.launch.args.every(a => typeof a === 'string')) throw new Error('Invalid harness launch arguments');
      }
      for (const name of [spec.id, ...spec.aliases]) {
        harnessID(name);
        if (this.aliases.has(name)) throw new Error(`Duplicate harness registration: ${name}`);
        this.aliases.set(name, spec.id);
      }
      this.entries.set(spec.id, spec);
    }
  }
  list() { return [...this.entries.values()]; }
  get(name: string) {
    const spec = this.entries.get(this.aliases.get(name) ?? '');
    if (!spec) throw new UserError(`未知 harness：${name}。可用：${this.list().map(h => h.id).join(', ')}`);
    return spec;
  }
}

export async function loadAdapter(home: string, installation: Installation, spec: Harness): Promise<HarnessAdapter> {
  if (spec.kind !== 'managed') throw new UserError(`${spec.name} 由影刀自带程序运行。`);
  const release = installation.harnesses?.[spec.id];
  if (installation.runtime && !release) throw new UserError(`${spec.name} 尚未安装。运行 use ${spec.id}。`);
  if (release?.legacy) throw new UserError(`${spec.name} 使用旧运行时。运行 update ${spec.id} 完成适配器迁移。`);
  const module = relativeFile(release?.adapter ?? spec.adapter!);
  // Development and old installations load the adapter alongside the invoking control service.
  const url = release ? pathToFileURL(join(runtimeDirectory(home, installation, spec.id), 'service', module)) : new URL(module, import.meta.url);
  const { adapter } = await import(url.href) as { adapter: HarnessAdapter };
  if (!adapter || adapter.id !== spec.id || typeof adapter.verify !== 'function' || typeof adapter.createConfig !== 'function' || typeof adapter.createRuns !== 'function') throw new Error('Invalid harness adapter contract');
  if ((release?.capabilities ?? spec.capabilities).mcp && !adapter.mcp) throw new Error('Harness declares MCP without an implementation');
  return adapter;
}
