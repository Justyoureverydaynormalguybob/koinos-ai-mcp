# Koinos AI local API — reverse-engineered surface

Read from `therexdev/kaiapp` @ branch `claude/kai-production-website-fqx4pf`,
version **v0.21.2** (2026-08-15); route table re-read from `gateway.js` @ tag
**v0.25.8** (2026-08-16). Sources: `core/lib/gateway.js`, `core/server.js`,
`core/models/catalog.json`, `core/lib/chats.js`, `core/lib/tasks.js`.

**Nothing here is documented by the vendor.** It was read out of the source. Re-verify
against a running node before depending on any of it — they shipped 21 releases in
40 hours and the surface is moving fast.

## Transport

| | |
|---|---|
| Bind | `127.0.0.1` — localhost only, always |
| Port | `41100` (override with env `KAI_CORE_PORT`) |
| Auth | `Authorization: Bearer <key>` on `/v1/*` |
| CORS | **None implemented.** No `Access-Control-*` headers anywhere. Browser clients will fail. |

Two route families on one port.

## `/v1/*` — OpenAI-compatible (already usable by any OpenAI client)

```
GET  /v1/models
POST /v1/chat/completions     streaming supported; raw proxy to llama-server
POST /v1/embeddings           route exists; no embedding model in the catalog yet
```

Requires a Bearer key once one has been created. Before the first key exists, auth is
optional — "keys-optional-then-required".

Model aliases (not filenames): `koinos-fast`, `koinos-balanced`, `koinos-smart`.
`koinos-fast` is currently pinned to Qwen2.5-1.5B-Instruct Q4_K_M.

## `/core/*` — the control plane (THIS is what we're wrapping)

Undocumented, unwrapped, and the reason this project exists.

```
GET  /core/health                 node status
GET  /core/models                 installed + available models
POST /core/models/ensure          download/ensure a model is present
POST /core/models/import          BYO-GGUF import; job-based (hashing a big file takes
                                  minutes) — returns {done:false} after ~800ms, UI
                                  polls /core/models importStatus       [new in 0.25.x]
DELETE /core/models/custom/<id>   remove an imported custom model       [new in 0.25.x]

GET  /core/earn                   earning status
POST /core/earn/start             begin taking network jobs
POST /core/earn/stop              stop taking network jobs
POST /core/earn/nudge             re-register with scheduler after OS standby
                                                                        [new in 0.25.x]
     /core/earn/config            earning configuration
     /core/earn/wallet            wallet state
     /core/earn/wallet/reveal     ⚠ exposes key material — DO NOT WRAP
     /core/earn/wallet/restore    ⚠ wallet restore — DO NOT WRAP
     /core/earn/deposit
     /core/earn/lock              lock the keystore
     /core/earn/unlock            unlock the keystore

GET  /core/network                network/routing state
     /core/network/config         privacy mode: local-only | local-first | network
GET  /core/network/models         what the network can serve now: {workersOnline,
                                  models}; 20s cache, fail-soft empty   [new in 0.25.x]
GET  /core/network/status         full network tab: {reachable, workersOnline, models,
                                  workers[]} (addresses pre-truncated by the
                                  scheduler); 10s cache, fail-soft      [new in 0.25.x]

GET/POST /core/tasks              scheduled tasks
PATCH/DELETE /core/tasks/<id>     PATCH {enabled:bool} pauses/resumes — re-enable
                                  recomputes nextRunAt (no missed-run burst);
                                  both live-verified on 0.25.8
POST /core/tasks/<id>/run         run now (queues if runtime busy — see quirks)
GET/POST /core/chats              chat history; POST is save/autosave
                                  {id?, title?, messages[], system?, persona?} → {id}
GET/PATCH/DELETE /core/chats/<id> PATCH {title} renames (≤80 chars, sets renamed:true
                                  so autosaves keep it) → {ok, id, title}; DELETE →
                                  {ok:true}; both live-verified on 0.25.8
GET/POST /core/docs               documents surface
GET/DELETE /core/docs/<id>
GET/POST /core/keys               API key management (hashed at rest)
DELETE /core/keys/<id>            revoke a key
POST /core/keys/<id>/budget       {budgetUsdMonthly} per-key spending cap — spec §34
                                  "spending limits" shipped             [new in 0.25.x]
POST     /core/feedback           in-app feedback
POST     /core/chat/completions   the UI's own chat lane — deliberately separate from
                                  /v1 so creating an external key can't lock the app
                                  out of its own chat
```

### Safety notes for tool design

- **Never wrap `wallet/reveal` or `wallet/restore`.** Those move or expose key material.
  An agent should not be able to touch them, at any confirmation level.
- `earn/start`, `earn/stop`, `network/config` change real machine behaviour and privacy
  posture — mark them clearly as mutating and make the agent state intent.
- `models/ensure` triggers a large download (engine ~250MB–390MB CUDA, models 100MB–GBs).
  Surface size before firing.

## Observed live responses (v0.23.3, 2026-08-15)

Verified against a running node on Windows. `/core/*` GETs succeeded **without** any
Authorization header (keys-optional held for the control plane on a fresh install).

`GET /core/health` → `{ ok, version, dataDir, hardware, modules }`:

- `hardware`: `platform`, `arch`, `cpu {model, cores}`, `ramBytes`, `gpus []`,
  `disk {freeBytes, totalBytes}`, `capabilities {cudaEligible, vulkanEligible, cpuFallback}`.
  (AMD iGPU machine correctly reported `vulkanEligible: true, cudaEligible: false` —
  matches the runtime ladder.)
- `modules.gateway {ok, port}` · `modules.runtime {activeAlias, loading, runtime,
  lastLoadError}` · `modules.models {ok, bytes, dir}` — `bytes` grows live during a
  model download, so health doubles as a download-progress signal.

`GET /core/models` → `{ ok, aliases: [...] }` — **not** an installed/available split.
Each alias: `{ alias, label, blurb, package, sizeBytes, license, minRamGb, status }`.
`status` values observed: `partial` (mid-download), `absent`; `ready` presumed for
installed. All three pins confirmed: `koinos-fast` = qwen2.5-1.5b-instruct-q4_k_m@1,
`koinos-balanced` = llama-3.2-3b-instruct-q4_k_m@1, `koinos-smart` =
qwen2.5-7b-instruct-q4_k_m@1.

`GET /core/earn` → `{ ok, wallet: {exists, unlocked, address, createdAt},
worker: {running, jobsDone, receiptsAccepted}, schedulerUrl, earnings }` — the wallet
*summary* lives here; there is no separate wallet GET.

`GET /core/network` → `{ ok, privacyMode, schedulerUrl, walletUnlocked }` — the
privacy-mode **read** is here, not under /core/network/config.

`GET /core/tasks` → `{ ok, tasks: [] }` · `GET /core/docs` → `{ ok, docs: [] }`

`GET /core/chats` → `{ ok, chats: [{id, title, updatedAt, messages, searchText}] }` —
`searchText` is the full transcript flattened into one string (large; our `chats_list`
tool strips it). `GET /core/chats/<id>` → `{ ok, chat: {id, title, renamed, createdAt,
updatedAt, messages: [{role, content}]} }`.

`GET /core/keys` → `{ ok, required, keys: [] }` — `required: false` on a fresh
install, which is why the whole surface answers unauthenticated.

Mutating shapes (confirmed from upstream source, not probing):

- `POST /core/network/config` `{privacyMode}` — must be `local-only | local-first |
  network` (validated upstream) → returns network status.
- `POST /core/models/ensure` `{alias}` → `{ok, started, alias}`; async job, poll
  GET /core/models (`ensure: {alias, state, error}`); 409 if a load is in flight.
- `POST /core/tasks` `{name ≤60, prompt ≤4000, model, schedule: {kind: hourly|every6h|
  daily|weekly, hour?: 0-23, day?: 0-6}}` → `{ok, task}`. Also `POST /core/tasks/<id>/run`
  (runs now, result lands in a chat, returns task with `lastChatId`), `PATCH` `{enabled}`,
  `DELETE`. Task runs go through the same §7 privacy routing as typed chats.
- `POST /core/earn/start` / `stop` — no body. `POST /core/earn/config` `{schedulerUrl}`
  (deliberately unwrapped: repointing the scheduler is security-sensitive).
- Wallet family (`/core/earn/wallet[.../restore|/reveal]`, `unlock`, `lock`, `deposit`)
  — POST-only, password-guarded upstream; reveal requires the password every time even
  while unlocked. All unwrapped, per policy.

Route quirks (v0.23.3; re-checked on v0.25.8 — read shapes unchanged):

- The `config` routes and `/core/tasks/<id>` are POST/PATCH/DELETE-only — GETs on them
  router-404 (`invalid_request_error`).
- Missing chat/doc ids 404 with `{ok:false, error:"ENOENT: ... <full local path>"}` —
  a raw fs error incl. the absolute data-dir path. Harmless locally; worth an
  upstream note someday.
- `POST /core/tasks/<id>/run` requests are queued, not dropped, when the runtime is
  busy (e.g. mid model-swap): a request whose client times out and disconnects still
  executes once the model loads, so retries produce duplicate runs — observed live
  2026-08-16, four "⏰ test" chats stamped within ~600ms after a queue flush. The
  chat index can also serve stale entries until the app restarts (the flushed runs'
  chats were invisible to `GET /core/chats` until then). Our `task_run_now` 120s
  timeout floor exists so the client stays connected instead of abandoning a queued run.

## Privacy modes (what's actually implemented)

`local-only` · `local-first` · `network`

The website advertises four tiers including "Private Pool" and "Confidential Compute" —
those are **roadmap only**, absent from the code.

**Do not hardcode this three-value enum in tools.** Their spec (§7, LOCKED) defines six
routing modes — Local First, Private Pool First, Local Only, Network Only, Lowest Cost,
Fastest — plus a future Confidential Only. The set will grow. Tools should pass mode
strings through and surface whatever the node reports, validating loosely at most.

## Runtime ladder

CUDA → Vulkan → CPU → Ollama fallback. Ollama adapter expects `127.0.0.1:11434`
(`KAI_OLLAMA_HOST` / `KAI_OLLAMA_PORT`). `KAI_LLAMA_BIN` forces a local llama-server binary
and skips auto-provisioning.
