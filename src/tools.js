// Tool registry. Each tool: { name, description, inputSchema, handler }.
// handler(client, args, pool) returns a JSON-serializable value.
//
// Names are snake_case only — MCP clients (incl. the Claude API) restrict tool
// names to [a-zA-Z0-9_-], so dots are out.
//
// Target: KAI Core Beta (0.7.x). Core's local control plane (/core/* on
// 127.0.0.1:41100) is deliberately small — models, network/privacy, earn,
// feedback and account status. Everything else the Alpha app served over
// HTTP (tasks, chats, docs, keys, memory, voice, teams, the blockchain node,
// remote access, MCP registry) moved into separately installed plugins that
// talk to Core over its in-process plugin API, not HTTP. Those features are
// reachable from an agent only through a plugin — see the companion
// kai-plugin-mcp package.
//
// Mutating tools follow upstream spec §34 (Ask First): every one requires
// confirm: true, and a call without it changes nothing — it returns a
// preview. Wallet endpoints (create, restore, reveal, unlock, lock, deposit),
// the scheduler-URL setting, and the account sign-in / wallet-link / spend-
// grant routes are deliberately not wrapped at any confirmation level; a test
// greps this file to keep it that way.

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

const GATED_ONLY = {
  type: "object",
  properties: { node: NODE_PROP, confirm: CONFIRM },
  additionalProperties: false,
};

// Resolve a model the user names by alias (koinos-fast) or by package id
// (qwen2.5-1.5b-instruct-q4_k_m@1, custom:<sha256>) to the package id Core's
// removal routes take. Aliases are friendlier; package ids are exact.
async function resolvePackage(client, args) {
  const pkg = typeof args.package === "string" ? args.package.trim() : "";
  if (pkg) return { packageId: pkg, alias: null };
  const alias = typeof args.alias === "string" ? args.alias.trim() : "";
  if (!alias) throw new Error("Pass alias (e.g. koinos-fast) or package (e.g. qwen2.5-1.5b-instruct-q4_k_m@1)");
  const catalog = await client.get("/core/models");
  const entry = catalog?.aliases?.find?.((a) => a.alias === alias);
  if (!entry) {
    const known = catalog?.aliases?.map?.((a) => a.alias) ?? [];
    throw new Error(`Unknown alias "${alias}". Known aliases: ${known.join(", ")}`);
  }
  if (typeof entry.package !== "string" || !entry.package) {
    throw new Error(`Alias "${alias}" has no package id; pass package explicitly`);
  }
  return { packageId: entry.package, alias };
}

