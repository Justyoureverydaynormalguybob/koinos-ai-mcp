// Integration: a real MCP client talking to our server over an in-memory
// transport, with the server's HTTP client pointed at the fake node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { createPool } from "../src/nodes.js";
import { tools } from "../src/tools.js";
import { startFakeNode, FAKE_MODELS } from "./fake-node.js";

// `nodes`: a name → baseUrl map (or a single URL string for the common case).
async function connect(nodes, timeoutMs = 10_000) {
  const entries = typeof nodes === "string" ? { local: nodes } : nodes;
  const pool = createPool({
    nodes: Object.entries(entries).map(([name, baseUrl]) => ({ name, baseUrl, timeoutMs })),
    defaultNode: Object.keys(entries)[0],
  });
  const server = createServer(pool);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

test("tool names are MCP/Claude-safe (snake_case, no dots)", () => {
  for (const tool of tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/, tool.name);
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
  }
});

test("tools/list exposes the full read surface", async () => {
  const { client, close } = await connect("http://127.0.0.1:1");
  try {
    const { tools: listed } = await client.listTools();
    const names = listed.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "chat_delete",
      "chat_get",
      "chat_rename",
      "chats_list",
      "doc_get",
      "docs_list",
      "earn_start",
      "earn_status",
      "earn_stop",
      "health",
      "key_create",
      "key_revoke",
      "key_set_budget",
      "keys_list",
      "model_ensure",
      "models_list",
      "network_models",
      "network_overview",
      "network_set_privacy_mode",
      "network_status",
      "nodes_status",
      "task_create",
      "task_delete",
      "task_run_now",
      "task_set_enabled",
      "tasks_list",
    ]);
    for (const t of listed) {
      assert.equal(t.inputSchema.type, "object");
      // Every mutating tool is labelled bluntly and requires confirm.
      if (t.annotations?.readOnlyHint === false) {
        assert.match(t.description, /^MUTATING/, t.name);
        assert.ok(t.inputSchema.properties.confirm, t.name);
      }
    }
  } finally {
    await close();
  }
});

test("calling models_list returns the node's model data", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    const result = await client.callTool({ name: "models_list", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), FAKE_MODELS);
  } finally {
    await close();
    await node.close();
  }
});

test("chats_list strips transcript text; chat_get returns it", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    const list = await client.callTool({ name: "chats_list", arguments: {} });
    const listData = JSON.parse(list.content[0].text);
    assert.equal(listData.chats[0].id, "chat1");
    assert.equal("searchText" in listData.chats[0], false);
    assert.ok(!list.content[0].text.includes("transcript dump"));

    const one = await client.callTool({ name: "chat_get", arguments: { id: "chat1" } });
    const chatData = JSON.parse(one.content[0].text);
    assert.equal(chatData.chat.messages.length, 2);
  } finally {
    await close();
    await node.close();
  }
});

test("chat_get without an id is an isError result, and ids are URL-encoded", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    const missing = await client.callTool({ name: "chat_get", arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Missing required argument: id/);

    await client.callTool({ name: "chat_get", arguments: { id: "a/../b" } });
    const hit = node.requests.find((r) => r.path.startsWith("/core/chats/a"));
    assert.equal(hit.path, "/core/chats/a%2F..%2Fb");
  } finally {
    await close();
    await node.close();
  }
});

test("read tools return live node data", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    for (const [name, probe] of [
      ["earn_status", (d) => d.worker.running === false],
      ["network_status", (d) => d.privacyMode === "local-only"],
      ["network_models", (d) => d.workersOnline === 3 && d.models.length === 3],
      ["network_overview", (d) => d.reachable === true && d.workers[0].perf.jobs === 26],
      ["tasks_list", (d) => Array.isArray(d.tasks)],
      ["docs_list", (d) => Array.isArray(d.docs)],
      ["keys_list", (d) => d.required === false],
    ]) {
      const result = await client.callTool({ name, arguments: {} });
      assert.notEqual(result.isError, true, name);
      assert.ok(probe(JSON.parse(result.content[0].text)), name);
    }
  } finally {
    await close();
    await node.close();
  }
});

test("mutating tools without confirm change nothing and return a preview", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    for (const [name, args] of [
      ["earn_start", {}],
      ["earn_stop", { confirm: false }],
      ["network_set_privacy_mode", { mode: "network" }],
      ["task_create", { name: "n", prompt: "p", model: "koinos-fast", schedule: { kind: "daily" } }],
      ["task_run_now", { id: "t123" }],
      ["task_delete", { id: "t123" }],
      ["task_set_enabled", { id: "t123", enabled: false }],
      ["chat_rename", { id: "chat1", title: "new title" }],
      ["chat_delete", { id: "chat1" }],
      ["key_create", { name: "ci" }],
      ["key_revoke", { id: "key_ab12cd34ef56" }],
      ["key_set_budget", { id: "key_ab12cd34ef56", budgetUsdMonthly: 5 }],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, name);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.executed, false, name);
      assert.equal(data.requiresConfirmation, true, name);
    }
    // Not a single write reached the node.
    const writes = node.requests.filter((r) => r.method !== "GET");
    assert.deepEqual(writes, []);
  } finally {
    await close();
    await node.close();
  }
});

