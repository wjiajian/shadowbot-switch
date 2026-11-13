import type { McpLocalConfig, McpRemoteConfig, McpStatus, Part, Session, SessionPromptAsyncData } from '@opencode-ai/sdk/v2';
import type { HostConfig } from './config.js';
import type { Store } from './store.js';
import type { Interactions } from './interactions.js';
import type { ShadowBotContext } from './shadowbot.js';
import type { SkillSources } from './host-skills.js';

export type Prompt = NonNullable<SessionPromptAsyncData['body']>;
export interface McpConnection {
  addBuiltin(name: string, config: McpLocalConfig | McpRemoteConfig): Promise<void>;
  reloadCustom(entries: Map<string, unknown>): Promise<unknown>;
  status(): Record<string, McpStatus>;
  configurationErrors(): Record<string, string>;
  connect(name: string): Promise<void>;
  disconnect(name: string): Promise<void>;
  close(): Promise<void>;
}
export interface HarnessRuns {
  active: ReadonlyMap<string, unknown>;
  interactions: Interactions;
  running(): { id: string }[];
  start(session: Session, prompt: Prompt): Promise<ReturnType<Store['message']>>;
  abort(sessionID: string): Promise<boolean>;
  rename(session: Session, title: string): Session;
  delete(session: Session): boolean;
  revert(session: Session, messageID: string): Session;
  unrevert(session: Session): Session;
  deleteMessage(session: Session, messageID: string): boolean;
  patchPart(session: Session, messageID: string, partID: string, input: Record<string, unknown>): Part;
}
export type AdapterContext = {
  store: Store; config: HostConfig; root: string; mcp: McpConnection; context: ShadowBotContext;
  home: string; resources: string; skillSources: SkillSources;
};
export interface HarnessAdapter {
  id: string;
  verify(version?: string): Promise<void>;
  createConfig(): HostConfig;
  createRuns(context: AdapterContext): HarnessRuns;
  mcp?: {
    create(root: string): McpConnection;
  };
}

export class NoMcp implements McpConnection {
  async addBuiltin() { throw new Error('This harness does not support MCP'); }
  async reloadCustom(entries: Map<string, unknown>) { if (entries.size) throw new Error('This harness does not support MCP'); }
  status() { return {}; }
  configurationErrors() { return {}; }
  async connect() { throw new Error('This harness does not support MCP'); }
  async disconnect() { throw new Error('This harness does not support MCP'); }
  async close() {}
}
