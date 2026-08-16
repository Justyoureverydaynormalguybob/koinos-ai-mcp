# koinos-ai-mcp — project context

An MCP server that lets any AI agent operate a **Koinos AI** node
(https://koinosai.com) through its local control plane on `127.0.0.1:41100`.

Read `docs/KOINOS-AI-API.md` before changing tool code — the upstream surface is
reverse-engineered, undocumented by the vendor, and moving fast. Re-verify against a
running node before depending on any of it.

## What this is

Koinos AI is a desktop app: local-first LLM inference on your own hardware, with an
optional "earn" mode that sells idle GPU cycles to a compute network, settled in a KAI
token on the Koinos blockchain. It ships a local HTTP control plane that only its own
Electron window talks to. This repo wraps that control plane in the Model Context
Protocol, so Claude Code (or any MCP client) can check node health, watch earnings,
swap models, change privacy posture, and manage scheduled tasks — conversationally,
across one machine or several.

Chat completions are deliberately **not** wrapped: the app's `/v1/chat/completions` is
already OpenAI-compatible, so every existing client can use it directly.

## Layout

- `src/index.js` — stdio entry (stdout belongs to the transport; logs go to stderr)
- `src/config.js` — env config, single- and multi-node (`KOINOS_AI_NODES`)
- `src/nodes.js` — client pool; resolves the optional `node` tool argument
- `src/client.js` — HTTP client; the API key lives in a private field and is asserted
  (by test) never to appear in error messages
- `src/tools.js` — the tool registry: 13 read-only + 13 confirm-gated mutating tools
- `src/server.js` — MCP wiring (low-level `Server`, plain JSON Schema, no extra deps)
- `test/fake-node.js` — a fake `/core/*` node whose response shapes mirror real
  observed output from a live app; tests run `node --test`, no framework

## Conventions

- Node ≥22, ESM, zero runtime dependencies beyond `@modelcontextprotocol/sdk`.
- Tool names are `snake_case`, never dots — MCP clients (incl. the Claude API) restrict
  tool names to `[a-zA-Z0-9_-]`.
- Don't hardcode upstream enums that the upstream spec says will grow (privacy modes
  especially — six modes are specified, three are shipped). Pass through what the node
  reports; let the node validate.
- Never log or persist API keys or wallet material.
- Keep `test/fake-node.js` shapes in sync with real observed responses (documented in
  `docs/KOINOS-AI-API.md` → "Observed live responses").
- Third-party reference documents (PDF/DOCX) stay local and uncommitted — `.gitignore`
  enforces this.

## Safety model

Follows the Ask-First tool-permission design from Koinos AI's own spec (§34):

- Every mutating tool requires `confirm: true`. Called without it, **nothing changes** —
  the tool returns a preview of what would happen and instructs the agent to state
  intent to the user first. Tests assert zero writes reach the node unconfirmed.
- `model_ensure`'s preview surfaces the download size before anything is fetched.
- The wallet family (`create`, `unlock`, `reveal`, `restore`, `deposit`) and the
  scheduler-URL setting are **not wrapped at any confirmation level** — an agent cannot
  touch key material, move funds, or repoint the node at a different scheduler.
- Mutating tools carry blunt descriptions and MCP tool annotations
  (`readOnlyHint`/`destructiveHint`).
- `key_create` necessarily returns the new key's plaintext secret once — the only
  moment it exists in the clear. The description tells the agent to relay it to the
  user and never store it, and the preview warns when the FIRST key is about to
  flip `/v1/*` from open localhost access to required auth.

## Status

- [x] M1 — stdio skeleton, `health` + `models_list`, live-verified (2026-08-15)
- [x] M2 — full read surface: earn, network, tasks, chats, docs, keys (2026-08-15)
- [x] M3 — confirm-gated write surface: earning, privacy mode, model downloads,
      scheduled tasks; body shapes read from upstream source, benign paths live-verified
      incl. a real local inference (2026-08-15)
- [x] M4 — multi-node: `KOINOS_AI_NODES`, per-tool `node` arg, `nodes_status`
      aggregate with per-node degradation (2026-08-16)
- [x] Docs: README with real captured transcripts; `docs/DEMO.md` recording script
- [x] M6 (first slice) — `chat_delete`, `chat_rename`, `task_set_enabled`; client
      gained PATCH + per-request timeout override (task_run_now floors at 120s —
      runs queue behind model swaps, see API doc quirks). Endpoints live-verified
      on app v0.25.8 (2026-08-16); route table re-read from the v0.25.8 source.
- [x] M6 (second slice) — network read tools (`network_models`, `network_overview`,
      live-verified on v0.25.8, 2026-08-16); key management (`key_create` /
      `key_revoke` / `key_set_budget`, confirm-gated, shapes read from v0.25.8
      keys.js — create's preview warns that the FIRST key flips /v1/* to required
      auth; writes deliberately not live-probed for that reason); `task_run_now`
      now reads the assistant's answer back from `lastChatId` (run is awaited
      upstream — no polling), fail-soft on the stale-chat-index quirk.

Test suite: 28 green via `npm test`.

## Ideas / backlog

- `model_import` wrapper (BYO GGUF, job-based) — `POST /core/models/import`.
- Version check in `nodes_status` against the latest GitHub release (0.23.3→0.25.8
  jump happened mid-session; nodes drift).
- npm publish for one-command install.
- Upstream contribution candidates, in their repo not this one: CORS headers on the
  gateway (currently absent, blocks browser clients), an embedding model catalog entry
  (`/v1/embeddings` exists with nothing to serve it), tidier 404s for missing chat/doc
  ids (currently leak local filesystem paths).

## Relationship to Koinos AI

Independent and unaffiliated; built from the outside against the shipping app.
Nothing here is endorsed by, or the responsibility of, the Koinos AI project.
