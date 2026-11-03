// HTTP mode: Streamable HTTP transport, capability-URL auth, read-only default.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttp, generateToken } from "../src/http.js";
import { createPool } from "../src/nodes.js";
import { startFakeNode, FAKE_HEALTH } from "./fake-node.js";

const TOKEN = generateToken();

async function startStack({ allowWrites = false } = {}) {
  const node = await startFakeNode();
  const pool = createPool({
    nodes: [{ name: "local", baseUrl: node.url, timeoutMs: 10_000 }],
    defaultNode: "local",
  });
  const httpServer = await startHttp({ pool, port: 0, token: TOKEN, allowWrites });
  const port = httpServer.address().port;
  return {
    node,
    url: (tok = TOKEN) => new URL(`http://127.0.0.1:${port}/${tok}/mcp`),
    close: () =>
      Promise.all([
        node.close(),
        new Promise((done) => {
          httpServer.closeAllConnections();
          httpServer.close(done);
        }),
      ]),
  };
}

async function connectClient(url) {
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

test("http mode serves tools over Streamable HTTP and is read-only by default", async () => {
  const stack = await startStack();
  try {
    const client = await connectClient(stack.url());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("health") && names.includes("account_status"));
    // No mutating tool is visible…
    assert.ok(!names.some((n) => /earn_stop|model_uninstall|model_ensure|feedback_send/.test(n)));
    for (const t of tools) assert.notEqual(t.annotations?.readOnlyHint, false, t.name);

    // …and reads actually work end-to-end.
    const health = await client.callTool({ name: "health", arguments: {} });
    assert.deepEqual(JSON.parse(health.content[0].text), FAKE_HEALTH);

    // …and a mutating tool is refused by name, telling the caller why.
    const refused = await client.callTool({ name: "earn_stop", arguments: { confirm: true } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /read-only/);
    assert.equal(stack.node.requests.filter((r) => r.method !== "GET").length, 0);
    await client.close();
  } finally {
    await stack.close();
  }
});

test("http writes mode exposes mutating tools, confirm gates intact", async () => {
  const stack = await startStack({ allowWrites: true });
  try {
    const client = await connectClient(stack.url());
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "earn_stop"));
    const preview = await client.callTool({ name: "earn_stop", arguments: {} });
    assert.equal(JSON.parse(preview.content[0].text).executed, false);
    await client.close();
  } finally {
    await stack.close();
  }
});

test("wrong or missing token is a plain 404 that reveals nothing", async () => {
  const stack = await startStack();
  try {
    for (const bad of [stack.url(generateToken()), new URL(stack.url().origin + "/mcp")]) {
      const res = await fetch(bad, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      assert.equal(res.status, 404, String(bad));
      assert.deepEqual(await res.json(), { error: "not found" });
    }
    // And the SDK client fails to connect with a bad token.
    await assert.rejects(() => connectClient(stack.url(generateToken())));
  } finally {
    await stack.close();
  }
});

test("every tool is explicitly read-only or mutating; read-only HTTP serves only the former", async () => {
  const { tools } = await import("../src/tools.js");
  for (const t of tools) assert.equal(typeof t.annotations?.readOnlyHint, "boolean", t.name);
  const stack = await startStack();
  try {
    const client = await connectClient(stack.url());
    const listed = (await client.listTools()).tools;
    const expected = tools.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name).sort();
    assert.deepEqual(listed.map((t) => t.name).sort(), expected);
    await client.close();
  } finally {
    await stack.close();
  }
});

test("http writes mode still keeps feedback local-only and privacy to local-only", async () => {
  const stack = await startStack({ allowWrites: true });
  try {
    const client = await connectClient(stack.url());
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("feedback_send"));
    const feedback = await client.callTool({ name: "feedback_send", arguments: { message: "hi", confirm: true } });
    assert.equal(feedback.isError, true);
    assert.match(feedback.content[0].text, /not available over HTTP/);

    const loosen = await client.callTool({ name: "network_set_privacy_mode", arguments: { mode: "network", confirm: true } });
    assert.equal(loosen.isError, true);
    assert.match(loosen.content[0].text, /local-only/);
    assert.equal(stack.node.requests.filter((r) => r.method !== "GET").length, 0);

    const tighten = await client.callTool({ name: "network_set_privacy_mode", arguments: { mode: "local-only" } });
    assert.equal(JSON.parse(tighten.content[0].text).executed, false); // preview, gate intact
    await client.close();
  } finally {
    await stack.close();
  }
});

test("short tokens are refused and oversized bodies get 413", async () => {
  const pool = createPool({ nodes: [{ name: "local", baseUrl: "http://127.0.0.1:1", timeoutMs: 1000 }], defaultNode: "local" });
  assert.throws(() => startHttp({ pool, port: 0, token: "short-secret" }), /at least 32/);
  const stack = await startStack();
  try {
    const res = await fetch(stack.url(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }),
    });
    assert.equal(res.status, 413);
  } finally {
    await stack.close();
  }
});
