import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeDirectory } from './installation.js';
import type { Installation } from './installation.js';

export function skillSources(home: string, installation: Installation, harness?: string) {
  return {
    bridge: join(runtimeDirectory(home, installation, harness), 'skills'),
    // Older installations stored bundled skills directly under home.
    autoEnabled: (installation.runtime || installation.runtimeRelease) ? join(home, 'skills') : undefined,
    resources: join(installation.resources, 'Skills'),
    runtime: installation.hostSkills,
    cache: join(home, 'host-skills'),
  };
}

export type SkillSources = ReturnType<typeof skillSources>;

function linkedDirectory(source: string, cache: string) {
  const link = join(cache, 'runtime');
  try {
    mkdirSync(cache, { recursive: true });
    if (!existsSync(link)) symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    if (realpathSync.native(link) === realpathSync.native(source)) return link;
  } catch {
    // A read-only cache can still use the live directory.
  }
  return source;
}

function unpackArchive(path: string, name: string, cache: string) {
  const archive = readFileSync(path);
  const digest = createHash('sha256').update(archive).digest('hex');
  const versions = join(cache, 'archives', digest);
  const directory = join(versions, name);
  if (existsSync(directory)) return directory;

  mkdirSync(versions, { recursive: true });
  const staging = mkdtempSync(join(versions, '.extract-'));
  try {
    const snapshot = join(staging, 'archive.zip');
    const extracted = join(staging, 'skill');
    writeFileSync(snapshot, archive);
    mkdirSync(extracted);
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', snapshot, '-C', extracted], { stdio: 'pipe', windowsHide: true, timeout: 10_000 });
    try { renameSync(extracted, directory); }
    catch (error) { if (!existsSync(directory)) throw error; }
    return directory;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function officialSkillDirectories(sources: SkillSources) {
  const roots: string[] = [];
  if (existsSync(sources.resources)) {
    roots.push(sources.resources);
    for (const entry of readdirSync(sources.resources, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.zip$/i.test(entry.name)) continue;
      try {
        roots.push(unpackArchive(join(sources.resources, entry.name), entry.name.slice(0, -4), sources.cache));
      } catch {
        console.error(`ShadowBot Switch could not load official skill archive ${entry.name}`);
      }
    }
  }
  if (sources.runtime && existsSync(sources.runtime)) roots.push(linkedDirectory(sources.runtime, sources.cache));
  return roots;
}
