# Claudberghini Config Optimizer

An eval harness + hill-climbing optimizer that finds the best **(system prompt, tool subset)**
combination for driving an agent loop on Claudberghini's Llama 3.1 8B backend.

## Why

Claude Code's full ~32KB system prompt + 60 tools overwhelms Claudberghini (which hard-caps input
at ~24KB) and a weak 8B tool-follower. With a *small, focused* prompt and a *minimal* toolset,
the same model performs far better. This finds the sweet spot empirically.

## Components

- `tools-registry.js` — Anthropic-format tool schemas + real executors (Read/Write/Edit/Bash/Grep/Glob/LS) sandboxed to a temp workspace.
- `tasks.js` — 5 verifiable coding tasks (objective pass/fail via file state or a value in the final answer).
- `harness.js` — minimal agent loop (Anthropic SDK → proxy): call model → execute tool_use → feed tool_result → repeat.
- `run-eval.js` — runs every task `EVAL_REPEATS` times for a config, prints `EVAL_RESULT_JSON {score, perTask, ...}`.

## Run a single eval

```bash
# proxy must be running on :3000 with TOOL_ALLOWLIST='*'
cd eval
EVAL_REPEATS=3 node run-eval.js                      # baseline config
EVAL_REPEATS=3 node run-eval.js --config my.json     # {name, system, tools:[...]}
```

`score` = fraction of task-runs passed (0..1).

## Optimize (workflow)

The `optimize-claudberghini-config` workflow hill-climbs:
1. Evaluate baseline.
2. Each round: 3 cheap **haiku** subagents propose distinct (system, tools) variants; 3 bash
   subagents run the eval in parallel; keep the best-of-beam if it beats the incumbent.
3. Stop after 5 consecutive non-improving rounds (or 20 rounds).

Claudberghini/Llama-8B is the system-under-test (invoked by the harness via bash); only the
proposer/judge orchestration uses paid models (haiku). A `/tmp/cj-watchdog.sh` keeps the proxy
alive for the duration.

## Knobs

- `EVAL_REPEATS` (default 3) — runs per task; higher = less noise, slower.
- `EVAL_MAX_TURNS` (default 6) — max agent turns per episode.
- `EVAL_MODEL` (default claude-3-5-sonnet-20241022) — the model *name* sent to the proxy (mapped to llama3.1-8B).
- `PROXY_URL` (default http://localhost:3000).
