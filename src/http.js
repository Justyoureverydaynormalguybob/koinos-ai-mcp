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
// - Read-only by default: only tools marked read-only are served; mutating
//   tools are absent from the list and refused by name unless writes are
//   explicitly enabled. Even then, outward-facing tools stay local-only and
//   privacy can only be tightened to local-only.
// - Request bodies are capped at 1 MB, and tokens shorter than 32 characters
//   are refused at startup.
// - The token sits in the URL path, so it also lands wherever URLs are
//   logged (tunnel, proxies, the connector's settings). Treat the URL itself
//   as the secret and rotate it if it leaks.

import { createServer as createHttpServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

export function generateToken() {
  return randomBytes(24).toString("base64url");
}

// A capability URL is only as strong as its token: refuse short ones.
export const MIN_TOKEN_LENGTH = 32;
const MAX_BODY = 1024 * 1024;

function tokenMatches(candidate, token) {
  const a = Buffer.from(String(candidate ?? ""));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startHttp({ pool, port, token, allowWrites = false, compact = false }) {
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `KOINOS_AI_HTTP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters ` +
        "(leave it unset to get a random one).",
    );
  }
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
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) {
            res.writeHead(413, { "content-type": "application/json", connection: "close" });
            res.end(JSON.stringify({ error: "request too large" }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
          return;
        }
      }

      const server = createServer(pool, { compact, readOnly: !allowWrites, http: true });
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