test("with confirm: true the writes fire with the right method, path, and body", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    const start = await client.callTool({ name: "earn_start", arguments: { confirm: true } });
    assert.equal(JSON.parse(start.content[0].text).worker.running, true);

    await client.callTool({
      name: "network_set_privacy_mode",
      arguments: { mode: "local-first", confirm: true },
    });
    await client.callTool({
      name: "task_create",
      arguments: {
        name: "morning",
        prompt: "summarize",
        model: "koinos-fast",
        schedule: { kind: "daily", hour: 7 },
        confirm: true,
      },
    });
    await client.callTool({ name: "task_delete", arguments: { id: "t123", confirm: true } });
    await client.callTool({
      name: "task_set_enabled",
      arguments: { id: "t123", enabled: false, confirm: true },
    });
    await client.callTool({
      name: "chat_rename",
      arguments: { id: "chat1", title: "renamed", confirm: true },
    });
    await client.callTool({ name: "chat_delete", arguments: { id: "chat1", confirm: true } });

    const writes = node.requests.filter((r) => r.method !== "GET");
    assert.deepEqual(
      writes.map((r) => `${r.method} ${r.path}`),
      [
        "POST /core/earn/start",
        "POST /core/network/config",
        "POST /core/tasks",
        "DELETE /core/tasks/t123",
        "PATCH /core/tasks/t123",
        "PATCH /core/chats/chat1",
        "DELETE /core/chats/chat1",
      ],
    );
    assert.deepEqual(JSON.parse(writes[1].body), { privacyMode: "local-first" });
    assert.deepEqual(JSON.parse(writes[2].body), {
      name: "morning",
      prompt: "summarize",
      model: "koinos-fast",
      schedule: { kind: "daily", hour: 7 },
    });
    assert.deepEqual(JSON.parse(writes[4].body), { enabled: false });
    assert.deepEqual(JSON.parse(writes[5].body), { title: "renamed" });
  } finally {
    await close();
    await node.close();
  }
});

test("task_run_now outlives the general request timeout (runs can involve a model swap)", async () => {
  const node = await startFakeNode({
    routes: {
      "POST /core/tasks/t123/run": {
        status: 200,
        body: { ok: true, task: { id: "t123", lastChatId: "chat1" } },
        delay: 300,
      },
    },
  });
  const { client, close } = await connect(node.url, 100);
  try {
    const result = await client.callTool({
      name: "task_run_now",
      arguments: { id: "t123", confirm: true },
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.equal(JSON.parse(result.content[0].text).task.lastChatId, "chat1");
  } finally {
    await close();
    await node.close();
  }
});

test("task_run_now reads the assistant's answer back from the run's chat", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    const result = await client.callTool({
      name: "task_run_now",
      arguments: { id: "t123", confirm: true },
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.task.lastChatId, "chat1");
    assert.equal(data.answer, "hi there");
    assert.ok(node.requests.some((r) => r.method === "GET" && r.path === "/core/chats/chat1"));
  } finally {
    await close();
    await node.close();
  }
});

test("task_run_now is fail-soft when the run's chat can't be read back", async () => {
  const node = await startFakeNode({
    routes: {
      "POST /core/tasks/t123/run": {
        status: 200,
        body: { ok: true, task: { id: "t123", lastChatId: "ghost" } },
      },
    },
  });
  const { client, close } = await connect(node.url);
  try {
    const result = await client.callTool({
      name: "task_run_now",
      arguments: { id: "t123", confirm: true },
    });
    // The run succeeded; a lagging chat index must not turn it into an error.
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.answer, null);
    assert.match(data.answerHint, /chat_get/);
    assert.match(data.answerHint, /Do not run the task again/);
  } finally {
    await close();
    await node.close();
  }
});

