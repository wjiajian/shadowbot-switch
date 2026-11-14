import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessRegistry, harnessCapabilities, loadAdapter } from './harnesses.js';
import { installationHome, mode, originalHash, protocolVersion, readJson, installedVersion, runtimeHarness, runtimeDirectory, sha256 } from './installation.js';
import type { Installation } from './installation.js';
import { HostConfig } from './config.js';
import { skillSources } from './host-skills.js';
import { skillInventory } from './shadowbot.js';
import { syncSkillCommands } from './skill-commands.js';
import { thinkingEnabled } from './thinking-command.js';
import { assertHostStopped, switchBackend, verifySchema } from './switch.js';
import { manage, managementHelp } from './management.js';

async function main([command, arg]: string[]) {
  if (command === 'help' || command === '--help' || command === '-h') { console.log(managementHelp); return; }
  const home = installationHome();
  const install = readJson<Installation>(join(home, command === 'verify-install' ? 'prepared.json' : 'install.json'));
  const registry = new HarnessRegistry();
  if (!['verify-install', 'backend'].includes(command)) {
    const args = process.argv.slice(2);
    // Keep the original "skills list <app>" and "mcp list <app>" forms usable.
    if (['skills', 'mcp'].includes(command) && arg === 'list' && args[2] && !args[2].startsWith('--')) args.splice(2, 1, '--app', args[2]);
    return manage(home, install, args);
  }
  const runtime = runtimeDirectory(home, install);
  const schema = readFileSync(join(runtime, 'schema.sql'), 'utf8');
  const agentDir = join(home, 'agent');
  const backup = join(home, 'original', 'opencode.exe');
  if (command === 'verify-install') {
    const spec = registry.get(arg ?? runtimeHarness(install));
    const adapter = await loadAdapter(home, install, spec);
    await adapter.verify(installedVersion(install, spec.id));
    verifySchema(install.database, schema);
    if (install.originalHash.toLowerCase() !== originalHash || sha256(backup) !== originalHash) throw new Error('Original OpenCode checksum mismatch');
    if (process.version !== 'v24.22.3') throw new Error('Expected the bundled Node 24.22.3 runtime');
    if ((install.runtime || install.runtimeRelease) && sha256(join(runtime, 'launcher.exe')) !== install.launcherHash.toLowerCase()) {
      throw new Error('Staged launcher checksum mismatch');
    }
    const current = existsSync(join(home, 'backend.json')) ? mode(home) : registry.bundled().id;
    console.log(JSON.stringify({ harness: current, protocol: protocolVersion,
      backend: registry.selected(current).name,
      node: process.version, schema: 'verified', original: 'verified', release: install.runtime?.release ?? install.runtimeRelease,
      recoveryPending: existsSync(join(home, 'switch.pending.json')) || existsSync(join(home, 'activation.pending.json')) }, null, 2));
    return;
  }
  if (command === 'backend' && arg) {
    const harness = registry.get(arg);
    if (harness.kind === 'managed' && install.runtime && !install.harnesses?.[harness.id]) throw new Error('Target harness is not installed');
    assertHostStopped();
    if (install.originalHash.toLowerCase() !== originalHash || sha256(backup) !== originalHash) throw new Error('Original OpenCode checksum mismatch');
    if (sha256(install.agentPath) !== install.launcherHash.toLowerCase()) throw new Error('Active launcher checksum mismatch');
    await switchBackend(home, install, harness.id, schema);
    const config = new HostConfig().value;
    syncSkillCommands(install.resources, harnessCapabilities(install, harness).skills ? skillInventory(agentDir, undefined, skillSources(home, install, harness.id), config)
      .filter(row => row.source !== 'official' && row.status === 'enabled').map(row => row.skill!) : undefined, thinkingEnabled(harness.id, config));
    return;
  }
  throw new Error('Expected doctor, skills list, mcp list, or reload. Use install.ps1 to switch harnesses.');
}

void main(process.argv.slice(2)).catch(error => {
  const message = error instanceof Error ? error.message : '命令失败。运行 help 或 doctor 查看帮助。';
  if (process.argv.includes('--json')) console.log(JSON.stringify({ error: message }));
  else console.error(`ShadowBot Switch：${message}`);
  process.exitCode = 1;
});
