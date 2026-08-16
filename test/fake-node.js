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
// Shapes observed live on v0.25.8 (2026-08-16). Both endpoints are fail-soft
// upstream: scheduler unreachable → empty models/workers, not an error.
export const FAKE_NETWORK_MODELS = {
  ok: true,
  workersOnline: 3,
  models: [
    { model: "koinos-fast", providers: 3 },
    { model: "koinos-balanced", providers: 2 },
    { model: "qwen25-32b", providers: 1 },
  ],
};
export const FAKE_NETWORK_OVERVIEW = {
  ok: true,
  reachable: true,
  instance: "i_50e07d94",
  bootAt: "2026-08-16T08:22:43.428Z",
  workersOnline: 3,
  models: FAKE_NETWORK_MODELS.models,
  recentOffline: [],
  workers: [
    {
      // Addresses arrive pre-truncated by the scheduler.
      address: "1AUgCZ…AXHo",
      models: ["koinos-fast", "qwen25-32b"],
      lastSeenSecs: 4,
      busy: false,
      perf: { jobs: 26, tokPerSec: 3.83, cuRating: 0.192 },
      jobsThisEpoch: 4,
    },
  ],
  queueDepth: 0,
  pendingJobs: 0,
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
      "/core/network/models": { status: 200, body: FAKE_NETWORK_MODELS },
      "/core/network/status": { status: 200, body: FAKE_NETWORK_OVERVIEW },
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
      // Import replies done:false after ~800ms upstream; the UI polls
      // GET /core/models (importing.pct / importError) for progress.
      "POST /core/models/import": { status: 200, body: { ok: true, done: false } },
      "DELETE /core/models/custom/custom-tiny": { status: 200, body: { ok: true } },
      "POST /core/earn/nudge": { status: 200, body: { ok: true } },
      "POST /core/tasks": { status: 200, body: { ok: true, task: { id: "t123", name: "morning" } } },
      "POST /core/tasks/t123/run": {
        status: 200,
        body: {
          ok: true,
          task: { id: "t123", lastRunAt: "2026-08-15T23:59:00.000Z", lastChatId: "chat1" },
        },
      },
      "DELETE /core/tasks/t123": { status: 200, body: { ok: true, removed: true } },
      "PATCH /core/tasks/t123": {
        status: 200,
        body: { ok: true, task: { id: "t123", enabled: false } },
      },
      "PATCH /core/chats/chat1": { status: 200, body: { ok: true, id: "chat1", title: "renamed" } },
      "DELETE /core/chats/chat1": { status: 200, body: { ok: true } },
      // Key management (0.25.x): create returns the plaintext secret once.
      "POST /core/keys": {
        status: 200,
        body: { ok: true, id: "key_ab12cd34ef56", name: "ci", secret: "kai_sk_test-shown-once" },
      },
      "DELETE /core/keys/key_ab12cd34ef56": { status: 200, body: { ok: true, revoked: true } },
      "POST /core/keys/key_ab12cd34ef56/budget": {
        status: 200,
        body: { ok: true, id: "key_ab12cd34ef56", budgetUsdMonthly: 5 },
      },
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
