import { VERSION } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import type { HarnessAdapter } from '../../adapter.js';
import { HostConfig } from './config.js';
import { McpHub, validateCustomMcp } from './mcp.js';
import { Runs } from './runner.js';

export const adapter: HarnessAdapter = {
  id: 'pi',
  async verify(version) {
    if (version && version !== VERSION) throw new Error('Installed Pi version does not match the manifest');
  },
  createConfig: () => new HostConfig(),
  createRuns({ store, config, root, mcp, context, home, resources, skillSources }) {
    process.env.PI_CODING_AGENT_DIR = join(home, 'harnesses', 'pi', 'agent');
    return new Runs(store, config as HostConfig, root, mcp as McpHub, context, home, resources, skillSources);
  },
  mcp: { create: root => new McpHub(root), validate: validateCustomMcp },
};
