#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createPool } from "./nodes.js";
import { createServer } from "./server.js";

const config = loadConfig();
const pool = createPool(config);
// --compact (or KOINOS_AI_COMPACT=1) serves short tool descriptions for
// small-context local models, e.g. Koinos AI's own Agent mode.
const compact =
  process.argv.includes("--compact") ||
  /^(1|true)$/i.test(process.env.KOINOS_AI_COMPACT ?? "");
const server = createServer(pool, { compact });

await server.connect(new StdioServerTransport());
// stdout belongs to the MCP transport; anything human-facing goes to stderr.
console.error(
  `koinos-ai-mcp: serving ${config.nodes.length} node(s)${compact ? " [compact]" : ""}: ` +
    config.nodes.map((n) => `${n.name}=${n.baseUrl}`).join(", "),
);