test("key management: secret surfaces once on create; budget and revoke hit the node", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    // With zero keys on the node, the preview warns about the auth flip.
    const preview = await client.callTool({ name: "key_create", arguments: { name: "ci" } });
    const previewData = JSON.parse(preview.content[0].text);
    assert.equal(previewData.executed, false);
    assert.match(previewData.wouldDo, /FIRST key/);
    assert.match(previewData.wouldDo, /exactly once/);

    const created = await client.callTool({
      name: "key_create",
      arguments: { name: "ci", confirm: true },
    });
    assert.equal(JSON.parse(created.content[0].text).secret, "kai_sk_test-shown-once");

    await client.callTool({
      name: "key_set_budget",
      arguments: { id: "key_ab12cd34ef56", budgetUsdMonthly: 5, confirm: true },
    });
    await client.callTool({
      name: "key_set_budget",
      arguments: { id: "key_ab12cd34ef56", budgetUsdMonthly: null, confirm: true },
    });
    const bogus = await client.callTool({
      name: "key_set_budget",
      arguments: { id: "key_ab12cd34ef56", budgetUsdMonthly: "five", confirm: true },
    });
    assert.equal(bogus.isError, true);
    assert.match(bogus.content[0].text, /non-negative number/);

    await client.callTool({
      name: "key_revoke",
      arguments: { id: "key_ab12cd34ef56", confirm: true },
    });

    const writes = node.requests.filter((r) => r.method !== "GET");
    assert.deepEqual(
      writes.map((r) => `${r.method} ${r.path}`),
      [
        "POST /core/keys",
        "POST /core/keys/key_ab12cd34ef56/budget",
        "POST /core/keys/key_ab12cd34ef56/budget",
        "DELETE /core/keys/key_ab12cd34ef56",
      ],
    );
    assert.deepEqual(JSON.parse(writes[0].body), { name: "ci" });
    assert.deepEqual(JSON.parse(writes[1].body), { budgetUsdMonthly: 5 });
    assert.deepEqual(JSON.parse(writes[2].body), { budgetUsdMonthly: null });
  } finally {
    await close();
    await node.close();
  }
});

test("model_ensure without confirm reports size from the catalog and downloads nothing", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    const preview = await client.callTool({
      name: "model_ensure",
      arguments: { alias: "koinos-balanced" },
    });
    const data = JSON.parse(preview.content[0].text);
    assert.equal(data.executed, false);
    assert.equal(data.size, "2.0 GB");
    assert.equal(node.requests.filter((r) => r.method === "POST").length, 0);

    const bogus = await client.callTool({ name: "model_ensure", arguments: { alias: "nope" } });
    assert.equal(bogus.isError, true);
    assert.match(bogus.content[0].text, /Known aliases: koinos-fast, koinos-balanced/);

    const fired = await client.callTool({
      name: "model_ensure",
      arguments: { alias: "koinos-balanced", confirm: true },
    });
    assert.equal(JSON.parse(fired.content[0].text).started, true);
    const post = node.requests.find((r) => r.method === "POST");
    assert.equal(post.path, "/core/models/ensure");
    assert.deepEqual(JSON.parse(post.body), { alias: "koinos-balanced" });
  } finally {
    await close();
    await node.close();
  }
});

test("node down surfaces as isError with a helpful message, not a crash", async () => {
  const { client, close } = await connect("http://127.0.0.1:1", 2000);
  try {
    const result = await client.callTool({ name: "health", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Is the Koinos AI app running\?/);
  } finally {
    await close();
  }
});

test("multi-node: nodes_status aggregates all nodes, including a down one", async () => {
  const a = await startFakeNode();
  const b = await startFakeNode();
  const { client, close } = await connect(
    { desktop: a.url, laptop: b.url, attic: "http://127.0.0.1:1" },
    2000,
  );
  try {
    const result = await client.callTool({ name: "nodes_status", arguments: {} });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.defaultNode, "desktop");
    assert.equal(data.nodes.length, 3);
    const byName = Object.fromEntries(data.nodes.map((n) => [n.node, n]));
    assert.equal(byName.desktop.reachable, true);
    assert.equal(byName.desktop.isDefault, true);
    assert.equal(byName.desktop.version, "0.23.3");
    assert.equal(byName.desktop.privacyMode, "local-only");
    assert.equal(byName.laptop.reachable, true);
    assert.equal(byName.attic.reachable, false);
    assert.match(byName.attic.error, /Is the Koinos AI app running\?/);
  } finally {
    await close();
    await a.close();
    await b.close();
  }
});

test("multi-node: the node argument targets a specific node; unknown names error", async () => {
  const a = await startFakeNode();
  const b = await startFakeNode();
  const { client, close } = await connect({ desktop: a.url, laptop: b.url });
  try {
    await client.callTool({ name: "health", arguments: {} }); // default → desktop
    await client.callTool({ name: "health", arguments: { node: "laptop" } });
    assert.equal(a.requests.filter((r) => r.path === "/core/health").length, 1);
    assert.equal(b.requests.filter((r) => r.path === "/core/health").length, 1);

    const bad = await client.callTool({ name: "health", arguments: { node: "toaster" } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Unknown node "toaster"\. Configured nodes: desktop, laptop/);
  } finally {
    await close();
    await a.close();
    await b.close();
  }
});

test("unknown tool is an isError result", async () => {
  const { client, close } = await connect("http://127.0.0.1:1");
  try {
    const result = await client.callTool({ name: "wallet_reveal", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
  } finally {
    await close();
  }
});
