import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = 'https://mcp.zapier.com/api/v1/connect';

function matchingField(properties, names) {
  return Object.keys(properties).find((key) => names.some((name) => key.toLowerCase().replace(/[^a-z0-9]/g, '') === name));
}

export async function createGmailDraft(draft) {
  const token = process.env.ZAPIER_MCP_TOKEN;
  if (!token) throw new Error('Zapier MCP is not configured on the server');
  const client = new Client({ name: 'sample-kitchen-planner', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools || [];
    const matches = tools.filter((tool) => /gmail/i.test(`${tool.name} ${tool.description || ''}`) &&
      /create[ _-]?draft/i.test(`${tool.name} ${tool.description || ''}`));
    if (matches.length !== 1) throw new Error('Zapier must expose exactly one Gmail Create Draft action on a managed MCP server');
    const action = matches[0];
    const properties = action.inputSchema?.properties || {};
    const toField = matchingField(properties, ['to', 'toaddress', 'recipient', 'recipients']);
    const subjectField = matchingField(properties, ['subject']);
    const bodyField = matchingField(properties, ['body', 'message', 'emailbody', 'content']);
    if (!toField || !subjectField || !bodyField) throw new Error('Gmail Create Draft fields are not mapped; check the Zapier action configuration');
    const args = { [toField]: draft.to, [subjectField]: draft.subject, [bodyField]: draft.body };
    const missing = (action.inputSchema.required || []).filter((field) => !(field in args));
    if (missing.length) throw new Error(`Zapier action requires additional fields: ${missing.join(', ')}`);
    const result = await client.callTool({ name: action.name, arguments: args });
    if (result.isError) {
      const detail = (result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join(' ')
        .replaceAll(token, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
      throw new Error(`Zapier Gmail Create Draft returned an error${detail ? `: ${detail}` : ''}`);
    }
    return { action: action.name, result: result.content || [] };
  } finally {
    await client.close().catch(() => {});
  }
}
