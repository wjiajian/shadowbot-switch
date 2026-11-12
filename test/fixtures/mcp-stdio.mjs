import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) continue;
  const results = {
    initialize: { protocolVersion: message.params?.protocolVersion, serverInfo: { name: 'stdio-fixture', version: '1' }, capabilities: { tools: {} } },
    'tools/list': { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] },
    'tools/call': { content: [{ type: 'text', text: 'stdio fixture output' }] },
  };
  const result = results[message.method];
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
