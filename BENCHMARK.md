# Claudberghini Speed Benchmark — "The Fastest Coding Harness"

Claude Code driving Claudberghini's Llama 3.1 8B backend through the proxy.
Reproduce: `./eval/speed-benchmark.sh` (proxy must be up on :3000 in Claudberghini mode).

## Raw inference speed (Claudberghini `/api/chat` telemetry)

| Metric | Value |
|--------|-------|
| Decode rate | **~14,900–17,700 tokens/sec** |
| Time-to-first-token | **~1.1 ms** |
| Full short response | **~3 ms** |

For comparison (decode rate, Llama-8B-class or frontier):
- Claude / GPT-4 class: ~50–100 tok/s → **Claudberghini is ~150–280× faster**
- Groq Llama-3.1-8B (famously fast): ~1,250 tok/s → **Claudberghini is ~10× faster**

## End-to-end agentic tasks (real Claude Code loop)

Averaged over 4 real tasks (read / create / edit / count), N as run:

| Metric | Value |
|--------|-------|
| Model time per task | **~830 ms** |
| Model time per turn | **~332 ms** (includes best-of-N resampling + network) |
| Turns per task | ~2.5 |
| Wall-clock per task | ~4.5 s (dominated by per-invocation harness startup, not the model) |

A frontier model spends **~2–5 s per turn** on inference alone; Claudberghini spends ~332 ms
per turn *including* up to 5× best-of-N resampling.

## The key insight: speed buys reliability for free

Llama 3.1 8B is a weak tool-follower. We make it reliable with **best-of-N sampling** —
re-drawing the model up to 5× per tool turn until a valid tool call parses, plus
"grounded best-of-N" that picks the answer most supported by actual tool output.

On a normal model, 5× sampling would be prohibitively slow. On Claudberghini, each draw is
~3 ms of inference, so **5× oversampling is essentially free** — and the whole turn is
still faster than a single frontier-model call. The extreme speed is precisely what makes
the cheap, weak model usable as a coding agent.

## Quality (real Claude Code path, after tuning)

| Task set | Claudberghini | OpenRouter llama-3.1-8b |
|----------|-----------|--------------------------|
| Core 4 (read/edit/create/grep) | 5/5 each (19–20/20) | 20/20 |
| Hard 10 (multi-step/mutation) | ~0.70 | 1.00 |

Claudberghini's instance is more quantized than OpenRouter's, so absolute quality is lower,
but the core coding loop is reliable and the speed is unmatched.

## How to run a project on it

```bash
cd your-project
/Users/dennison/develop/claudberghini/claudberghini -p "your coding task"
# or interactively:
/Users/dennison/develop/claudberghini/claudberghini
```
