#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createPool } from "./nodes.js";
import { createServer } from "./server.js";
import { startHttp, generateToken } from "./http.js";

const config = loadConfig();
const pool = createPool(config);
const flag = (name) => process.argv.includes(name);
const flagValue = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
// --compact (or KOINOS_AI_COMPACT=1) serves short tool descriptions for
// small-context local models, e.g. Koinos AI's own Agent mode.
const compact = flag("--compact") || /^(1|true)$/i.test(process.env.KOINOS_AI_COMPACT ?? "");

const httpPort = Number.parseInt(
  flagValue("--http") ?? process.env.KOINOS_AI_HTTP_PORT ?? "",
  10,
);

if (httpPort) {
  // HTTP mode: read-only unless writes are explicitly enabled; the endpoint
  // hides behind a capability token; binds localhost (expose via a tunnel).
  const allowWrites =
    flag("--http-writes") || /^(1|true)$/i.test(process.env.KOINOS_AI_HTTP_WRITES ?? "");
  const token = process.env.KOINOS_AI_HTTP_TOKEN || generateToken();
  await startHttp({ pool, port: httpPort, token, allowWrites, compact });
  console.error(
    `koinos-ai-mcp: http mode on http://127.0.0.1:${httpPort}/${token}/mcp ` +
      `(${allowWrites ? "WRITES ENABLED" : "read-only"}; ` +
      `${config.nodes.map((n) => `${n.name}=${n.baseUrl}`).join(", ")})`,
  );
  console.error(
    process.env.KOINOS_AI_HTTP_TOKEN
      ? "koinos-ai-mcp: token from KOINOS_AI_HTTP_TOKEN"
      : "koinos-ai-mcp: generated a fresh token (set KOINOS_AI_HTTP_TOKEN for a stable URL)",
  );
} else {
  const server = createServer(pool, { compact });
  await server.connect(new StdioServerTransport());
  // stdout belongs to the MCP transport; anything human-facing goes to stderr.
  console.error(
    `koinos-ai-mcp: serving ${config.nodes.length} node(s)${compact ? " [compact]" : ""}: ` +
      config.nodes.map((n) => `${n.name}=${n.baseUrl}`).join(", "),
  );
}
