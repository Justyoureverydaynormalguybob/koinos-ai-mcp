# koinos-ai-mcp

An [MCP](https://modelcontextprotocol.io) server for [Koinos AI](https://koinosai.com) —
operate a Koinos AI node from Claude Code, or any MCP client.

> **Status: working.** Full read surface plus guarded write surface (earning, privacy
> mode, models, scheduled tasks), verified against a live node (app v0.23.3). See
> [`CLAUDE.md`](CLAUDE.md) for the build plan.

## Why

Koinos AI runs LLMs locally on your own hardware and can sell your idle GPU time to a
compute network. It exposes a local control plane on `127.0.0.1:41100` — start/stop earning,
check the wallet, swap models, set privacy mode, manage scheduled tasks — but the only thing
that talks to it is the app's own window. One machine, one human, clicking.

This wraps that control plane in MCP, so you can instead say:

> *"How much did my machine earn overnight?"*
> *"Stop earning, I need the GPU."*
> *"Set me to Local-Only — nothing leaves this machine today."*
> *"Which of my three nodes is idle?"*

Chat itself is deliberately **not** wrapped: Koinos AI's `/v1/chat/completions` is already
OpenAI-compatible, so every existing client can use it as-is.

## Requirements

- Node ≥ 22
- A running Koinos AI node ([install](https://github.com/therexdev/kaiapp/releases/latest))

## Install

Not published to npm yet — run from a checkout:

```sh
git clone https://github.com/Justyoureverydaynormalguybob/koinos-ai-mcp
cd koinos-ai-mcp && npm install && npm test
```

Add to Claude Code:

```sh
claude mcp add koinos-ai -- node /path/to/koinos-ai-mcp/src/index.js
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "koinos-ai": {
      "command": "node",
      "args": ["/path/to/koinos-ai-mcp/src/index.js"],
      "env": { "KOINOS_AI_BASE_URL": "http://127.0.0.1:41100" }
    }
  }
}
```

Configuration (all optional): `KOINOS_AI_BASE_URL` (default `http://127.0.0.1:41100`,
honours upstream's `KAI_CORE_PORT`), `KOINOS_AI_API_KEY` (sent as a Bearer token when set),
`KOINOS_AI_TIMEOUT_MS` (default `10000`).

### More than one machine

```json
"env": { "KOINOS_AI_NODES": "desktop=http://127.0.0.1:41100,laptop=http://192.168.1.20:41100" }
```

The first entry is the default. Every tool takes an optional `node` argument
("stop earning on the laptop"), `nodes_status` aggregates all of them concurrently,
and a per-node API key can be set with `KOINOS_AI_API_KEY_<NAME>`.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `nodes_status` | read-only | One view across every configured machine: reachability, version, model, earning, privacy |
| `health` | read-only | Node status: version, hardware, runtime, model storage (doubles as download progress) |
| `models_list` | read-only | Model alias catalog with package pins, sizes, licenses, per-alias status |
| `earn_status` | read-only | Earn worker state, jobs, receipts, earnings, wallet summary (never key material) |
| `network_status` | read-only | Privacy mode, scheduler URL, wallet lock state |
| `tasks_list` | read-only | Scheduled tasks |
| `chats_list` | read-only | Chat list (transcripts omitted for brevity) |
| `chat_get` | read-only | One chat with the full transcript |
| `docs_list` / `doc_get` | read-only | Stored documents |
| `keys_list` | read-only | API key metadata + whether auth is required (keys hashed upstream) |
| `earn_start` / `earn_stop` | **mutating** | Start/stop selling idle compute for KAI |
| `network_set_privacy_mode` | **mutating** | Change privacy posture (local-only / local-first / network) |
| `model_ensure` | **mutating** | Download+load a model by alias; without `confirm` it just reports the size |
| `task_create` / `task_run_now` / `task_delete` | **mutating** | Manage scheduled prompts |

Every mutating tool requires `confirm: true`. Called without it, **nothing changes** —
the tool returns a preview of what would happen, so an agent must state intent before
acting (mirrors upstream's own Ask-First permission design).

## What it looks like

Real output, real node (condensed). Asked to fetch a bigger model, the agent's
first call comes back as a preview, not a download:

```json
{
  "executed": false,
  "requiresConfirmation": true,
  "alias": "koinos-smart",
  "size": "4.7 GB",
  "wouldDo": "Download+load koinos-smart (4.7 GB, apache-2.0).",
  "hint": "Nothing was downloaded. Tell the user the size and, once they agree, call again with confirm: true."
}
```

Asked to create a morning task and test it, the agent creates it, runs it — the
local model answers, on this machine — reads the result out of chat history, and
cleans up:

```json
{ "role": "user",      "content": "Reply with exactly: KOINOS MCP OK" }
{ "role": "assistant", "content": "KOINOS MCP OK" }
```

And `nodes_status` answers "which of my machines is idle?" in one call — an
offline machine degrades instead of failing:

```json
{ "node": "desktop", "reachable": true,  "version": "0.23.3", "activeModel": "koinos-balanced",
  "earning": { "running": false, "jobsDone": 0 }, "privacyMode": "local-only" }
{ "node": "laptop",  "reachable": false, "error": "Could not reach the Koinos AI node… Is the Koinos AI app running?" }
```

A ~3-minute recording script covering all of this lives in
[`docs/DEMO.md`](docs/DEMO.md).

## Safety

- The wallet endpoints (create, unlock, reveal, restore, deposit) are **not wrapped at
  all** — an agent cannot touch key material or move funds at any confirmation level.
  The scheduler-URL setting is likewise unwrapped (repointing it is security-sensitive).
- Every mutating tool is confirm-gated (see above) and carries a blunt description of
  exactly what it changes; `task_delete` is additionally flagged destructive via MCP
  tool annotations.
- No API keys or wallet material are logged or persisted by this server; the node's
  API key lives in a private field and is asserted (by test) never to appear in errors.

## Relationship to the Koinos AI project

Independent and unaffiliated. Built against the public app by reading its source; the
reverse-engineered surface is documented in [`docs/KOINOS-AI-API.md`](docs/KOINOS-AI-API.md).
Nothing here is endorsed by, or the responsibility of, the Koinos AI project.

## Licence

MIT — see [LICENSE](LICENSE).
