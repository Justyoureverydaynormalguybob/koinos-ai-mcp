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
- `src/tools.js` — the tool registry: 26 read-only + 26 confirm-gated mutating tools
- `src/release.js` — GitHub latest-release lookup for the `nodes_status` update
  check: cached 10 min, fail-soft, 3s timeout; the server's ONLY outbound call
  beyond the configured nodes (`KOINOS_AI_NO_VERSION_CHECK=1` disables,
  `KOINOS_AI_RELEASES_URL` overrides for tests)
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
- Tracking upstream: check https://koinosai.com/updates first (machine-readable
  `/updates.json`, `latest` field; exists since app 0.48.0). Release tags carry
  stale 0.25-era source and no notes — the real code is on the rotating `claude/…`
  session branch (list the repo's branches, take the newest; see the API doc
  header). Read shapes there, then verify against the live node.
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
- MCP-registration writes (`/core/mcp` add/remove/toggle, app v0.48+) join that list:
  registering an MCP server makes the app execute an arbitrary command, so wrapping
  it would be remote code execution by design. Read-only listing only.
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

- [x] M7 — `model_import` + `model_remove_custom` (BYO GGUF; import is job-based,
      file referenced in place; shapes from v0.25.8 model-manager.js, note the
      nested 400 error shape); `earn_nudge` (post-standby scheduler re-register);
      `nodes_status` update check against the latest GitHub release (fail-soft,
      cached, opt-out via `KOINOS_AI_NO_VERSION_CHECK=1` — live-verified
      2026-08-16: reported 0.25.8/up-to-date). Import/remove/nudge deliberately
      not live-probed (no spare GGUF; nudge needs a wallet).

- [x] M8 — the embedded Koinos blockchain node (app v0.28+, `POST /core/koinos/rpc`
      channel dispatch). 7 read tools (status, setup, dashboard, balances, reburn,
      producer, logs) + 4 confirm-gated (start, stop, quick-sync with a
      size/disk-surfacing preview — observed 63.5 GB archive / 165 GB required —
      and chain_burn with a max-burn preview and IRREVERSIBLE labelling). The
      value-moving channels (chain send, fund sends, bridges, swaps, onramp) are
      never wrapped; a test greps tools.js for those channel names to enforce it.
      Node tools inherit the app's server-side privacy gate (refused in local-only).
      Live-verified on v0.28.4 against a real wallet (2026-08-18). 40 tools, 33 tests.

- [x] M9 — HTTP mode (2026-08-18): `--http <port>` serves Streamable HTTP,
      stateless (fresh server+transport per request), bound to 127.0.0.1 with a
      capability-URL token (`/<token>/mcp`; wrong token = bare 404). Read-only by
      default — mutating tools absent from the list and refused by name — writes
      only via `--http-writes`/`KOINOS_AI_HTTP_WRITES=1`. Built for phone access
      via a tunnel + claude.ai custom connector. Live-smoked against v0.28.4.
      44 tools total (over stdio), 36 tests. v0.4.0.

- [x] M10 — AI Teams + benchmark + dev switch (app v0.28.8+, 2026-08-20):
      `teams_list`/`bench_list` reads, confirm-gated `team_run` (SSE trace
      aggregated into answer+trace; model defaults to the node's active/first-ready
      alias — the endpoint has no server-side default), `bench_run`, and
      `dev_tools_set` (gates bench + custom team specs upstream). Live-verified on
      v0.29.1 incl. a real writer→critic team run (2 model calls, 10s). Account
      endpoints deliberately unwrapped (interactive auth + wallet-key signing).
      45 tools, 37 tests. v0.5.0.

