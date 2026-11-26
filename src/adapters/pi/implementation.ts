import { VERSION } from '@earendil-works/pi-coding-agent';
import type { HarnessAdapter } from '../../adapter.js';
import { HostConfig } from './config.js';
import { McpHub } from './mcp.js';
import { PiDriver } from './driver.js';
import { createHostRuns } from '../../host/runs.js';

export const adapter: HarnessAdapter = {
  id: 'pi',
  async verify(version) {
    if (version && version !== VERSION) throw new Error('Installed Pi version does not match the manifest');
  },
  createConfig: () => new HostConfig(),
  createRuns: ctx => createHostRuns(ctx, new PiDriver(ctx)),
  mcp: { create: root => new McpHub(root) },
};
