# koinos-ai-mcp

An [MCP](https://modelcontextprotocol.io) server for [KAI](https://koinosai.com) (KAI Core Beta, formerly Koinos AI). It lets you operate a KAI node from Claude Code or any MCP client.

> **Status: 1.0.1, for KAI Core Beta (app 0.7.17+).** Covers everything Core still serves on its local control plane: health, models (including uninstall), the compute network, privacy mode, earning status, account status and feedback. Verified against a live Core node on 2026-11-02.
>
> **On the Alpha app (0.54.x)?** Stay on `koinos-ai-mcp@0.7` for now. Core moved tasks, chats, documents, keys, memory, voice, AI Teams, the blockchain node and remote access out of the control plane into separately installed plugins, so 1.0 doesn't carry those tools.
>
> **Want those features from an agent on Core?** They're only reachable through a plugin. See the companion **[MCP Bridge](https://github.com/Justyoureverydaynormalguybob/kai-plugin-mcp)** plugin, which runs inside KAI and asks you in the KAI window before any change.

## Why

KAI runs LLMs locally on your own hardware and can sell idle compute to a network. Its local control plane on `127.0.0.1:41100` handles models, privacy and earning, but normally only the KAI window talks to it.

This server wraps that control plane in MCP, so you can say:

> *"Is my node up, and which model is loaded?"*
> *"Free some disk: what would removing the 7B coder model give me back?"*
> *"Set me to Local-Only, nothing leaves this machine today."*
> *"Which of my three machines is idle?"*

Chat is deliberately **not** wrapped. KAI's `/v1/chat/completions` is already OpenAI-compatible, so every existing client can use it as-is.

## Requirements

- Node 22 or later
- A running KAI Core node ([download](https://koinosai.com))

## Install

Add to Claude Code:

```sh
claude mcp add koinos-ai -- npx -y koinos-ai-mcp
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "koinos-ai": {
      "command": "npx",
      "args": ["-y", "koinos-ai-mcp"],
      "env": { "KOINOS_AI_BASE_URL": "http://127.0.0.1:41100" }
    }
  }
}
```

Or run from a checkout (`git clone`, `npm install && npm test`) and point the client at `node /path/to/koinos-ai-mcp/src/index.js`.

Configuration (all optional):
- `KOINOS_AI_BASE_URL`: default `http://127.0.0.1:41100`; honours Core's `KAI_CORE_PORT`.
- `KOINOS_AI_API_KEY`: sent as a Bearer token when set.
- `KOINOS_AI_TIMEOUT_MS`: default `10000`.

This server makes no outbound calls beyond your own nodes. The 0.x update check is gone, because Core updates itself in-app and its API reports an engine version that doesn't match the app release.

Running a hardened or headless Core with `KAI_CORE_TOKEN` set? Set `KOINOS_AI_API_KEY` to the same value; every request already carries it as a Bearer token. Multi-node setups use `KOINOS_AI_API_KEY_<NAME>` per node.

### From your phone (HTTP mode)

```sh
# on the machine next to the node — read-only by default
set KOINOS_AI_HTTP_TOKEN=<a random secret, 32+ characters>
npx -y koinos-ai-mcp --http 8721
cloudflared tunnel --url http://127.0.0.1:8721
```

Add the printed `https://…trycloudflare.com/<token>/mcp` URL as a custom connector in Claude (Settings → Connectors).

Security:
- It binds to `127.0.0.1` only; exposure is the tunnel's job.
- The endpoint hides behind the capability token, and anything else gets a bare 404.
- HTTP mode is **read-only**: only tools marked read-only are served. Mutating tools are absent and refused unless you opt in with `--http-writes`.
- Even with `--http-writes`, `feedback_send` stays local-only, and privacy can only be set to `local-only` over HTTP.
- The token is part of the URL, so the URL itself is the secret: it shows up in tunnel logs and in your connector settings. Tokens shorter than 32 characters are refused; leave `KOINOS_AI_HTTP_TOKEN` unset for a random one per run.
- Request bodies are capped at 1 MB.

### More than one machine

```json
"env": { "KOINOS_AI_NODES": "desktop=http://127.0.0.1:41100,laptop=http://192.168.1.20:41100" }
```

The first entry is the default. Every tool takes an optional `node` argument, and `nodes_status` checks all of them at once.

`KOINOS_AI_API_KEY` is only sent to nodes on this machine. A node on another machine needs its own `KOINOS_AI_API_KEY_<NAME>` (for example `KOINOS_AI_API_KEY_LAPTOP`), so one machine's key never travels to another, and never in the clear over `http://`.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `nodes_status` | read-only | One view across every configured machine: reachability, version, model, earning, wallet lock state, privacy |
| `health` | read-only | Core version, hardware, runtime (active model, loading stage, queue), model storage |
| `models_list` | read-only | The model catalog with download size, bytes on disk, licence, RAM needs and status, plus the preparation queue |
| `earn_status` | read-only | Earn worker, legacy Testnet KAI balance, the mainnet KOIN view (shadow mode, reward policy), wallet summary (never key material) |
| `network_status` | read-only | Privacy mode, scheduler URL, wallet lock state |
| `network_models` | read-only | What the compute network can serve right now, with provider counts and prices |
| `network_overview` | read-only | Live network view: workers online, per-worker models, performance and reputation |
| `account_status` | read-only | KAI account sign-in state (credits or website account), linked wallets; never the session token |
| `network_set_privacy_mode` | **mutating** | Change privacy posture (local-only / local-first / network) |
| `model_ensure` / `model_download_cancel` | **mutating** | Queue a model download and load (the preview reports the size first); cancel a queued or running preparation |
| `model_uninstall` | **mutating, destructive** | Delete a downloaded model's files; the preview is Core's own removal plan (files, disk freed, whether it's loaded) |
| `model_import` / `model_remove_custom` | **mutating** | Register or deregister your own GGUF; the file is referenced in place, never copied or deleted |
| `earn_stop` | **mutating** | Stop the earn worker (joining the network is done in the KAI window) |
| `feedback_send` | **mutating** | Send written feedback to the KAI team via the node's relay |

Every mutating tool requires `confirm: true`. Called without it, **nothing changes**: the tool returns a preview, so an agent has to state its intent before acting.

`confirm` is set by the agent, not by you. It is a check on the agent, not a human approval, and nothing here pops up a dialog. That is why HTTP mode is read-only by default. If you want a person to approve every change in the KAI window, use the [MCP Bridge](https://github.com/Justyoureverydaynormalguybob/kai-plugin-mcp) plugin.

## What it looks like

Real output from a live Core node (condensed). Asked to free disk, the agent's first call is a preview built from Core's own removal plan:

```json
{
  "executed": false,
  "requiresConfirmation": true,
  "packageId": "qwen2.5-coder-7b-instruct-q4_k_m@1",
  "frees": "4.7 GB",
  "wouldDo": "Delete qwen-coder-7b (qwen2.5-coder-7b-instruct-q4_k_m@1): 1 file(s), freeing 4.7 GB (it can be downloaded again later)."
}
```

## Safety

- The wallet endpoints (create, restore, reveal, unlock, lock, deposit), the scheduler-URL setting, and the account sign-in, wallet-link and spend-grant routes are **not wrapped at all**. A test greps the source to keep it that way.
- Every mutating tool is confirm-gated and says plainly what it changes. `model_uninstall` is also flagged destructive in its MCP tool annotations.
- No API keys or wallet material are logged or stored. The API key lives in a private field, and a test asserts it never appears in error messages.

## Relationship to the KAI project

Independent and unaffiliated. Built against the shipping app by reading its source; the surface is documented in [`docs/KOINOS-AI-API.md`](docs/KOINOS-AI-API.md). Nothing here is endorsed by, or the responsibility of, the KAI project.

## Licence

MIT, see [LICENSE](LICENSE).