- [x] feedback_send (2026-08-22): confirm-gated wrapper for `POST /core/feedback`
      `{message ≤4000, email?, includeLog?}` — OUTWARD-FACING (the node relays to
      koinosai.com with appVersion+platform attached), so the preview quotes the
      full message; refuses >4000 chars because upstream silently truncates.
      Shape from core/server.js @ v0.42.0; endpoint live-verified the same day
      (sent real feedback about the app's MCP tool-picker labels). Hidden in
      HTTP read-only mode like every mutating tool. 47 tools, 38 tests. v0.5.2.

- [x] M11 — 0.48.0 keep-up reads (2026-08-24): `mcp_servers_list` (the app's MCP
      registry — server metadata, connection state, tool names with schemas
      stripped, the one-click catalog, Node-runtime availability; registration
      writes are policy-banned, see Safety model), `memory_list`, `voice_status`.
      App jumped 0.42→0.48 in two days; shapes were discovered and verified
      against the live node (release tags carry stale 0.25-era source). Same
      day, corrected: the real source lives on the rotating `claude/…` session
      branch, and the changelog moved to koinosai.com/updates — both now in
      Conventions. Memory/voice write shapes since read from the branch (see
      backlog). 50 tools, 39 tests. v0.6.0.

- [x] M12 — 0.49/0.50 keep-up (2026-08-30): `remote_access_status` +
      confirm-gated `remote_access_set` (app 0.50's /v1 public address via the
      koinosai.com relay; enabling is OUTWARD-FACING and the preview says so;
      upstream hard-gates on an API key existing, and only /v1 ever crosses the
      relay — control plane stays localhost, per remote-access.js on the live
      branch). earn_status now documents the 0.49 courtesy pause
      (worker.backoff/backoffReason = paused on purpose, not broken) and
      modelGate; fake worker shape refreshed from a live 0.50.1 capture.
      Reads + unconfirmed-set preview live-verified on v0.50.1 (2026-08-30);
      the confirmed flip deliberately not fired against the live node.
      52 tools, 40 tests. v0.7.0.

## Ideas / backlog

- Model uninstall (app 0.43.0) — shapes read from the live branch:
  `GET /core/models/installed/<packageId>` returns a removal *plan* (upstream
  built our preview for us) incl. in-use detection; `DELETE` same path removes.
  Confirm-gated destructive wrapper; frees multi-GB downloads.
- Memory/voice writes (branch-read): `DELETE /core/memory/<id>` (`all` clears
  everything — destructive), `POST /core/voice/setup` (background ~156 MB
  download, poll GET /core/voice; model_ensure-style preview).
- Block-producer stake reporting (app 0.46.0–0.47.2): producing VHP vs held VHP,
  share of network, expected block rate, stake-idle warning. Likely new fields on
  existing node channels — verify they flow through `node_producer_status` /
  `node_rewards_status` and update fake shapes.
- Large unwrapped families on the live branch, each needing a security read
  before any wrapping: `code/*` (project runner + GitHub incl. push/PR —
  effectively code execution), `email/*` (send!), `calendar/*`, `agents/*`
  (defs/run/input/stop), generic `tools/call`, `search`, `fetch`, `transcribe`,
  `update`, `mcp/runtime`. Account family stays unwrapped (interactive auth +
  wallet linking).

- ~~npm publish~~ Done 2026-08-17: `koinos-ai-mcp@0.2.0` live on npm (maintainer
  `hung0v3r`; publishes need the browser security-key flow, so run `npm publish`
  from an interactive terminal). `npx -y koinos-ai-mcp` verified on Windows.
  Next: pitch inclusion in the Koinos AI app's one-click MCP catalog (it pins
  npm versions, so this was the prerequisite).
- Upstream contribution candidates, in their repo not this one: an embedding model
  catalog entry (`/v1/embeddings` exists with nothing to serve it), tidier 404s for
  missing chat/doc ids (currently leak local filesystem paths). CORS headers were a
  candidate until app 0.51.0 — refusing browsers is now deliberate policy
  (`_sameSite`, see the API doc), so don't propose it.

## Relationship to Koinos AI

Independent and unaffiliated; built from the outside against the shipping app.
Nothing here is endorsed by, or the responsibility of, the Koinos AI project.
