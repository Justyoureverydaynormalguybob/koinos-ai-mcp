// Integration: a real MCP client talking to our server over an in-memory
// transport, with the server's HTTP client pointed at the fake node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { createPool } from "../src/nodes.js";
import { tools } from "../src/tools.js";
import { startFakeNode, FAKE_MODELS, FAKE_REMOVAL_PLAN } from "./fake-node.js";

// `nodes`: a name → baseUrl map (or a single URL string for the common case).
async function connect(nodes, timeoutMs = 10_000, serverOpts = {}) {
  const entries = typeof nodes === "string" ? { local: nodes } : nodes;
  const pool = createPool({
    nodes: Object.entries(entries).map(([name, baseUrl]) => ({ name, baseUrl, timeoutMs })),
    defaultNode: Object.keys(entries)[0],
  });
  const server = createServer(pool, serverOpts);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

const json = (result) => JSON.parse(result.content[0].text);

test("tool names are MCP/Claude-safe (snake_case, no dots)", () => {
  for (const tool of tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/, tool.name);
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
  }
});

test("tools/list exposes exactly the KAI Core surface", async () => {
  const { client, close } = await connect("http://127.0.0.1:1");
  try {
    const { tools: listed } = await client.listTools();
    assert.deepEqual(listed.map((t) => t.name).sort(), [
      "account_status",
      "earn_status",
      "earn_stop",
      "feedback_send",
      "health",
      "model_download_cancel",
      "model_ensure",
      "model_import",
      "model_remove_custom",
      "model_uninstall",
      "models_list",
      "network_models",
      "network_overview",
      "network_set_privacy_mode",
      "network_status",
      "nodes_status",
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
    assert.deepEqual(json(result), FAKE_MODELS);
  } finally {
    await close();
    await node.close();
  }
});

test("read tools return live node data", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    for (const [name, args, probe] of [
      ["health", {}, (d) => d.productName === "KAI Core Beta" && d.version === "0.7.2"],
      ["earn_status", {}, (d) => d.koin.mode === "shadow" && d.koin.paymentsEnabled === false && d.producerReport.state === "plugin-managed"],
      ["network_status", {}, (d) => d.privacyMode === "local-only" && d.koinRehearsal === false],
      ["network_models", {}, (d) => d.workersOnline === 3 && d.models.length === 2],
      ["network_overview", {}, (d) => d.reachable === true && d.workers[0].perf.jobs === 26 && d.workerProofEnforced === false],
      ["account_status", {}, (d) => d.scope === "credits" && d.signedIn === true],
      ["account_status", { scope: "website" }, (d) => d.scope === "website" && d.signedIn === false],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, name);
      assert.ok(probe(json(result)), `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(
      node.requests.filter((r) => r.path.includes("account")).map((r) => r.path),
      ["/core/account", "/core/website-account"],
    );
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
      ["earn_stop", { confirm: false }],
      ["network_set_privacy_mode", { mode: "network" }],
      ["model_download_cancel", {}],
      ["model_ensure", { alias: "gemma3-4b" }],
      ["model_import", { path: "C:\\models\\tiny.gguf" }],
      ["model_remove_custom", { alias: "custom-tiny" }],
      ["model_uninstall", { alias: "koinos-fast" }],
      ["feedback_send", { message: "hello" }],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${result.content?.[0]?.text}`);
      const data = json(result);
      assert.equal(data.executed, false, name);
      assert.equal(data.requiresConfirmation, true, name);
    }
    // Not a single write reached the node.
    assert.deepEqual(node.requests.filter((r) => r.method !== "GET"), []);
  } finally {
    await close();
    await node.close();
  }
});

test("with confirm: true the writes fire with the right method, path, and body", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    const stop = await client.callTool({ name: "earn_stop", arguments: { confirm: true } });
    assert.equal(json(stop).worker.running, false);
    await client.callTool({ name: "network_set_privacy_mode", arguments: { mode: "local-first", confirm: true } });
    await client.callTool({ name: "model_download_cancel", arguments: { alias: "gemma3-4b", confirm: true } });
    await client.callTool({ name: "model_download_cancel", arguments: { confirm: true } });
    const ensured = await client.callTool({ name: "model_ensure", arguments: { alias: "gemma3-4b", confirm: true } });
    assert.equal(json(ensured).job.state, "queued"); // Core answers 202 — still a success
    await client.callTool({ name: "model_import", arguments: { path: "C:\\m\\tiny.gguf", label: "Tiny", confirm: true } });
    await client.callTool({ name: "model_remove_custom", arguments: { alias: "custom-tiny", confirm: true } });

    const writes = node.requests.filter((r) => r.method !== "GET");
    assert.deepEqual(
      writes.map((r) => `${r.method} ${r.path}`),
      [
        "POST /core/earn/stop",
        "POST /core/network/config",
        "POST /core/models/download/cancel",
        "POST /core/models/download/cancel",
        "POST /core/models/ensure",
        "POST /core/models/import",
        "DELETE /core/models/custom/custom-tiny",
      ],
    );
    assert.deepEqual(JSON.parse(writes[1].body), { privacyMode: "local-first" });
    assert.deepEqual(JSON.parse(writes[2].body), { alias: "gemma3-4b" });
    assert.deepEqual(JSON.parse(writes[3].body), {});
    assert.deepEqual(JSON.parse(writes[4].body), { alias: "gemma3-4b" });
    assert.deepEqual(JSON.parse(writes[5].body), { path: "C:\\m\\tiny.gguf", label: "Tiny" });
  } finally {
    await close();
    await node.close();
  }
});

