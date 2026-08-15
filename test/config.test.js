import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("defaults to a single local node on 41100", () => {
  const config = loadConfig({});
  assert.deepEqual(config.nodes, [
    { name: "local", baseUrl: "http://127.0.0.1:41100", apiKey: undefined, timeoutMs: 10_000 },
  ]);
  assert.equal(config.defaultNode, "local");
});

test("honours KAI_CORE_PORT and KOINOS_AI_BASE_URL", () => {
  assert.equal(loadConfig({ KAI_CORE_PORT: "5000" }).nodes[0].baseUrl, "http://127.0.0.1:5000");
  assert.equal(
    loadConfig({ KOINOS_AI_BASE_URL: "http://10.0.0.5:41100/" }).nodes[0].baseUrl,
    "http://10.0.0.5:41100",
  );
});

test("parses KOINOS_AI_NODES with per-node keys and a global fallback", () => {
  const config = loadConfig({
    KOINOS_AI_NODES: "desktop=http://127.0.0.1:41100, my-laptop=http://192.168.1.20:41100/",
    KOINOS_AI_API_KEY: "global",
    KOINOS_AI_API_KEY_MY_LAPTOP: "laptop-key",
  });
  assert.equal(config.defaultNode, "desktop");
  assert.deepEqual(
    config.nodes.map(({ name, baseUrl, apiKey }) => ({ name, baseUrl, apiKey })),
    [
      { name: "desktop", baseUrl: "http://127.0.0.1:41100", apiKey: "global" },
      { name: "my-laptop", baseUrl: "http://192.168.1.20:41100", apiKey: "laptop-key" },
    ],
  );
});

test("rejects malformed node specs", () => {
  assert.throws(() => loadConfig({ KOINOS_AI_NODES: "justaurl" }), /expected name=url/);
  assert.throws(() => loadConfig({ KOINOS_AI_NODES: "a b=http://x" }), /bad node name/);
  assert.throws(() => loadConfig({ KOINOS_AI_NODES: "a=ftp://x" }), /bad url/);
  assert.throws(
    () => loadConfig({ KOINOS_AI_NODES: "a=http://x,a=http://y" }),
    /duplicate node names/,
  );
});
