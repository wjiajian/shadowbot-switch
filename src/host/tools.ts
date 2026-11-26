import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, QuestionInfo, Session } from '@opencode-ai/sdk/v2';
import type { Prompt } from '../adapter.js';
import { copilot, explorer, object } from '../config.js';
import { outsideWorkspace } from '../config-paths.js';
import { decision, permissionMayAllow, type Interactions } from '../interactions.js';
import { userSettings } from '../shadowbot.js';
import type { Skill } from '../skills.js';
import type { TextBlock, ToolDescriptor, ToolReference } from './types.js';
import { QUESTION_TOOL, READ_TOOL, SKILL_TOOL, TASK_TOOL } from './tool-names.js';

function string(value: unknown) { return typeof value === 'string' ? value : ''; }

export function filesystemPath(root: string, input: string) {
  let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '');
  if (process.platform === 'win32') {
    path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i, (_, drive, tail) => `${drive}:/${tail ?? ''}`);
  }
  if (path === '~' || /^~[/\\]/.test(path)) path = join(homedir(), path.slice(2));
  if (path.startsWith('file://')) path = fileURLToPath(path);
  return realpathSync.native(resolve(root, path));
}

export type TurnToolPolicy = { policies: unknown[]; customPolicy: unknown; enabled(name: string): boolean };

export function turnToolPolicy(config: Config, agent: string, session: Session, prompt: Prompt, agentDir: string, root: string): TurnToolPolicy {
  const role = config.agent?.[agent];
  const policies = [config.permission, role?.permission, session.permission];
  const customPolicy = userSettings(agentDir, root).mcpPermission;
  const enabled = (name: string) => prompt.tools?.[name] !== false && role?.tools?.[name] !== false;
  return { enabled, policies, customPolicy };
}

export function visibleMcpTools<T extends { builtin: boolean; server: string }>(tools: Map<string, T>, agent: string,
  { enabled, policies, customPolicy }: TurnToolPolicy) {
  return new Map([...tools].filter(([name, tool]) => {
    if (!enabled(name) || !permissionMayAllow(name, ...(tool.builtin ? policies : [customPolicy]))) return false;
    if (agent === explorer) return !tool.builtin || tool.server === 'xbot-copilot' || tool.server === 'browser-use-mcp';
    return tool.server !== 'browser-use-mcp';
  }));
}

export function hostToolNames(agent: string): string[] {
  const names = [SKILL_TOOL, QUESTION_TOOL, READ_TOOL];
  if (agent === copilot) names.push(TASK_TOOL, 'grep', 'find', 'ls');
  return names;
}

export type Authorization = { allow: true; checkedPath?: string } | { allow: false; reason: string };

export async function authorizeToolCall(o: {
  name: string; args: Record<string, unknown>; root: string; policy: TurnToolPolicy;
  skills: { name: string; source: string }[]; mcp(name: string): { builtin: boolean } | undefined;
  descriptors: Record<string, ToolDescriptor>; interactions: Interactions; sessionID: string; interactionSession: string;
  reference(): ToolReference; signal: AbortSignal;
}): Promise<Authorization> {
  const { name, args: input, root, signal, interactionSession } = o;
  const { enabled, policies, customPolicy } = o.policy;
  if (!enabled(name)) return { allow: false, reason: 'Tool disabled for this turn' };
  const custom = o.mcp(name);
  const skill = name === 'skill' ? o.skills.find(candidate => candidate.name === input.name) : undefined;
  if (name === 'skill' && !skill) return { allow: false, reason: 'The requested skill is unavailable' };
  const subagent = string(input.subagent_type);
  let target = skill?.name ?? (name === 'task' ? (subagent === 'explore' ? explorer : subagent) :
    string(input.filePath ?? input.path ?? input.command) || name);
  const descriptor = Object.hasOwn(o.descriptors, name) ? o.descriptors[name] : undefined;
  const permission = descriptor?.permission ?? name;
  let external: { path: string; directory: string; pattern: string } | undefined;
  let checkedPath: string | undefined;
  if (descriptor && ['read', 'list', 'grep', 'glob'].includes(descriptor.kind)) {
    try {
      const path = filesystemPath(root, string(input[descriptor.pathArg ?? 'path']));
      const fromRoot = relative(root, path);
      if (outsideWorkspace(fromRoot)) {
        const directory = statSync(path).isDirectory() ? path : dirname(path);
        external = { path, directory, pattern: join(directory, '*') };
      }
      target = permission === 'read' ? fromRoot : string(input[descriptor.patternArg ?? 'pattern']);
      checkedPath = path;
    } catch { return { allow: false, reason: 'The filesystem path is unavailable' }; }
  }
  const rule = skill?.source === 'custom' ? 'allow' : custom && !custom.builtin
    ? decision(name, target, 'ask', customPolicy)
    : decision(permission, target, name === 'question' || skill ? 'allow' : 'ask', ...policies);
  if (rule === 'deny') return { allow: false, reason: 'Tool denied by the workspace permission policy' };
  const reference = o.reference();
  if (external) {
    const { pattern, path, directory } = external;
    const access = decision('external_directory', pattern, 'ask', ...policies);
    if (access === 'deny') return { allow: false, reason: 'Access outside the workspace is denied' };
    if (access === 'ask' && !await o.interactions.permission(o.sessionID, 'external_directory', reference, signal, {
      patterns: [pattern], always: [pattern], metadata: { filepath: path, parentDir: directory },
    }, interactionSession)) return { allow: false, reason: 'Access outside the workspace was declined' };
  }
  const skillScope = skill ? { patterns: [skill.name], always: [skill.name], metadata: {} } : undefined;
  if (rule === 'ask' && !await o.interactions.permission(o.sessionID, permission, reference, signal, skillScope, interactionSession)) {
    return { allow: false, reason: 'Permission denied by the user' };
  }
  if (signal.aborted) return { allow: false, reason: 'Run cancelled' };
  if (checkedPath) {
    try { if (realpathSync.native(checkedPath) === checkedPath) return { allow: true, checkedPath }; }
    catch { /* the approved path no longer exists */ }
    return { allow: false, reason: 'The filesystem path changed before the tool could run' };
  }
  return { allow: true };
}