export const tools = [
  {
    name: "health",
    description:
      "Check the KAI Core node's health (read-only): Core engine version, " +
      "product name, detected hardware (CPU/GPU/RAM/disk, runtime " +
      "capabilities), and module state — gateway, runtime (active model, " +
      "loading stage, inference queue) and model storage. The version is " +
      "Core's engine package, which moves slower than the desktop app's " +
      "release number (engine 0.7.2 ships in app 0.7.17). modules.models.bytes " +
      "grows during a model download, so this also serves as download progress.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/health"),
  },
  {
    name: "models_list",
    description:
      "List models on the KAI Core node (read-only): the alias catalog with " +
      "package pins, licenses, minimum RAM, vision support and per-alias " +
      "status (ready / partial / absent); sizes as sizeBytes (weights), " +
      "downloadSizeBytes (weights + vision projector) and diskBytes (on disk " +
      "now, incl. partial downloads; 0 = nothing, null = unknown). Also the " +
      "runtime state, the model-preparation queue, download and import " +
      "progress. Does not download anything.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/models"),
  },
  {
    name: "earn_status",
    description:
      "Get the node's earning status (read-only): earn worker state, jobs " +
      "and receipts, scheduler URL, the legacy Testnet KAI balance " +
      "(earnings.kai — a decimal string, never parse it as a float), and the " +
      "wallet summary (exists/unlocked/address only — never key material). " +
      "koin is the mainnet KOIN earning view (Core Beta): mode 'shadow' with " +
      "paymentsEnabled false means KOIN payouts are being rehearsed, not paid; " +
      "policy carries the reward split in basis points. producerReport reads " +
      "'plugin-managed' on Core: block-producer reporting moved into the " +
      "separate Koinos Node plugin. Joining the network ('Share AI capacity') " +
      "is done in the KAI window, not through this API.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/earn"),
  },
  {
    name: "network_status",
    description:
      "Get the node's network and privacy posture (read-only): privacy mode " +
      "(local-only / local-first / network), scheduler URL, whether the " +
      "wallet is unlocked, and koinRehearsal. Changes nothing.",
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
      "(read-only): scheduler reachability, workers online and how many are " +
      "unsigned, whether worker proofs are enforced, each worker's models, " +
      "performance (jobs, tok/s, compute rating, success rate, challenge " +
      "results) and reputation. Worker addresses arrive pre-truncated by the " +
      "scheduler. Fail-soft: unreachable → reachable:false, empty lists.",
    inputSchema: NO_INPUT,
    handler: (client) => client.get("/core/network/status"),
  },
  {
    name: "account_status",
    description:
      "Get the node's KAI account sign-in state (read-only). scope 'credits' " +
      "(default) is the wallet-credits account at credits.koinosai.com that " +
      "network credits live in; 'website' is the koinosai.com website " +
      "account. Returns signed-in state, account id, linked wallet " +
      "addresses, whether this machine's wallet is linked, and how the " +
      "session is stored — never the session token. Refused in Local-Only " +
      "privacy mode (account access needs the network); the node says so.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["credits", "website"],
          description: "Which account: credits (default) or website",
        },
        node: NODE_PROP,
      },
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.get(args.scope === "website" ? "/core/website-account" : "/core/account"),
  },
  {
    name: "nodes_status",
    description:
      "Aggregate status across every configured KAI Core node (read-only): " +
      "reachability, Core version, active model, earning state, wallet " +
      "lock state and privacy mode per node, fetched concurrently. The " +
      "returned names are what the `node` argument on other tools accepts. " +
      "Use this first when more than one machine is configured. (No update " +
      "check: Core updates itself in-app, and its HTTP surface reports the " +
      "engine version, not the app release, so a comparison would be wrong.)",
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
            out.product = h?.productName ?? null;
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
            // A node without the earn surface — leave the fields off.
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

  // ----- Mutating tools. All gated on confirm: true. -----
  {
    name: "earn_stop",
    description:
      "MUTATING — stops this machine's earn worker: it stops taking network " +
      "compute jobs and auto-start is switched off. (Starting is not " +
      "available over the API on Core — the user joins the network with " +
      "'Share AI capacity' in the KAI window.) Requires confirm: true.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: GATED_ONLY,
    handler: (client, args) =>
      confirmGate(args, "Stop earning: the node stops accepting network compute jobs and won't auto-start.") ??
      client.post("/core/earn/stop", {}),
  },
  {
    name: "network_set_privacy_mode",
    description:
      "MUTATING — changes the node's privacy posture: 'local-only' (nothing " +
      "leaves this machine — Core's default), 'local-first' (local models " +
      "first, network fallback), 'network' (network execution allowed). Any " +
      "mode other than local-only can send prompts off this machine, and " +
      "remote hosts can read plaintext. Switching to local-only aborts " +
      "in-flight network requests. The node validates the value. Requires " +
      "confirm: true.",
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
    name: "model_download_cancel",
    description:
      "MUTATING — cancels a queued or in-flight model preparation (download " +
      "or engine setup), by alias or the current one if no alias is given. " +
      "Honest when nothing is cancellable: a step that cannot be cancelled " +
      "reports cancelled: false with a note. Requires confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Model alias to cancel (optional; default: the current one)" },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      additionalProperties: false,
    },
    handler: (client, args) => {
      const alias = typeof args.alias === "string" && args.alias.trim() ? args.alias.trim() : null;
      return (
        confirmGate(args, `Cancel preparing ${alias ?? "the current model"} on the node.`) ??
        client.post("/core/models/download/cancel", alias ? { alias } : {})
      );
    },
  },
  {
    name: "model_ensure",
    description:
      "MUTATING — queues a model for download and load by alias (e.g. " +
      "koinos-balanced); Core prepares the engine first if needed. Downloads " +
      "run to multiple GB. Called without confirm, it reports the alias's " +
      "download size, what is already on disk, minimum RAM and license " +
      "instead of starting anything. Progress shows in models_list " +
      "(modelQueue, download) and health.",
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
        const download = entry.downloadSizeBytes ?? entry.sizeBytes;
        return {
          executed: false,
          requiresConfirmation: true,
          alias,
          status: entry.status,
          downloadSizeBytes: download,
          size: humanSize(download),
          onDisk: humanSize(entry.diskBytes),
          minRamGb: entry.minRamGb ?? null,
          license: entry.license,
          wouldDo:
            entry.status === "ready"
              ? `Load ${alias} (already downloaded — no download needed).`
              : `Download+load ${alias} (${humanSize(download)}, ${entry.license}).`,
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
      "hashing is still running — poll models_list (importing, importError); " +
      "done: true carries the new entry. One import runs at a time; never " +
      "re-submit while one is in flight. Requires confirm: true.",
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
      "user), and re-importing it restores the model. For downloaded catalog " +
      "models use model_uninstall. Requires confirm: true.",
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
    name: "model_uninstall",
    description:
      "MUTATING and DESTRUCTIVE — deletes a downloaded model's files from the " +
      "node to free disk (vision projectors shared with another installed " +
      "model are kept). Name it by alias or package id. Called without " +
      "confirm, it returns Core's own removal plan — exactly which files go, " +
      "how much disk is freed, whether it can be re-downloaded, and whether " +
      "it is loaded right now (a loaded model must be switched away from " +
      "first). Imported custom models only lose their registration; their " +
      "file is kept. Requires confirm: true.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Model alias, e.g. qwen-coder-7b (see models_list)" },
        package: {
          type: "string",
          description: "Exact package id instead of an alias, e.g. qwen2.5-1.5b-instruct-q4_k_m@1 or custom:<sha256>",
        },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const { packageId, alias } = await resolvePackage(client, args);
      const path = `/core/models/installed/${encodeURIComponent(packageId)}`;
      if (args.confirm !== true) {
        const plan = await client.get(path);
        const name = alias ? `${alias} (${packageId})` : packageId;
        return {
          executed: false,
          requiresConfirmation: true,
          packageId,
          plan,
          frees: humanSize(plan?.freesBytes),
          wouldDo: plan?.inUse
            ? `${name} is loaded right now — Core will refuse until another model is loaded.`
            : plan?.kind === "imported"
              ? `Forget imported model ${name}; its file stays at ${plan.keepsFile}.`
              : `Delete ${name}: ${plan?.deletesFiles?.length ?? 0} file(s), freeing ${humanSize(plan?.freesBytes)}` +
                (plan?.redownloadable ? " (it can be downloaded again later)." : "."),
          hint:
            "Nothing was deleted. Tell the user what will be removed and, once " +
            "they agree, call again with confirm: true.",
        };
      }
      return client.delete(path);
    },
  },
  {
    name: "feedback_send",
    description:
      "MUTATING and OUTWARD-FACING — sends written feedback to the KAI team " +
      "through the node's own feedback relay (leaves this machine for " +
      "koinosai.com; the node attaches its version and platform). Optional " +
      "email adds a reply address; includeLog attaches the tail of the " +
      "node's event log (events, not chat content). Max 4000 chars. Compose " +
      "the message with the user first. Requires confirm: true.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The feedback text (max 4000 chars)" },
        email: { type: "string", description: "Optional reply-to email address" },
        includeLog: {
          type: "boolean",
          description: "Attach the tail of the node's event log",
        },
        node: NODE_PROP,
        confirm: CONFIRM,
      },
      required: ["message"],
      additionalProperties: false,
    },
    handler: (client, args) => {
      const message = String(args.message ?? "").trim();
      if (!message) throw new Error("Missing required argument: message (non-empty string)");
      // The node silently slices at 4000 — refuse instead of losing the tail.
      if (message.length > 4000) {
        throw new Error(`Feedback is ${message.length} chars; the node truncates at 4000. Shorten it.`);
      }
      return (
        confirmGate(
          args,
          "Send this feedback to the KAI team" +
            (args.email ? `, reply-to ${args.email}` : "") +
            (args.includeLog ? ", with the node's event-log tail attached" : "") +
            `: "${message}"`,
        ) ??
        client.post("/core/feedback", {
          message,
          ...(args.email !== undefined ? { email: args.email } : {}),
          ...(args.includeLog !== undefined ? { includeLog: args.includeLog } : {}),
        })
      );
    },
  },
];
