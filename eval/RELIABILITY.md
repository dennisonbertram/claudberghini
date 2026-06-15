# Claudberghini Reliability Map

**What can the proxied Llama 3.1 8B model be *reliably* tasked with?**

This is the output of a structured reliability eval + an iteration cycle that found and fixed
a real reliability bug. Reliability = *fraction of independent attempts that succeed* — the
right metric for a non-deterministic model. A category you can trust is one that passes
≈every time.

## How it's measured

- **Harness:** `eval/reliability.js` runs `eval/reliability-tasks.js` (19 objective-verify tasks
  across 5 capability categories) × N repeats, with bounded concurrency, against the running
  proxy. Each run gets a fresh temp workspace; pass/fail is objective (file state or a value in
  the final answer). Failures are bucketed: `wrong_answer` (finished, wrong), `timeout` (never
  produced a final answer within the turn budget), `backend_error`.
- **System under test:** the **Llama path** only. The eval proxy runs with **no
  `ANTHROPIC_API_KEY`** (so the Opus passthrough can't fire) and a non-opus model id, plus
  `TOOL_ALLOWLIST='*'`. It uses the production system prompt (`llama-system-prompt.txt`) + the
  proxy's injected tool-call format + default best-of-N (5 tool / 3 answer) — i.e. what ships.
- **Backend:** `chatjimmy` (the product backend). Numbers are 20-repeat (380 runs).
- **Reproduce:** `cd eval && EVAL_REPEATS=20 node reliability.js` (proxy on :3000).
- **Diagnose one task:** `node eval/debug-one.js <task-name>` prints every turn.

## The iteration that moved the needle

| Stage | Overall | Notes |
|---|---|---|
| Baseline | **59%** | dominated by `timeout` failures in edit/count categories |
| + bare-string-input fix | **75–78%** | the big win — see below |
| + best-of-N raised to 8/6 | 74% (slower) | **no improvement** — more sampling is not the lever |

**Root cause found (via `debug-one`):** the 8B frequently emits a single-arg tool call with
`input` as a **bare string** — `{"name":"Bash","input":"echo x >> f"}` instead of
`{"input":{"command":"echo x >> f"}}`. That left `input.command` undefined, the tool errored
cryptically, and the model *looped to a timeout* (and, separately, `guardToolUse` saw
`undefined` and was bypassed). This is a real product bug — Claude Code's Bash tool would break
identically.

**Fix:** `coerceToolInput()` in `src/transform.ts` (run before `guardToolUse`) wraps a
bare-string input into the tool's single required param when unambiguous (Bash→command,
Read→file_path, …; multi-param tools like Edit/Write are left alone). Effect: edit-inplace
timeouts 29→7, count-analyze 32→6; two categories climbed out of UNRELIABLE.

**Lesson:** the remaining failures are now mostly `wrong_answer` (capability), not mechanical
loops. Best-of-N tuning past the default doesn't help and costs latency — the default 5/3 is the
sweet spot.

## The reliability map (20-repeat, post-fix)

| Category | Reliability | Verdict | Dominant failure |
|---|---|---|---|
| **read-extract** (read a file, report a value) | **93%** | RELIABLE | — |
| **create-write** (write a new file, exact content) | **81%** | MARGINAL | wrong content |
| **search-find** (locate file/line with a string) | **73%** | MARGINAL | multi-step misread |
| **count-analyze** (count/compare over content) | **69%** | WEAK | wrong number / timeout |
| **edit-inplace** (modify an existing file) | **65%** | WEAK | wrong old_string |
| **overall** | **75%** | | |

### Per-task (sorted)
```
RELIABLE (≥90%)   read-json-field 100  which-file-token 100  create-file 95  grep-find 95
                  read-secret 90  create-readme 90  read-kv 90
NEAR (85%)        edit-version 85  count-matches 85  replace-all 85
MARGINAL (75–80%) compare-values 80  create-json 80  count-lines 75  append-line 75
WEAK (<70%)       delete-line 65  create-multiline 60  most-lines 35  find-then-read 25  multi-edit 15
```

## The governing rule

**Reliability tracks STEP COUNT and EXACTNESS, not domain.**

- ✅ **One tool call → one objective result → reliable.** Read a value, find which file has a
  string, run one command, create a short file.
- ⚠️ **One edit / one count, exact output → marginal.** Usually right; verify the result.
- ❌ **Multiple dependent steps, multiple edits, or long exact strings → unreliable.** The model
  misreads multi-step intent (`find-then-read`: read a file literally named "TOKEN" instead of
  grepping for it), guesses `old_string` instead of copying it (`multi-edit`: tries `port: 8080`
  when the file says `port=8080`), and botches exact multi-line content.

## What to task it with (practical guidance)

**Delegate freely to the proxied model** (≥90%, near-free, ~ms each):
- Read a file and report a specific value.
- Find which file (or line) contains a literal string.
- Create a short / single-line file with exact content.
- Run a single shell command and report its output.

**Delegate with a verification gate** (~70–85% — have the coordinator check the result):
- A single in-place edit of one value; a single-pass count; compare two values; write exact
  small JSON. Pair with a re-read/test so a wrong result is caught.

**Do NOT delegate unsupervised** (<65% — keep on the coordinator, or decompose):
- Multi-step "find X then do Y", multiple edits in one task, cross-file aggregation, exact
  multi-line file authoring. Either split into single-step subtasks (each then reliable) or run
  these on the Opus coordinator directly.

### Implication for the hybrid (Opus coordinator + Llama workers)
This is exactly the boundary the hybrid exploits: **fan out RELIABLE single-step subtasks to the
fast/cheap Llama workers; keep multi-step orchestration, exact-string edits, and final
verification on Opus.** A workflow that hands each Llama worker *one* well-specified, objectively
checkable step — and has Opus verify/repair — converts an unreliable-but-fast fleet into a
reliable, cheap result. Handing a worker a multi-step or exact-edit task does not work
unsupervised.

## Artifacts
- `reliability-baseline.json` — pre-fix (59%)
- `reliability-fix1.json` — post coerce-fix (78%)
- `reliability-fix2-bestofN.json` — 8/6 sampling (74%, no gain)
- `reliability-final.json` — 20-repeat validated map (75%)
