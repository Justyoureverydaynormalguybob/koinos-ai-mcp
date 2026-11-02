// A fake KAI Core node for tests: a bare node:http server that records
// requests and serves canned /core/* responses, in the spirit of upstream's
// fake llama-server integration tests.
//
// Shapes mirror real responses captured from a live KAI Core Beta node
// (app 0.7.17, Core engine 0.7.2, 2026-11-02). Addresses, ids and balances
// are synthetic.

import { createServer } from "node:http";

export const FAKE_HEALTH = {
  ok: true,
  version: "0.7.2",
  channel: "core",
  productName: "KAI Core Beta",
  dataDir: "C:\\fake\\KAI Core\\foundation-v1",
  hardware: {
    platform: "test",
    arch: "x64",
    cpu: { model: "fake", cores: 4 },
    ramBytes: 16487870464,
    gpus: [{ vendor: "amd", name: "Fake GPU", vramMb: null, driver: null }],
    disk: { freeBytes: 405153308672, totalBytes: 1022844989440 },
    capabilities: { cudaEligible: false, vulkanEligible: true, metalEligible: false, cpuFallback: true },
  },
  modules: {
    gateway: { ok: true, port: 41100 },
    runtime: {
      activeAlias: null,
      loading: false,
      loadingAlias: null,
      loadingStage: null,
      inference: { activeAlias: null, queued: 0 },
      runtime: null,
      lastLoadError: null,
    },
    models: { ok: true, bytes: 0, dir: "C:\\fake\\models" },
  },
};

export const FAKE_MODELS = {
  ok: true,
  aliases: [
    {
      alias: "koinos-fast",
      label: "Qwen 2.5 1.5B",
      blurb: "Qwen 2.5 1.5B — quick answers on any machine · 1 GB",
      package: "qwen2.5-1.5b-instruct-q4_k_m@1",
      sizeBytes: 986048768,
      downloadSizeBytes: 986048768,
      diskBytes: 986048768,
      license: "apache-2.0",
      minRamGb: 3,
      status: "ready",
    },
    {
      alias: "gemma3-4b",
      label: "Gemma 3 4B",
      blurb: "Google — sharp for its size · 2.5 GB",
      package: "google_gemma-3-4b-it-q4_k_m@1",
      sizeBytes: 2489758112,
      downloadSizeBytes: 3341009216,
      diskBytes: 0,
      license: "gemma",
      minRamGb: 8,
      status: "absent",
      vision: true,
    },
  ],
  storage: { bytes: 986048768, dir: "C:\\fake\\models" },
  runtime: FAKE_HEALTH.modules.runtime,
  download: null,
  importing: null,
  importError: null,
  runtimeDownload: null,
  modelQueue: [],
  ensure: null,
};

// GET /core/models/installed/<packageId> — Core's removal plan.
export const FAKE_REMOVAL_PLAN = {
  ok: true,
  kind: "downloaded",
  label: "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
  deletesFiles: ["C:\\fake\\models\\Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"],
  keepsFile: null,
  freesBytes: 986048768,
  redownloadable: true,
  inUse: false,
};

export const FAKE_EARN = {
  ok: true,
  // Existence/lock/address only — the node never returns key material here.
  wallet: {
    exists: true,
    unlocked: false,
    address: "1FakeAddr",
    ethAddress: "0xFakeEthAddr",
    createdAt: "2026-08-18T10:21:20.682Z",
  },
  worker: { running: false, jobsDone: 0, receiptsAccepted: 0 },
  guard: null,
  schedulerUrl: "https://koinosai.com/scheduler",
  // The legacy Testnet KAI balance. Decimal strings — never parse as floats.
  earnings: {
    address: "1FakeAddr",
    kai: "12.34567890",
    observedAt: 1793655693351,
    koinShadow: false,
    pendingReceipts: 0,
    tokensProcessed: 0,
    pendingKai: "0.00000000",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: "0.000000" },
    freeTokensRemaining: 25000,
    balanceUsd: "0.000000",
    spentThisEpochKai: "0",
  },
  // Core Beta: mainnet KOIN earning, rehearsed in shadow mode for now.
  koin: {
    schema: 1,
    mode: "shadow",
    asset: "KOIN",
    paymentsEnabled: false,
    claimable: null,
    usageCredit: null,
    estimate: null,
    qualification: "unavailable",
    policy: {
      version: 1,
      dailyBps: 500,
      availabilityBps: 7000,
      revenueRewardBps: 6000,
      revenueMiningBps: 2500,
      revenueOperationsBps: 1500,
      workCapBps: 8000,
      noticeMs: 172800000,
      reviewMs: 86400000,
    },
  },
  // Node reporting moved into the separate Koinos Node plugin.
  producerReport: { enabled: false, state: "plugin-managed" },
};

