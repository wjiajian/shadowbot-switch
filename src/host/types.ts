export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; data: string; mimeType: string };
export type ContentBlock = TextBlock | ImageBlock;
export type ToolReference = { messageID: string; callID: string };
export type InteractionTarget = { sessionID: string; tool: ToolReference };
export type CanonicalToolKind = 'read' | 'list' | 'grep' | 'glob' | 'skill' | 'question' | 'task' | 'mcp' | 'other';
export type ToolDescriptor = { kind: CanonicalToolKind; permission: string; pathArg?: string; patternArg?: string };
