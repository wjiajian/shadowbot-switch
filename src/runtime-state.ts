import { appConfigFiles } from './config-paths.js';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, readJson } from './installation.js';

export function configurationRevision(home: string, root?: string) {
  const hash = createHash('sha256');
  for (const path of [join(home, 'agent', 'mcp.json'), ...appConfigFiles(root, 'mcp.json'), join(home, 'reload.request')]) {
    hash.update(path).update('\0');
    if (existsSync(path)) hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}

export type RuntimeState = {
  harness?: string; pid: number; root: string; updated: number; active: number; revision: string;
  mcp: Record<string, unknown>; errors: Record<string, string>; configurationError?: string; menuReconnect?: boolean;
};

export function publishRuntimeState(home: string, state: Omit<RuntimeState, 'pid' | 'updated'>) {
  const key = createHash('sha256').update(state.root.toLowerCase()).digest('hex').slice(0, 20);
  atomicWrite(join(home, 'running', `${process.pid}-${key}.json`), JSON.stringify({ ...state, pid: process.pid, updated: Date.now() }));
}

export function runtimeStates(home: string, includeStopped = false) {
  const folder = join(home, 'running');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => /^\d+-[a-f0-9]+\.json$/.test(name)).flatMap(name => {
    try {
      const state = readJson<RuntimeState>(join(folder, name));
      if (!Number.isInteger(state.pid) || state.pid < 1 || typeof state.root !== 'string' || !Number.isFinite(state.updated)) return [];
      let live = Date.now() - state.updated < 15_000;
      try { process.kill(state.pid, 0); } catch { live = false; }
      return live || includeStopped ? [{ ...state, live, pending: state.revision !== configurationRevision(home, state.root) }] : [];
    } catch { return []; }
  });
}
