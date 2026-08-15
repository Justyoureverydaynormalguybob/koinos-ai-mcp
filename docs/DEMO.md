# Demo script

A ~3-minute recording that shows an AI agent operating a Koinos AI node. Every
beat below was verified live against app v0.23.3 before this script was written;
nothing here is aspirational.

## Setup (before recording)

- Koinos AI app running (a model installed; earning can stay off).
- Server registered: `claude mcp add koinos-ai -- node <path>/src/index.js`
  — for the multi-node beat, register with
  `--env KOINOS_AI_NODES="desktop=http://127.0.0.1:41100,laptop=http://<other>:41100"`
  (a second entry that's offline still demos well: it shows graceful degradation).
- Terminal font large; Claude Code in a fresh session so tool calls are visible.

## Scene 1 — "Is my node healthy?" (~20s)

> **Ask:** "Check my Koinos AI node — what hardware did it detect and what model is loaded?"

`health` returns app version, CPU/GPU/RAM detection (incl. the CUDA→Vulkan→CPU
capability ladder), and the active model. If a model is downloading, point out
`modules.models.bytes` ticking up — the agent can watch download progress.

## Scene 2 — the guardrail beat (~40s, the important one)

> **Ask:** "Download the smartest model my machine can run."

The agent calls `model_ensure` **without** confirm and gets back a preview:
*4.7 GB, apache-2.0, nothing downloaded* — then has to tell you the size and ask.
Only after you say yes does it call again with `confirm: true`.

This is the §34 Ask-First model from Koinos AI's own spec, applied to external
agents: **no mutating tool can fire silently.** Worth saying out loud that the
wallet reveal/restore endpoints are not wrapped at all — an agent cannot touch
key material at any confirmation level.

## Scene 3 — privacy posture (~20s)

> **Ask:** "Set me to local-only — nothing leaves this machine today."

Confirm flow again, then `network_status` proves the mode stuck.

## Scene 4 — scheduled work (~40s)

> **Ask:** "Every morning at 7, have my node summarize what matters in AI —
> and run it once now so I can see it."

`task_create` → `task_run_now` → the local model's answer lands in chat history
(`chat_get` shows it) — a real local inference triggered end-to-end by the agent.
Delete the task on camera afterwards if you don't want to keep it.

## Scene 5 — fleet view (~20s)

> **Ask:** "Which of my machines is idle?"

`nodes_status`: one call, every configured node — version, active model, earning
state, privacy mode; an unreachable machine shows `reachable: false` instead of
breaking the answer.

## Close (~10s)

One line: *"Koinos AI's control plane, driven conversationally — read surface
open, write surface confirm-gated, wallet untouchable. Works today, from the
outside, with zero changes to the app."*