test("model_ensure previews size from the catalog and downloads nothing", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    const data = json(await client.callTool({ name: "model_ensure", arguments: { alias: "gemma3-4b" } }));
    assert.equal(data.executed, false);
    assert.equal(data.size, "3.3 GB"); // downloadSizeBytes (weights + projector), not sizeBytes
    assert.equal(data.onDisk, "0 MB");
    assert.equal(data.minRamGb, 8);

    const ready = json(await client.callTool({ name: "model_ensure", arguments: { alias: "koinos-fast" } }));
    assert.match(ready.wouldDo, /already downloaded/);

    const bogus = await client.callTool({ name: "model_ensure", arguments: { alias: "nope" } });
    assert.equal(bogus.isError, true);
    assert.match(bogus.content[0].text, /Known aliases: koinos-fast, gemma3-4b/);
    assert.equal(node.requests.filter((r) => r.method !== "GET").length, 0);
  } finally {
    await close();
    await node.close();
  }
});

test("model_uninstall previews Core's removal plan, then deletes by package id", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  const path = `/core/models/installed/${encodeURIComponent("qwen2.5-1.5b-instruct-q4_k_m@1")}`;
  try {
    const preview = json(await client.callTool({ name: "model_uninstall", arguments: { alias: "koinos-fast" } }));
    assert.equal(preview.executed, false);
    assert.equal(preview.packageId, "qwen2.5-1.5b-instruct-q4_k_m@1");
    assert.deepEqual(preview.plan, FAKE_REMOVAL_PLAN);
    assert.equal(preview.frees, "986 MB");
    assert.match(preview.wouldDo, /1 file\(s\), freeing 986 MB \(it can be downloaded again later\)/);
    assert.equal(node.requests.filter((r) => r.method !== "GET").length, 0);

    // Package ids are accepted directly and URL-encoded.
    const done = json(await client.callTool({
      name: "model_uninstall",
      arguments: { package: "qwen2.5-1.5b-instruct-q4_k_m@1", confirm: true },
    }));
    assert.equal(done.removed, true);
    assert.equal(node.requests.at(-1).method, "DELETE");
    assert.equal(node.requests.at(-1).path, path);

    const none = await client.callTool({ name: "model_uninstall", arguments: {} });
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /Pass alias/);
  } finally {
    await close();
    await node.close();
  }
});

test("model_uninstall warns when the model is loaded", async () => {
  const path = `/core/models/installed/${encodeURIComponent("qwen2.5-1.5b-instruct-q4_k_m@1")}`;
  const node = await startFakeNode({
    routes: { [`GET ${path}`]: { status: 200, body: { ...FAKE_REMOVAL_PLAN, inUse: true } } },
  });
  const { client, close } = await connect(node.url);
  try {
    const preview = json(await client.callTool({ name: "model_uninstall", arguments: { alias: "koinos-fast" } }));
    assert.match(preview.wouldDo, /loaded right now/);
  } finally {
    await close();
    await node.close();
  }
});

