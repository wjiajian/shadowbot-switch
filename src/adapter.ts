import type { McpLocalConfig, McpRemoteConfig, McpStatus, Part, Session, SessionPromptAsyncData } from '@opencode-ai/sdk/v2';
import type { HostConfig } from './config.js';
import type { Store } from './store.js';
import type { Interactions } from './interactions.js';
import type { ShadowBotContext } from './shadowbot.js';
import type { SkillSources } from './host-skills.js';

export type Prompt = NonNullable<SessionPromptAsyncData['body']>;
/** Per-turn input that the shared layer prepares for every harness, separate from the host prompt. */
export type RunInput = {
  /**
   * AGENTS.md rules for this workspace, reread for every turn and already bounded and validated.
   * Append them to the model's system instructions. Keep them out of `prompt.system`, which is
   * persisted and echoed back to the host. Empty when no rules apply.
   */
  instructions: string;
};
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
  start(session: Session, prompt: Prompt, run: RunInput): Promise<ReturnType<Store['message']>>;
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

/**
 * TypeScript lets an implementation declare fewer parameters, so a legacy `start(session, prompt)`
 * still type-checks and silently drops `run.instructions`. Reject such runs when they are created.
 */
export function assertRunsContract<T extends HarnessRuns>(runs: T, harness: string): T {
  if (typeof runs?.start !== 'function' || runs.start.length < 3) {
    throw new Error(`Harness ${harness} must declare start(session, prompt, run) and append run.instructions to its system prompt`);
  }
  return runs;
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
