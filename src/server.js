import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

export function createServer(pool, { compact = false, readOnly = false } = {}) {
  const server = new Server(
    { name: "koinos-ai-mcp", version },
    { capabilities: { tools: {} } },
  );

  // readOnly (the HTTP-mode default) exposes only tools that cannot change
  // anything — mutating tools vanish from the list AND are refused by name.
  const visible = readOnly
    ? tools.filter((t) => t.annotations?.readOnlyHint !== false)
    : tools;

  // With one configured node the `node` argument can never do anything —
  // compact mode drops it (29 copies of a useless parameter add up).
  const dropNode = compact && pool.names.length === 1;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visible.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description: compact ? compactDescription(description, inputSchema) : description,
      inputSchema: compact ? compactSchema(inputSchema, dropNode) : inputSchema,
      ...(annotations && !compact ? { annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = visible.find((t) => t.name === name);
    if (!tool) {
      return errorResult(
        readOnly && tools.some((t) => t.name === name)
          ? `Tool "${name}" is disabled: this endpoint is read-only.`
          : `Unknown tool: ${name}`,
      );
    }
    try {
      const client = pool.resolve(args.node);
      const result = await tool.handler(client, args, pool);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResult(err.message ?? String(err));
    }
  });

  return server;
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// Compact mode exists for small-context local models (e.g. Koinos AI's own
// Agent mode on a 4096-token llama.cpp context): full frontier-grade tool
// descriptions cost ~3.5k tokens across 29 tools and crowd out the actual
// conversation. Keep the first sentence — plus the confirm contract, which an
// agent must never lose — and drop per-parameter prose.
function compactDescription(description, inputSchema) {
  const first = description.split(/(?<=\.)\s+/)[0];
  const gated = Boolean(inputSchema?.properties?.confirm);
  return gated && !/confirm/i.test(first)
    ? `${first} Requires confirm:true (without it: preview only, no changes).`
    : first;
}

function compactSchema(schema, dropNode = false) {
  if (!schema?.properties) return schema;
  const properties = Object.fromEntries(
    Object.entries(schema.properties)
      .filter(([key]) => !(dropNode && key === "node"))
      .map(([key, prop]) => {
        const { description: _dropped, ...rest } = prop;
        return [key, rest.properties ? compactSchema(rest) : rest];
      }),
  );
  return { ...schema, properties };
}
