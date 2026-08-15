import { test } from "node:test";
import assert from "node:assert/strict";
import { KoinosAiClient, KoinosAiError, NodeUnreachableError } from "../src/client.js";
import { startFakeNode, FAKE_HEALTH } from "./fake-node.js";

test("GET returns parsed JSON", async () => {
  const node = await startFakeNode();
  try {
    const client = new KoinosAiClient({ baseUrl: node.url });
    assert.deepEqual(await client.get("/core/health"), FAKE_HEALTH);
  } finally {
    await node.close();
  }
});

test("sends Bearer header only when an API key is configured", async () => {
  const node = await startFakeNode();
  try {
    await new KoinosAiClient({ baseUrl: node.url }).get("/core/health");
    await new KoinosAiClient({ baseUrl: node.url, apiKey: "sekrit" }).get("/core/health");
    assert.equal(node.requests[0].authorization, null);
    assert.equal(node.requests[1].authorization, "Bearer sekrit");
  } finally {
    await node.close();
  }
});

test("non-2xx becomes KoinosAiError with status, without leaking the API key", async () => {
  const node = await startFakeNode({
    routes: { "/core/boom": { status: 500, body: { error: "kaboom" } } },
  });
  try {
    const client = new KoinosAiClient({ baseUrl: node.url, apiKey: "sekrit" });
    await assert.rejects(
      () => client.get("/core/boom"),
      (err) => {
        assert.ok(err instanceof KoinosAiError);
        assert.equal(err.status, 500);
        assert.ok(!err.message.includes("sekrit"));
        return true;
      },
    );
  } finally {
    await node.close();
  }
});

test("unreachable node produces a helpful error naming the base URL", async () => {
  // Port 1 is essentially guaranteed closed.
  const client = new KoinosAiClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 2000 });
  await assert.rejects(
    () => client.get("/core/health"),
    (err) => {
      assert.ok(err instanceof NodeUnreachableError);
      assert.match(err.message, /127\.0\.0\.1:1/);
      assert.match(err.message, /Koinos AI/);
      return true;
    },
  );
});

test("slow node hits the configured timeout", async () => {
  const node = await startFakeNode({ routes: { "/core/slow": { hang: true } } });
  try {
    const client = new KoinosAiClient({ baseUrl: node.url, timeoutMs: 100 });
    await assert.rejects(() => client.get("/core/slow"), /timed out after 100ms/);
  } finally {
    await node.close();
  }
});

test("per-request timeoutMs overrides the client default in both directions", async () => {
  const node = await startFakeNode({
    routes: {
      "/core/hang": { hang: true },
      "/core/slow": { status: 200, body: { ok: true }, delay: 300 },
    },
  });
  try {
    const client = new KoinosAiClient({ baseUrl: node.url, timeoutMs: 100 });
    // Raised: a response slower than the default succeeds under the override.
    assert.deepEqual(await client.get("/core/slow", { timeoutMs: 5000 }), { ok: true });
    // Lowered: the override, not the default, is what fires (and is reported).
    const hangClient = new KoinosAiClient({ baseUrl: node.url, timeoutMs: 60_000 });
    await assert.rejects(
      () => hangClient.get("/core/hang", { timeoutMs: 100 }),
      /timed out after 100ms/,
    );
  } finally {
    await node.close();
  }
});