type ToolResult = { content: TextBlock[]; details: Record<string, unknown> };
export type HostToolSpec = {
  name: string; label: string; description: string; parameters: Record<string, unknown>;
  execute(callID: string, args: unknown): Promise<ToolResult>;
};

function schema(properties: Record<string, unknown>, required: string[]) {
  return { type: 'object', properties, required, additionalProperties: false };
}
const textSchema = { type: 'string', minLength: 1 };

export function skillTool(skills: Pick<Skill, 'name' | 'filePath' | 'baseDir'>[]): HostToolSpec {
  return { name: SKILL_TOOL, label: 'Skill', description: 'Read the instructions of an enabled skill.',
    parameters: schema({ name: textSchema }, ['name']), execute: async (_callID, args) => {
      const skill = object(args) ? skills.find(skill => skill.name === args.name) : undefined;
      if (!skill) throw new Error('The requested skill is unavailable');
      const text = [readFileSync(skill.filePath, 'utf8').trim(), `Base directory for this skill: ${skill.baseDir}`,
        'Resolve the relative paths in this skill from that directory.'].join('\n\n');
      return { content: [{ type: 'text', text }], details: { name: skill.name, dir: skill.baseDir } };
    } };
}

export function questionTool({ interactions, interactionSession, reference, signal }: {
  interactions: Interactions; interactionSession: string; reference(callID: string): ToolReference; signal: AbortSignal;
}): HostToolSpec {
  return { name: QUESTION_TOOL, label: '提问', description: 'Ask the user to choose an option before continuing.',
    parameters: schema({ questions: { type: 'array', minItems: 1, items: schema({ question: textSchema, header: textSchema,
      multiple: { type: 'boolean' }, custom: { type: 'boolean' }, options: { type: 'array', minItems: 1,
        items: schema({ label: textSchema, description: { type: 'string' } }, ['label', 'description']) },
    }, ['question', 'header', 'options']) } }, ['questions']), execute: async (callID, args) => {
      if (!object(args) || !Array.isArray(args.questions) || !args.questions.length || args.questions.length > 10) throw new Error('Invalid questions');
      const answers = await interactions.question(interactionSession, args.questions as QuestionInfo[], reference(callID), signal);
      return { content: [{ type: 'text', text: JSON.stringify(answers) }], details: { answers } };
    } };
}

export function taskTool({ run }: { run(callID: string, args: Record<string, unknown>): Promise<ToolResult> }): HostToolSpec {
  return { name: TASK_TOOL, label: 'Explorer', description: 'Delegate a web exploration task to shadowbot-explorer.',
    parameters: schema({ description: textSchema, prompt: textSchema, subagent_type: textSchema, task_id: { type: 'string' } }, ['description', 'prompt', 'subagent_type']),
    execute: (callID, args) => run(callID, object(args) ? args : {}),
  };
}
