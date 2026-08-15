#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createPool } from "./nodes.js";
import { createServer } from "./server.js";

const config = loadConfig();
const pool = createPool(config);
const server = createServer(pool);

await server.connect(new StdioServerTransport());
// stdout belongs to the MCP transport; anything human-facing goes to stderr.
console.error(
  `koinos-ai-mcp: serving ${config.nodes.length} node(s): ` +
    config.nodes.map((n) => `${n.name}=${n.baseUrl}`).join(", "),
);
