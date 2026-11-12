import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION as piVersion } from '@earendil-works/pi-coding-agent';
import { atomicWrite, installationHome, mode, originalHash, protocolVersion, readJson, runtimeDirectory, sha256 } from './installation.js';
import type { Installation } from './installation.js';
import { HostConfig } from './config.js';
import { skillSources } from './host-skills.js';
import { customMcp, McpHub } from './mcp.js';
import { skills } from './shadowbot.js';
import { assertHostStopped, switchBackend, verifySchema } from './switch.js';

async function main([command, arg, directory = process.cwd()]: string[]) {
  const home = installationHome();
  const install = readJson<Installation>(join(home, command === 'verify-install' ? 'prepared.json' : 'install.json'));
  const runtime = runtimeDirectory(home, install);
  const schema = readFileSync(join(runtime, 'schema.sql'), 'utf8');
  const agentDir = join(home, 'agent');
  const backup = join(home, 'original', 'opencode.exe');
  if (command === 'doctor' || command === 'verify-install') {
    if (command === 'verify-install') await import('./runner.js');
    verifySchema(install.database, schema);
    if (install.originalHash.toLowerCase() !== originalHash || sha256(backup) !== originalHash) throw new Error('Original OpenCode checksum mismatch');
    if (process.version !== 'v24.22.3') throw new Error('Expected the bundled Node 24.22.3 runtime');
    if (install.runtimeRelease && sha256(join(runtime, 'launcher.exe')) !== install.launcherHash.toLowerCase()) {
      throw new Error('Staged launcher checksum mismatch');
    }
    if (install.piVersion && install.piVersion !== piVersion) throw new Error('Installed Pi version does not match the manifest');
    const current = existsSync(join(home, 'backend.json')) ? mode(home) : 'original';
    console.log(JSON.stringify({ harness: current === 'pi' ? 'pi' : 'opencode-origin', protocol: protocolVersion,
      backend: current === 'pi' ? `Pi ${piVersion}` : `OpenCode ${protocolVersion}`,
      node: process.version, schema: 'verified', original: 'verified', release: install.runtimeRelease,
      recoveryPending: existsSync(join(home, 'switch.pending.json')) || existsSync(join(home, 'activation.pending.json')) }, null, 2));
    return;
  }
  if (command === 'backend' && (arg === 'pi' || arg === 'original')) {
    assertHostStopped();
    if (install.originalHash.toLowerCase() !== originalHash || sha256(backup) !== originalHash) throw new Error('Original OpenCode checksum mismatch');
    if (sha256(install.agentPath) !== install.launcherHash.toLowerCase()) throw new Error('Active launcher checksum mismatch');
    await switchBackend(home, install, arg, schema);
    return;
  }
  if (command === 'skills' && arg === 'list') {
    const list = skills(agentDir, directory, skillSources(home, install), new HostConfig().value);
    console.log(JSON.stringify(list.map(skill => ({ name: skill.name, description: skill.description, path: skill.filePath })), null, 2));
    return;
  }
  if (command === 'mcp' && arg === 'list') {
    const hub = new McpHub(directory);
    try {
      await hub.configureCustom(customMcp(agentDir, directory));
      console.log(JSON.stringify(hub.status(), null, 2));
    } finally { await hub.close(); }
    return;
  }
  if (command === 'reload') {
    atomicWrite(join(home, 'reload.request'), `${randomUUID()}\n`);
    console.log('Configuration reload scheduled for the next idle prompt');
    return;
  }
  throw new Error('Expected doctor, skills list, mcp list, or reload. Use install.ps1 to switch harnesses.');
}

void main(process.argv.slice(2)).catch(error => {
  console.error(`ShadowBotPi: ${error instanceof Error ? error.message : 'command failed'}`);
  process.exitCode = 1;
});
