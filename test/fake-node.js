// A fake Koinos AI node for tests: a bare node:http server that records
// requests and serves canned /core/* responses, in the spirit of upstream's
// fake llama-server integration tests.

import { createServer } from "node:http";

// Shapes mirror real responses observed from a live node (v0.23.3, 2026-08-15).
export const FAKE_HEALTH = {
  ok: true,
  version: "0.23.3",
  hardware: { platform: "test", arch: "x64", cpu: { model: "fake", cores: 4 } },
  modules: {
    gateway: { ok: true, port: 41100 },
    runtime: { activeAlias: null, loading: false, runtime: null, lastLoadError: null },
    models: { ok: true, bytes: 0 },
  },
};
export const FAKE_MODELS = {
  ok: true,
  aliases: [
    {
      alias: "koinos-fast",
      label: "Koinos Fast",
      package: "qwen2.5-1.5b-instruct-q4_k_m@1",
      sizeBytes: 986048768,
      license: "apache-2.0",
      minRamGb: 4,
      status: "ready",
    },
    {
      alias: "koinos-balanced",
      label: "Koinos Balanced",
      package: "llama-3.2-3b-instruct-q4_k_m@1",
      sizeBytes: 2019377696,
      license: "llama3.2",
      minRamGb: 8,
      status: "absent",
    },
  ],
};

export const FAKE_EARN = {
  ok: true,
  wallet: { exists: false, unlocked: false, address: null, createdAt: null },
  worker: { running: false, jobsDone: 0, receiptsAccepted: 0 },
  schedulerUrl: "https://koinosai.com/scheduler",
  earnings: null,
};
export const FAKE_NETWORK = {
  ok: true,
  privacyMode: "local-only",
  schedulerUrl: "https://koinosai.com/scheduler",
  walletUnlocked: false,
};
export const FAKE_CHAT = {
  id: "chat1",
  title: "hello",
  renamed: false,
  createdAt: "2026-08-15T22:42:24.388Z",
  updatedAt: "2026-08-15T22:42:24.390Z",
  messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ],
};
export const FAKE_CHATS = {
  ok: true,
  chats: [
    {
      id: "chat1",
      title: "hello",
      updatedAt: "2026-08-15T22:42:24.390Z",
      messages: 2,
      searchText: "hello hi there — a large transcript dump we must not relay",
    },
  ],
};

export function startFakeNode({ routes } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization ?? null,
      body: Buffer.concat(chunks).toString("utf8") || null,
    });

    // Method-prefixed keys ("POST /core/x") win; bare keys match any method.
    const table = {
      "/core/health": { status: 200, body: FAKE_HEALTH },
      "/core/models": { status: 200, body: FAKE_MODELS },
      "/core/earn": { status: 200, body: FAKE_EARN },
      "/core/network": { status: 200, body: FAKE_NETWORK },
      "/core/tasks": { status: 200, body: { ok: true, tasks: [] } },
      "/core/chats": { status: 200, body: FAKE_CHATS },
      "/core/chats/chat1": { status: 200, body: { ok: true, chat: FAKE_CHAT } },
      "/core/docs": { status: 200, body: { ok: true, docs: [] } },
      "/core/keys": { status: 200, body: { ok: true, required: false, keys: [] } },
      "POST /core/earn/start": { status: 200, body: { ok: true, worker: { running: true } } },
      "POST /core/earn/stop": { status: 200, body: { ok: true, worker: { running: false } } },
      "POST /core/network/config": {
        status: 200,
        body: { ok: true, privacyMode: "local-first", walletUnlocked: false },
      },
      "POST /core/models/ensure": {
        status: 200,
        body: { ok: true, started: true, alias: "koinos-balanced" },
      },
      "POST /core/tasks": { status: 200, body: { ok: true, task: { id: "t123", name: "morning" } } },
      "POST /core/tasks/t123/run": {
        status: 200,
        body: { ok: true, task: { id: "t123", lastRunAt: "2026-08-15T23:59:00.000Z" } },
      },
      "DELETE /core/tasks/t123": { status: 200, body: { ok: true, removed: true } },
      ...routes,
    };
    const route = table[`${req.method} ${req.url}`] ?? table[req.url];

    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (route.hang) return; // never respond — for timeout tests
    if (route.delay) await new Promise((r) => setTimeout(r, route.delay));
    res.writeHead(route.status, { "content-type": "application/json" });
    res.end(typeof route.body === "string" ? route.body : JSON.stringify(route.body));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}
