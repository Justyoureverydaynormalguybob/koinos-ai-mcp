// End-to-end: spawn the real bin entry (src/index.js) as a subprocess and talk
// to it over stdio, the way an MCP client actually will.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeNode, FAKE_HEALTH } from "./fake-node.js";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("the stdio binary serves tools end-to-end", async () => {
  const node = await startFakeNode();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, KOINOS_AI_BASE_URL: node.url },
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("health") && names.includes("models_list"), names.join(","));

    const result = await client.callTool({ name: "health", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), FAKE_HEALTH);
  } finally {
    await client.close();
    await node.close();
  }
});
