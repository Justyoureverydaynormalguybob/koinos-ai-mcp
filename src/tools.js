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

import { latestAppRelease, compareVersions } from "./release.js";

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

// The embedded Koinos blockchain node (app v0.28+) exposes one channel-
// dispatched route. Privacy-gated server-side: in Local-Only mode every
// channel refuses with a self-explaining error that we simply relay.
function nodeRpc(client, channel, payload = {}) {
  return client.post("/core/koinos/rpc", { channel, payload });
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
    name: "network_models",
    description:
      "List what the Koinos compute network can serve right now (read-only): " +
      "workers online and each network-servable model with its provider " +
      "count. Served from a short upstream cache and fail-soft — an " +
      "unreachable scheduler yields an empty list, not an error.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/network/models"),
  },
  {
    name: "network_overview",
    description:
      "Live view of the Koinos compute network as seen from this node " +
      "(read-only): scheduler reachability, workers online with the models " +
      "each serves, recent performance (jobs, tok/s, compute rating), queue " +
      "depth and pending jobs. Worker addresses arrive pre-truncated by the " +
      "scheduler, so nothing identifying is exposed.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/network/status"),
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
      "key metadata, per-key monthly usage (requests, tokens, network cost) " +
      "and budget cap, and whether auth is required for /v1/* — keys are " +
      "hashed at rest upstream; no secret material is available or returned.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/keys"),
  },

  {
    name: "nodes_status",
    description:
      "Aggregate status across every configured Koinos AI node (read-only): " +
      "reachability, app version, active model, earning state, and privacy " +
      "mode per node, fetched concurrently. Also checks the latest Koinos AI " +
      "release on GitHub (cached, fail-soft; the server's only outbound call " +
      "— disable with KOINOS_AI_NO_VERSION_CHECK=1) and flags nodes running " +
      "an older version. The returned names are what the `node` argument on " +
      "other tools accepts. Use this first when more than one machine is " +
      "configured.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (_client, _args, pool) => {
      const latestPromise = latestAppRelease();
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
      const latest = await latestPromise;
      if (latest) {
        for (const n of nodes) {
          if (typeof n.version === "string" && n.version !== "") {
            n.updateAvailable = compareVersions(latest.version, n.version) > 0;
          }
        }
      }
      return {
        defaultNode: pool.defaultName,
        ...(latest ? { latestRelease: latest } : {}),
        nodes,
      };
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
    name: "earn_nudge",
    description:
      "MUTATING — makes the node re-register with the network scheduler " +
      "immediately instead of waiting for its next heartbeat. The fix when " +
      "earning is on but the node has dropped out of the network view " +
      "(typically after OS sleep/standby — check with network_overview). " +
      "Does not start or stop earning. Requires confirm: true.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: { node: NODE_PROP, confirm: CONFIRM },
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, "Re-register this node with the network scheduler now.") ??
      client.post("/core/earn/nudge", {}),
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
    name: "model_import",
    description:
      "MUTATING — registers a GGUF file already on the node's own disk as a " +
      "custom model (bring-your-own model). The node SHA-256-hashes the file " +
      "— minutes for multi-GB files — and then serves it under a new " +
      "custom-<name> alias. The file is referenced in place, never copied: " +
      "moving it later breaks the model. A response with done: false means " +
      "hashing is still running — poll models_list (importing.pct, " +
      "importError); done: true carries the new entry. One import runs at a " +
      "time; never re-submit while one is in flight. Requires confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to a .gguf file on the node's machine",
        },
        label: { type: "string", description: "Display label (max 60 chars; defaults to the filename)" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (client, args) => {
      const path = String(args.path ?? "").trim();
      if (!path) throw new Error("Missing required argument: path (non-empty string)");
      return (
        confirmGate(
          args,
          `Import the GGUF at ${path} as a custom model. The node will hash ` +
            "the whole file (minutes for multi-GB files) and reference it in " +
            "place — it must stay where it is.",
        ) ??
        client.post("/core/models/import", {
          path,
          ...(args.label !== undefined ? { label: args.label } : {}),
        })
      );
    },
  },
  {
    name: "model_remove_custom",
    description:
      "MUTATING — deregisters an imported custom model by its custom-<name> " +
      "alias. The GGUF file itself is never deleted (it belongs to the " +
      "user), and re-importing it restores the model. Built-in catalog " +
      "aliases cannot be removed this way. Requires confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        alias: {
          type: "string",
          description: "The custom model's alias, e.g. custom-my-model (see models_list)",
        },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["alias"],
      additionalProperties: false,
    },
    handler: (client, args) => {
      const alias = String(args.alias ?? "").trim();
      if (!alias) throw new Error("Missing required argument: alias (non-empty string)");
      return (
        confirmGate(
          args,
          `Deregister custom model ${alias} (the GGUF file stays on disk).`,
        ) ?? client.delete(`/core/models/custom/${encodeURIComponent(alias)}`)
      );
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
      "machine; the result lands in chat history) and returns the " +
      "assistant's answer when it can be read back. Never retry a run that " +
      "timed out — the node queues it and a retry produces duplicate runs. " +
      "Requires confirm: true.",
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
    handler: async (client, args) => {
      const preview = confirmGate(args, `Run task ${args.id} now.`);
      if (preview) return preview;
      const result = await client.post(`/core/tasks/${requireId(args)}/run`, {}, {
        // A run is synchronous inference and may first swap the loaded model;
        // the node drops the run if the client disconnects first (observed
        // live 2026-08-16 at the 10s default). Floor, not replacement — a
        // larger configured timeout still wins.
        timeoutMs: Math.max(client.timeoutMs, RUN_TIMEOUT_MS),
      });
      // The run is awaited upstream, so lastChatId already points at the
      // result chat. Read the answer back, fail-soft: the chat index can lag
      // (see API doc quirks) and the run itself has already succeeded.
      const chatId = result?.task?.lastChatId;
      if (typeof chatId !== "string" || chatId === "") return result;
      try {
        const data = await client.get(`/core/chats/${encodeURIComponent(chatId)}`);
        const messages = data?.chat?.messages;
        const reply = Array.isArray(messages)
          ? messages.findLast((m) => m?.role === "assistant")?.content
          : undefined;
        if (typeof reply === "string") return { ...result, answer: reply };
      } catch {
        // Fall through to the hint below.
      }
      return {
        ...result,
        answer: null,
        answerHint:
          `The run finished but chat ${chatId} could not be read back yet ` +
          "(the node's chat index can lag). Try chat_get with that id. Do " +
          "not run the task again — that would duplicate the run.",
      };
    },
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
  {
    name: "key_create",
    description:
      "MUTATING — creates a named API key for the node's OpenAI-compatible " +
      "/v1/* gateway. The response contains the key secret exactly once " +
      "(only a hash is stored upstream; it can never be retrieved again) — " +
      "relay it to the user immediately and never store or log it. Creating " +
      "the node's FIRST key switches /v1/* from open localhost access to " +
      "required bearer auth: keyless clients start getting 401s. Requires " +
      "confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A label for the key, e.g. 'vscode'" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const name = String(args.name ?? "").trim();
      if (!name) throw new Error("Missing required argument: name (non-empty string)");
      if (args.confirm !== true) {
        let firstKey = false;
        try {
          const current = await client.get("/core/keys");
          firstKey = Array.isArray(current?.keys) && current.keys.length === 0;
        } catch {
          // Node unreadable right now — the preview just stays generic.
        }
        return confirmGate(
          args,
          `Create API key "${name}". The response will contain the key ` +
            "secret exactly once — relay it to the user, never store it." +
            (firstKey
              ? " This is the node's FIRST key: /v1/* switches from open " +
                "localhost access to required bearer auth, and keyless " +
                "clients start getting 401s."
              : ""),
        );
      }
      return client.post("/core/keys", { name });
    },
  },
  {
    name: "key_revoke",
    description:
      "MUTATING and DESTRUCTIVE — permanently revokes an API key by id. " +
      "Clients using it start getting 401s immediately; there is no undo. " +
      "Revoking the LAST key returns /v1/* to open, unauthenticated " +
      "localhost access. Requires confirm: true.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The key id (from keys_list)" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(
        args,
        `Permanently revoke API key ${args.id}. Clients using it get 401s ` +
          "immediately; revoking the last key reopens /v1/* unauthenticated.",
      ) ?? client.delete(`/core/keys/${requireId(args)}`),
  },
  {
    name: "key_set_budget",
    description:
      "MUTATING — sets or clears an API key's monthly USD spending cap for " +
      "paid Koinos-network inference (upstream spec §34 spending limits). " +
      "Local inference is free and never gated by this. A key at its cap " +
      "gets 429s on network requests until the cap is raised or the month " +
      "rolls over. Pass budgetUsdMonthly: null to remove the cap. Requires " +
      "confirm: true.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The key id (from keys_list)" },
        budgetUsdMonthly: {
          type: ["number", "null"],
          description: "Monthly cap in USD (≥ 0), or null to remove the cap",
        },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["id", "budgetUsdMonthly"],
      additionalProperties: false,
    },
    handler: (client, args) => {
      const budget = args.budgetUsdMonthly ?? null;
      if (budget !== null && (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0)) {
        throw new Error(
          "budgetUsdMonthly must be a non-negative number of USD, or null to clear the cap",
        );
      }
      return (
        confirmGate(
          args,
          budget === null
            ? `Remove the monthly network-spend cap on API key ${args.id}.`
            : `Cap API key ${args.id} at $${budget}/month of network spend ` +
              "(local inference stays free and ungated).",
        ) ?? client.post(`/core/keys/${requireId(args)}/budget`, { budgetUsdMonthly: budget })
      );
    },
  },

  // ----- M8: the embedded Koinos blockchain node (/core/koinos/rpc, v0.28+).
  // The value-moving channels (the chain send, every fund send, and the
  // bridge and swap flows) are deliberately not wrapped — same red line as
  // the wallet endpoints: money-movers stay out of agent reach at any
  // confirmation level, password-gated upstream or not. A test greps this
  // file for those channel names to keep it that way.
  {
    name: "node_status",
    description:
      "Status of the embedded Koinos blockchain node (read-only): Docker " +
      "availability, compose services, running state, producer key, data " +
      "directory. Requires privacy mode local-first or network — in " +
      "local-only the whole node surface is disabled and says so.",
    inputSchema: NO_INPUT,
    handler: (client) => nodeRpc(client, "node:status"),
  },
  {
    name: "node_setup_status",
    description:
      "Readiness of the blockchain node's guided setup (read-only): WSL 2 " +
      "state, Docker installed/running, and the remaining setup steps.",
    inputSchema: NO_INPUT,
    handler: (client) => nodeRpc(client, "setup:status"),
  },
  {
    name: "node_dashboard",
    description:
      "The blockchain node dashboard (read-only): network, wallet " +
      "existence/lock/address, node run state, sync, and earnings summary.",
    inputSchema: NO_INPUT,
    handler: (client) => nodeRpc(client, "dashboard:summary"),
  },
  {
    name: "node_balances",
    description:
      "On-chain balances for this machine's wallet address (read-only): " +
      "KOIN, VHP, and mana, read from public mainnet RPC. No local node " +
      "required.",
    inputSchema: NO_INPUT,
    handler: (client) => nodeRpc(client, "chain:balances"),
  },
  {
    name: "node_rewards_status",
    description:
      "Auto-reburn status (read-only): configuration (percent, mode), " +
      "whether it is running, next run time, and the last result. Reburn " +
      "converts block rewards back to VHP at this wallet's own address.",
    inputSchema: NO_INPUT,
    handler: (client) => nodeRpc(client, "rewards:status"),
  },
  {
    name: "node_producer_status",
    description:
      "Block-producer registration status (read-only): the wallet address, " +
      "the local producer key, the registered key on chain, and whether " +
      "they match.",
    inputSchema: NO_INPUT,
    handler: (client) => nodeRpc(client, "producer:status"),
  },
  {
    name: "node_logs",
    description:
      "Recent log output from the running blockchain node's services " +
      "(read-only). Errors plainly when Docker or the node is not running.",
    inputSchema: NO_INPUT,
    handler: (client) => nodeRpc(client, "node:logs"),
  },
  {
    name: "node_start",
    description:
      "MUTATING — starts the Koinos blockchain node on this machine " +
      "(Docker compose up: multiple services, sustained disk and network " +
      "use while syncing). Fails plainly when Docker is missing. Requires " +
      "confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: { node: NODE_PROP, confirm: CONFIRM },
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, "Start the Koinos blockchain node (Docker compose up).") ??
      nodeRpc(client, "node:start"),
  },
  {
    name: "node_stop",
    description:
      "MUTATING — stops the Koinos blockchain node's Docker services. A " +
      "registered producer stops producing blocks until started again. " +
      "Requires confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: { node: NODE_PROP, confirm: CONFIRM },
      additionalProperties: false,
    },
    handler: (client, args) =>
      confirmGate(args, "Stop the Koinos blockchain node's services.") ??
      nodeRpc(client, "node:stop"),
  },
  {
    name: "node_quick_sync",
    description:
      "MUTATING — downloads a chain snapshot to fast-forward node sync. " +
      "This is a very large download (observed: ~63 GB archive needing " +
      "~165 GB free disk). Called without confirm, it reports the current " +
      "archive size, required disk, and free disk instead of starting.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: { node: NODE_PROP, confirm: CONFIRM },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      if (args.confirm !== true) {
        const info = await nodeRpc(client, "node:quickSyncInfo");
        const d = info?.data ?? {};
        return {
          executed: false,
          requiresConfirmation: true,
          archive: humanSize(d.archiveBytes),
          requiredDisk: humanSize(d.requiredBytes),
          freeDisk: humanSize(d.freeBytes),
          wouldDo: `Download a ${humanSize(d.archiveBytes)} chain snapshot (needs ${humanSize(d.requiredBytes)} free; this machine has ${humanSize(d.freeBytes)}).`,
          hint:
            "Nothing was downloaded. Tell the user the sizes and, once they " +
            "agree, call again with confirm: true.",
        };
      }
      return nodeRpc(client, "node:quickSync");
    },
  },
  {
    name: "chain_burn",
    description:
      "MUTATING and IRREVERSIBLE — burns KOIN into VHP at this wallet's own " +
      "address (the proof-of-burn stake that lets a node produce blocks). " +
      "Nothing leaves the wallet, but KOIN converts one-way into VHP that " +
      "only unwinds through block production. Called without confirm, it " +
      "reports the maximum burnable amount and mana limit instead of " +
      "burning. amount is a human-format KOIN string, e.g. \"5\" or \"12.5\".",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description: "KOIN amount to burn, human format (e.g. \"5\")",
        },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["amount"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const amount = String(args.amount ?? "").trim();
      if (!amount) throw new Error("Missing required argument: amount");
      if (args.confirm !== true) {
        const max = await nodeRpc(client, "chain:maxBurn");
        const d = max?.data ?? {};
        return {
          executed: false,
          requiresConfirmation: true,
          requestedAmount: amount,
          maxBurnable: d.maxFormatted ?? null,
          manaLimited: d.manaLimited ?? null,
          wouldDo: `Irreversibly burn ${amount} KOIN into VHP at this wallet's own address (max currently burnable: ${d.maxFormatted ?? "unknown"} KOIN).`,
          hint:
            "Nothing was burned. Tell the user the amount and the maximum, " +
            "and only after they agree call again with confirm: true.",
        };
      }
      return nodeRpc(client, "chain:burn", { amount });
    },
  },
];