export const FAKE_NETWORK = {
  ok: true,
  privacyMode: "local-only",
  schedulerUrl: "https://koinosai.com/scheduler",
  walletUnlocked: false,
  koinRehearsal: false,
};

// Both network reads are fail-soft upstream: scheduler unreachable → empty
// models/workers, not an error.
export const FAKE_NETWORK_MODELS = {
  ok: true,
  workersOnline: 3,
  models: [
    { model: "gemma3-4b", providers: 1, inUsdPerM: 0.2, outUsdPerM: 0.8, ctxTokens: 4096 },
    { model: "koinos-fast", providers: 2, inUsdPerM: 0.1, outUsdPerM: 0.4, ctxTokens: 4096 },
  ],
};
export const FAKE_NETWORK_OVERVIEW = {
  ok: true,
  reachable: true,
  instance: "i_fake0001",
  bootAt: "2026-11-02T20:05:04.242Z",
  workersOnline: 3,
  workersUnsigned: 0,
  workerProofEnforced: false,
  models: FAKE_NETWORK_MODELS.models,
  recentOffline: [{ addr: "1Offl…", lastSeenSecs: 2231, models: 3 }],
  workers: [
    {
      // Addresses arrive pre-truncated by the scheduler.
      address: "1Fake…Wrk1",
      models: ["koinos-fast"],
      ram: 34,
      lastSeenSecs: 1,
      busy: false,
      perf: { jobs: 26, tokPerSec: 2.44, cuRating: 0.122, ok: 26, sr: 0.998 },
      jobsThisEpoch: 4,
      reputation: { r: 0.663, ageDays: 51.5, gated: true, elig: 0.15 },
      proof: "signed",
    },
  ],
};

export const FAKE_ACCOUNT_CREDITS = {
  ok: true,
  site: "https://credits.koinosai.com",
  tokenStored: true,
  credsEncrypted: true,
  secureStorage: { available: true, state: "protected", protection: "operating-system" },
  sessionOnly: false,
  authScope: "wallet-credits",
  signedIn: true,
  account: {
    id: "acc_fake",
    scope: "wallet-credits",
    freeOnly: false,
    wallets: [{ address: "1FakeAddr", linkedAt: 1793654471620 }],
    expiresAt: 1796246471406,
  },
  thisWalletLinked: true,
  thisWalletGrant: null,
  scope: "credits",
  separateCreditAccount: true,
};
export const FAKE_ACCOUNT_WEBSITE = {
  ok: true,
  site: "https://koinosai.com",
  tokenStored: false,
  credsEncrypted: true,
  secureStorage: { available: true, state: "protected" },
  sessionOnly: false,
  authScope: "account",
  signedIn: false,
  scope: "website",
  separateCreditAccount: true,
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

    const qwen = `/core/models/installed/${encodeURIComponent("qwen2.5-1.5b-instruct-q4_k_m@1")}`;
    // Method-prefixed keys ("POST /core/x") win; bare keys match any method.
    const table = {
      "/core/health": { status: 200, body: FAKE_HEALTH },
      "/core/models": { status: 200, body: FAKE_MODELS },
      "/core/earn": { status: 200, body: FAKE_EARN },
      "/core/network": { status: 200, body: FAKE_NETWORK },
      "/core/network/models": { status: 200, body: FAKE_NETWORK_MODELS },
      "/core/network/status": { status: 200, body: FAKE_NETWORK_OVERVIEW },
      "/core/account": { status: 200, body: FAKE_ACCOUNT_CREDITS },
      "/core/website-account": { status: 200, body: FAKE_ACCOUNT_WEBSITE },
      [`GET ${qwen}`]: { status: 200, body: FAKE_REMOVAL_PLAN },
      [`DELETE ${qwen}`]: {
        status: 200,
        body: { ok: true, removed: true, kind: "downloaded", freedBytes: 986048768 },
      },
      "POST /core/earn/stop": { status: 200, body: { ...FAKE_EARN } },
      "POST /core/network/config": {
        status: 200,
        body: { ok: true, privacyMode: "local-first", schedulerUrl: "https://koinosai.com/scheduler", walletUnlocked: false, koinRehearsal: false },
      },
      // Core 0.7.x answers 202 with the queued job.
      "POST /core/models/ensure": {
        status: 202,
        body: { ok: true, started: true, alias: "gemma3-4b", job: { alias: "gemma3-4b", state: "queued" }, modelQueue: [] },
      },
      "POST /core/models/download/cancel": {
        status: 200,
        body: { ok: true, cancelled: true, modelQueue: [] },
      },
      // Import replies done:false after ~800ms upstream; poll GET /core/models.
      "POST /core/models/import": { status: 200, body: { ok: true, done: false } },
      "DELETE /core/models/custom/custom-tiny": { status: 200, body: { ok: true } },
      "POST /core/feedback": { status: 200, body: { ok: true } },
      ...routes,
    };
    const route = table[`${req.method} ${req.url}`] ?? table[req.url];

    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
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
