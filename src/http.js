// HTTP mode: serve the tool surface over MCP Streamable HTTP so remote
// clients (e.g. a claude.ai custom connector reached from a phone) can use it
// through a tunnel. Stateless: each request gets a fresh server+transport
// pair, so there is no session bookkeeping to leak or corrupt.
//
// Security model:
// - Binds 127.0.0.1 only — exposure happens via a tunnel you run, never by
//   listening on an interface.
// - Capability URL: the endpoint lives at /<token>/mcp. Anything else — wrong
//   token included — is a plain 404, so probes learn nothing.
// - Read-only by default: mutating tools are absent from the list and refused
//   by name unless writes are explicitly enabled.

import { createServer as createHttpServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

export function generateToken() {
  return randomBytes(24).toString("base64url");
}

function tokenMatches(candidate, token) {
  const a = Buffer.from(String(candidate ?? ""));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startHttp({ pool, port, token, allowWrites = false, compact = false }) {
  const httpServer = createHttpServer(async (req, res) => {
    try {
      const parts = new URL(req.url, "http://localhost").pathname.split("/");
      // Expect exactly ["", "<token>", "mcp"].
      if (parts.length !== 3 || parts[2] !== "mcp" || !tokenMatches(parts[1], token)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      let body;
      if (req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
          return;
        }
      }

      const server = createServer(pool, { compact, readOnly: !allowWrites });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
      console.error(`koinos-ai-mcp http: ${err.message}`);
    }
  });

  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => resolve(httpServer));
  });
}
