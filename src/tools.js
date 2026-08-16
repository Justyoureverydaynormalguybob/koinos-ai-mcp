// Tool registry. Each tool: { name, description, inputSchema, handler }.
// handler(client, args) returns a JSON-serializable value.
//
// Names are snake_case only — MCP clients (incl. the Claude API) restrict tool
// names to [a-zA-Z0-9_-], so dots are out.
//
// M1+M2 surface is read-only. M3 mutating tools follow upstream spec §34
// (Ask First semantics): every one requires confirm: true, and a call without
// it changes nothing — it returns a preview of what would happen. Wallet
// endpoints that create, reveal, restore, unlock, or move funds are
// deliberately not wrapped at any confirmation level.

const RUN_TIMEOUT_MS = 120_000;

const CONFIRM = {
  type: "boolean",
  description:
    "Must be true to execute. Without it, nothing changes and the tool " +
    "returns a preview. Tell the user what you are about to do first.",
};

function confirmGate(args, wouldDo) {
  if (args.confirm === true) return null;
  return {
    executed: false,
    requiresConfirmation: true,
    wouldDo,
    hint:
      "Nothing was changed. Tell the user what this will do and, once they " +
      "agree, call again with confirm: true.",
  };
}

function humanSize(bytes) {
  if (typeof bytes !== "number") return "unknown size";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

const NODE_PROP = {
  type: "string",
  description:
    "Which configured node to target (optional; defaults to the first " +
    "configured node). nodes_status lists the names.",
};

const NO_INPUT = {
  type: "object",
  properties: { node: NODE_PROP },
  additionalProperties: false,
};

function idInput(what) {
  return {
    type: "object",
    properties: {
      id: { type: "string", description: `The ${what} id` },
      node: NODE_PROP,
    },
    required: ["id"],
    additionalProperties: false,
  };
}

function requireId(args) {
  if (typeof args.id !== "string" || args.id.trim() === "") {
    throw new Error("Missing required argument: id (non-empty string)");
  }
  return encodeURIComponent(args.id.trim());
}

export const tools = [
  {
    name: "health",
    description:
      "Check the Koinos AI node's health and status (read-only). " +
      "Reports app version, detected hardware (CPU/GPU/RAM/disk, runtime " +
      "capabilities), and module state: gateway, runtime (active model, " +
      "loading), and model storage. modules.models.bytes grows during a " +
      "model download, so this also serves as download progress.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/health"),
  },
  {
    name: "models_list",
    description:
      "List models on the Koinos AI node (read-only): the alias catalog " +
      "(koinos-fast/-balanced/-smart) with package pins, sizes, licenses, and " +
      "per-alias status (ready / partial / absent). Does not download anything.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/models"),
  },
  {
    name: "earn_status",
    description:
      "Get the node's earning status (read-only): whether the earn worker is " +
      "running, jobs completed, receipts accepted, scheduler URL, earnings, " +
      "and wallet summary (exists/unlocked/address only — never key material).",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/earn"),
  },
  {
    name: "network_status",
    description:
      "Get the node's network and privacy posture (read-only): current " +
      "privacy mode (e.g. local-only / local-first / network), scheduler URL, " +
      "and wallet lock state. Changes nothing.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/network"),
  },
  {
    name: "tasks_list",
    description:
      "List scheduled tasks configured on the Koinos AI node (read-only).",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/tasks"),
  },
  {
    name: "chats_list",
    description:
      "List chat conversations stored on the Koinos AI node (read-only): id, " +
      "title, timestamps, message count. Transcript text is omitted to keep " +
      "output small — use chat_get for a full conversation.",
    inputSchema: NO_INPUT,
    handler: async (client) => {
      const data = await client.get("/core/chats");
      if (Array.isArray(data?.chats)) {
        return {
          ...data,
          chats: data.chats.map(({ searchText, ...rest }) => rest),
        };
      }
      return data;
    },
  },
  {
    name: "chat_get",
    description:
      "Fetch one chat conversation from the Koinos AI node by id (read-only), " +
      "including the full message transcript.",
    inputSchema: idInput("chat"),
    handler: (client, args) => client.get(`/core/chats/${requireId(args)}`),
  },
  {
    name: "docs_list",
    description:
      "List documents stored on the Koinos AI node (read-only).",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/docs"),
  },
  {
    name: "doc_get",
    description:
      "Fetch one document from the Koinos AI node by id (read-only).",
    inputSchema: idInput("document"),
    handler: (client, args) => client.get(`/core/docs/${requireId(args)}`),
  },
  {
    name: "keys_list",
    description:
      "List API keys registered on the Koinos AI node (read-only). Returns " +
      "key metadata and whether auth is required for /v1/* — keys are hashed " +
      "at rest upstream; no secret material is available or returned.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/keys"),
  },

  {
    name: "nodes_status",
    description:
      "Aggregate status across every configured Koinos AI node (read-only): " +
      "reachability, app version, active model, earning state, and privacy " +
      "mode per node, fetched concurrently. The returned names are what the " +
      "`node` argument on other tools accepts. Use this first when more than " +
      "one machine is configured.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (_client, _args, pool) => {
      const nodes = await Promise.all(
        pool.all().map(async ({ node, client }) => {
          const out = {
            node: node.name,
            baseUrl: node.baseUrl,
            isDefault: node.name === pool.defaultName,
            reachable: false,
          };
          try {
            const h = await client.get("/core/health");
            out.reachable = true;
            out.version = h?.version ?? null;
            out.activeModel = h?.modules?.runtime?.activeAlias ?? null;
            out.modelLoading = h?.modules?.runtime?.loading ?? null;
          } catch (err) {
            out.error = err.message;
            return out;
          }
          try {
            const earn = await client.get("/core/earn");
            out.earning = {
              running: earn?.worker?.running ?? null,
              jobsDone: earn?.worker?.jobsDone ?? null,
            };
            out.wallet = {
              exists: earn?.wallet?.exists ?? null,
              unlocked: earn?.wallet?.unlocked ?? null,
            };
          } catch {
            // Older node without the earn surface — leave the fields off.
          }
          try {
            out.privacyMode = (await client.get("/core/network"))?.privacyMode ?? null;
          } catch {
            // Ditto.
          }
          return out;
        }),
      );
      return { defaultNode: pool.defaultName, nodes };
    },
  },

  // ----- M3: mutating tools. All gated on confirm: true. -----
  {
    name: "earn_start",
    description:
      "MUTATING — starts selling this machine's idle compute to the Koinos " +
      "AI network for KAI. Sustained CPU/GPU load, power draw, and network " +
      "traffic will follow, and the node begins accepting scheduler jobs. " +
      "Requires an existing, unlocked wallet. Do not call this casually: " +
      "state the intent to the user and pass confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: { node: NODE_PROP, confirm: CONFIRM },
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, "Start earning: the node begins taking network compute jobs.") ??
      client.post("/core/earn/start", {}),
  },
  {
    name: "earn_stop",
    description:
      "MUTATING — stops taking network jobs; the machine stops earning KAI " +
      "until earning is started again. Requires confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: { node: NODE_PROP, confirm: CONFIRM },
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, "Stop earning: the node stops accepting network compute jobs.") ??
      client.post("/core/earn/stop", {}),
  },
  {
    name: "network_set_privacy_mode",
    description:
      "MUTATING — changes the node's privacy posture. Current upstream " +
      "values: 'local-only' (nothing leaves this machine), 'local-first' " +
      "(remote fallback allowed), 'network' (remote execution allowed). Any " +
      "mode other than local-only can send prompts off this machine, and " +
      "remote hosts can read plaintext. The node validates the value. " +
      "Requires confirm: true.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "The privacy mode to set" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["mode"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, `Set privacy mode to "${args.mode}".`) ??
      client.post("/core/network/config", { privacyMode: args.mode }),
  },
  {
    name: "model_ensure",
    description:
      "MUTATING — downloads and loads a model by alias (e.g. koinos-balanced) " +
      "in the background. Downloads run to multiple GB. Called without " +
      "confirm, it reports the alias's download size and status instead of " +
      "starting anything. Progress is visible via models_list and health.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Model alias to ensure, e.g. koinos-fast" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["alias"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const alias = String(args.alias ?? "").trim();
      if (!alias) throw new Error("Missing required argument: alias");
      if (args.confirm !== true) {
        const catalog = await client.get("/core/models");
        const entry = catalog?.aliases?.find?.((a) => a.alias === alias);
        if (!entry) {
          const known = catalog?.aliases?.map?.((a) => a.alias) ?? [];
          throw new Error(`Unknown alias "${alias}". Known aliases: ${known.join(", ")}`);
        }
        return {
          executed: false,
          requiresConfirmation: true,
          alias,
          status: entry.status,
          sizeBytes: entry.sizeBytes,
          size: humanSize(entry.sizeBytes),
          license: entry.license,
          wouldDo: `Download+load ${alias} (${humanSize(entry.sizeBytes)}, ${entry.license}).`,
          hint:
            "Nothing was downloaded. Tell the user the size and, once they " +
            "agree, call again with confirm: true.",
        };
      }
      return client.post("/core/models/ensure", { alias });
    },
  },
  {
    name: "task_create",
    description:
      "MUTATING — creates a scheduled task on the node: a saved prompt that " +
      "runs against a local model on a schedule and drops its answer into " +
      "chat history. Tasks only fire while the Koinos AI app is running, and " +
      "runs go through the same privacy routing as typed chats. Requires " +
      "confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name (max 60 chars)" },
        prompt: { type: "string", description: "The prompt to run (max 4000 chars)" },
        model: { type: "string", description: "Model alias, e.g. koinos-fast" },
        schedule: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["hourly", "every6h", "daily", "weekly"] },
            hour: { type: "integer", description: "0-23, for daily/weekly (default 9)" },
            day: { type: "integer", description: "0=Sun … 6=Sat, for weekly (default 1)" },
          },
          required: ["kind"],
          additionalProperties: false,
        },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["name", "prompt", "model", "schedule"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(
        args,
        `Create task "${args.name}" running ${args.schedule?.kind} on ${args.model}.`,
      ) ??
      client.post("/core/tasks", {
        name: args.name,
        prompt: args.prompt,
        model: args.model,
        schedule: args.schedule,
      }),
  },
  {
    name: "task_run_now",
    description:
      "MUTATING — runs a scheduled task immediately (local inference on this " +
      "machine; the result lands in chat history). Requires confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task id" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, `Run task ${args.id} now.`) ??
      client.post(`/core/tasks/${requireId(args)}/run`, {}, {
        // A run is synchronous inference and may first swap the loaded model;
        // the node drops the run if the client disconnects first (observed
        // live 2026-08-16 at the 10s default). Floor, not replacement — a
        // larger configured timeout still wins.
        timeoutMs: Math.max(client.timeoutMs, RUN_TIMEOUT_MS),
      }),
  },
  {
    name: "task_delete",
    description:
      "MUTATING and DESTRUCTIVE — permanently deletes a scheduled task from " +
      "the node. There is no undo. Requires confirm: true.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task id" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, `Permanently delete task ${args.id}.`) ??
      client.delete(`/core/tasks/${requireId(args)}`),
  },
  {
    name: "task_set_enabled",
    description:
      "MUTATING — pauses or resumes a scheduled task on the node without " +
      "deleting it. Re-enabling starts the schedule clock fresh (no burst of " +
      "missed runs). Requires confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task id" },
        enabled: { type: "boolean", description: "true to resume, false to pause" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["id", "enabled"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, `${args.enabled ? "Resume" : "Pause"} task ${args.id}.`) ??
      client.patch(`/core/tasks/${requireId(args)}`, { enabled: args.enabled }),
  },
  {
    name: "chat_rename",
    description:
      "MUTATING — renames a chat conversation on the node (max 80 chars; the " +
      "new title sticks and outlives autosaves). Requires confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The chat id" },
        title: { type: "string", description: "New title (max 80 chars)" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["id", "title"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, `Rename chat ${args.id} to "${args.title}".`) ??
      client.patch(`/core/chats/${requireId(args)}`, { title: args.title }),
  },
  {
    name: "chat_delete",
    description:
      "MUTATING and DESTRUCTIVE — permanently deletes a chat conversation and " +
      "its transcript from the node. There is no undo. Requires confirm: true.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The chat id" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, `Permanently delete chat ${args.id} and its transcript.`) ??
      client.delete(`/core/chats/${requireId(args)}`),
  },
];
