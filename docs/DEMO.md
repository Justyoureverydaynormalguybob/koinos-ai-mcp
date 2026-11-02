# Demo script

A recording of about two minutes showing an AI agent operating a KAI Core node. Every step below was checked live against KAI Core Beta (app 0.7.17) on 2026-11-02.

## Setup (before recording)

- KAI Core running, with at least one model downloaded. Earning can stay off.
- Server registered: `claude mcp add koinos-ai -- node <path>/src/index.js`. For the multi-node step, register with `--env KOINOS_AI_NODES="desktop=http://127.0.0.1:41100,laptop=http://<other>:41100"`. An offline second entry still demos well, because it shows the answer degrading rather than failing.
- Large terminal font, and Claude Code in a fresh session so tool calls are visible.

## Scene 1: "Is my node healthy?" (~20s)

> **Ask:** "Check my KAI node: what hardware did it find, and is a model loaded?"

`health` returns the Core version, CPU/GPU/RAM detection (CUDA, then Vulkan, then CPU), and the runtime state.

## Scene 2: the guardrail (~40s, the important one)

> **Ask:** "I'm short on disk. What would removing the 7B coder model give me back?"

The agent calls `model_uninstall` **without** confirm and gets Core's own removal plan back: one file, 4.7 GB freed, can be downloaded again, not loaded right now. Nothing has been deleted. It has to tell you and ask; only after a yes does it call again with `confirm: true`.

This is KAI's own Ask-First rule applied to outside agents: **no mutating tool can fire silently.** Worth saying out loud that the wallet endpoints aren't wrapped at all, so an agent can't touch key material at any confirmation level.

## Scene 3: privacy posture (~20s)

> **Ask:** "Set me to local-only. Nothing leaves this machine today."

Confirm flow again, then `network_status` shows the mode stuck.

## Scene 4: fleet view (~20s)

> **Ask:** "Which of my machines is idle?"

`nodes_status`: one call covering every configured node (version, active model, earning, privacy mode). An unreachable machine shows `reachable: false` instead of breaking the answer.

## Close (~10s)

One line: *"KAI's control plane, driven by conversation: reads open, changes confirm-gated, wallet untouchable. For the plugins, the MCP Bridge plugin does the same from inside KAI."*