test("feedback_send gates, quotes the message, and posts the right body", async () => {
  const node = await startFakeNode();
  const { client, close } = await connect(node.url);
  try {
    const preview = json(await client.callTool({
      name: "feedback_send",
      arguments: { message: "the tool picker labels are noisy", email: "a@b.c" },
    }));
    assert.equal(preview.executed, false);
    assert.match(preview.wouldDo, /KAI team/);
    assert.match(preview.wouldDo, /reply-to a@b\.c/);
    assert.match(preview.wouldDo, /the tool picker labels are noisy/);
    assert.deepEqual(node.requests.filter((r) => r.method === "POST"), []);

    const sent = await client.callTool({
      name: "feedback_send",
      arguments: { message: " the tool picker labels are noisy ", includeLog: true, confirm: true },
    });
    assert.notEqual(sent.isError, true, sent.content?.[0]?.text);
    assert.equal(node.requests.at(-1).path, "/core/feedback");
    assert.deepEqual(JSON.parse(node.requests.at(-1).body), {
      message: "the tool picker labels are noisy", // trimmed
      includeLog: true,
    });

    // The node silently truncates at 4000 chars — we refuse instead.
    const tooLong = await client.callTool({
      name: "feedback_send",
      arguments: { message: "x".repeat(4001), confirm: true },
    });
    assert.equal(tooLong.isError, true);
    assert.match(tooLong.content[0].text, /truncates at 4000/);
    assert.equal(node.requests.filter((r) => r.method === "POST").length, 1);
  } finally {
    await close();
    await node.close();
  }
});

test("a removed Alpha route surfaces as a clear isError, not a crash", async () => {
  const node = await startFakeNode({
    routes: { "/core/earn": { status: 404, body: { error: { message: "Not found" } } } },
  });
  const { client, close } = await connect(node.url);
  try {
    const result = await client.callTool({ name: "earn_status", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /returned 404 for GET \/core\/earn/);
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

test("multi-node: nodes_status aggregates all nodes, including a down one, with no outbound calls", async () => {
  const a = await startFakeNode();
  const b = await startFakeNode();
  const { client, close } = await connect(
    { desktop: a.url, laptop: b.url, attic: "http://127.0.0.1:1" },
    2000,
  );
  try {
    const data = json(await client.callTool({ name: "nodes_status", arguments: {} }));
    assert.equal(data.defaultNode, "desktop");
    assert.equal("latestRelease" in data, false);
    assert.equal(data.nodes.length, 3);
    const byName = Object.fromEntries(data.nodes.map((n) => [n.node, n]));
    assert.equal(byName.desktop.reachable, true);
    assert.equal(byName.desktop.isDefault, true);
    assert.equal(byName.desktop.version, "0.7.2");
    assert.equal(byName.desktop.product, "KAI Core Beta");
    assert.equal(byName.desktop.privacyMode, "local-only");
    assert.deepEqual(byName.desktop.wallet, { exists: true, unlocked: false });
    assert.equal("updateAvailable" in byName.desktop, false);
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

test("compact mode shrinks the tool prompt but keeps the confirm contract", async () => {
  const full = await connect("http://127.0.0.1:1");
  const slim = await connect("http://127.0.0.1:1", 10_000, { compact: true });
  try {
    const { tools: fullTools } = await full.client.listTools();
    const { tools: slimTools } = await slim.client.listTools();
    assert.equal(fullTools.length, slimTools.length);

    const fullSize = JSON.stringify(fullTools).length;
    const slimSize = JSON.stringify(slimTools).length;
    assert.ok(slimSize < fullSize / 2, `compact ${slimSize} should be < half of ${fullSize}`);

    for (const t of slimTools) {
      // Behavior is unchanged: names, schema structure, and requireds survive
      // (single-node compact drops the useless `node` param).
      const counterpart = fullTools.find((f) => f.name === t.name);
      assert.deepEqual(
        Object.keys(t.inputSchema.properties),
        Object.keys(counterpart.inputSchema.properties).filter((k) => k !== "node"),
        t.name,
      );
      assert.deepEqual(t.inputSchema.required, counterpart.inputSchema.required, t.name);
      for (const prop of Object.values(t.inputSchema.properties)) {
        assert.equal("description" in prop, false, t.name);
      }
      if (t.inputSchema.properties.confirm) {
        assert.match(t.description, /confirm/i, t.name);
      }
    }
  } finally {
    await full.close();
    await slim.close();
  }
});

test("key material, scheduler config, and account auth routes are never referenced by any tool", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/tools.js", import.meta.url), "utf8");
  for (const forbidden of [
    // Wallet family: create/restore/reveal hand out or take key material;
    // unlock/lock hold the password; deposit is a funds path.
    "/core/earn/wallet",
    "/core/earn/unlock",
    "/core/earn/lock",
    "/core/earn/deposit",
    // Repointing the node at a different scheduler redirects its work and
    // its signed consume requests.
    "/core/earn/config",
    // Interactive sign-in, wallet linking, and spend grants (signed by the
    // wallet key on this machine).
    "/account/link",
    "/account/logout",
    "/account/wallet",
    "/account/grant",
    // The desktop chat lane — /v1/chat/completions is already the
    // OpenAI-compatible surface every client can use directly.
    "/core/chat/completions",
  ]) {
    assert.equal(src.includes(forbidden), false, `tools.js must never reference ${forbidden}`);
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
