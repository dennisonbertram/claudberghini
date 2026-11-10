<p align="center">
  <img src="assets/banner.png?v=3" alt="claudberghini, a lobster fused with a Lamborghini, line-drawing style" width="100%">
</p>

# claudberghini 🦞🏎️

A small proxy that speaks the Anthropic Messages API, so Claude Code can run on Llama 3.1 8B served from [Taalas](https://taalas.com) silicon at about 14,500 tokens/sec.

**Result.** The core coding operations (read, edit, create, grep) pass 5/5 each on the Taalas backend, and one generation of a short HTML page takes about 8 ms. Harder multi-step tasks are weaker: about 0.70 on the "hard 10" set, against 1.00 for the same model on OpenRouter. A 19-task reliability eval of the Llama path measured 75-78% overall after fixes (`eval/RELIABILITY.md`).
**Status.** Working demo and measured study. It is an 8B model and is not reliable on tangled multi-file work.

<p align="center">
  <img src="assets/speed-chart.svg?v=2" alt="Tokens/sec generating an HTML page: claudberghini ~14,500, Groq Llama-8B ~1,250, Claude Sonnet 4.5 ~50, Claude Opus 4.1 ~14" width="100%">
</p>

| Engine (task: "write a basic HTML page") | Tokens/sec |
|--------|-----------:|
| claudberghini (Taalas silicon, Llama 3.1 8B) | ~14,500 |
| Groq (Llama 3.1 8B) | ~1,250 |
| Claude Sonnet 4.5 | ~50 |
| Claude Opus 4.1 | ~14 |

Reproduce with `./eval/speed-benchmark.sh`. More detail is in [BENCHMARK.md](BENCHMARK.md), which records a decode rate of 14,900-17,700 tokens/sec and about 332 ms of model time per agent turn.

## How it works

The Taalas demo (known as ChatJimmy) has no API and no tools support, so the proxy was built from its network traffic. The proxy:

- Accepts Anthropic Messages API requests, so Claude Code (through [deep-claude](https://github.com/dennisonbertram/deep-claude)) can use it unmodified.
- Replaces Claude Code's 120 KB system prompt with a compact, eval-tuned one, and cuts about 60 tools down to the coding set.
- Injects a `<tool_call>` format into the prompt and parses the model's text back into Anthropic `tool_use` blocks.
- Re-samples until a valid tool call parses (best-of-N), and picks the final answer most supported by tool output.
- Blocks destructive commands such as `sudo`, `rm -rf /`, `mkfs`, `dd`, `curl ... | sh` and writes to `/etc/{passwd,shadow,hosts,sudoers}`. This is a guard for a small model, not a security boundary. Run it on code you trust.
- Routes requests for an `opus` model to real Anthropic (needs `ANTHROPIC_API_KEY`), so Opus can coordinate while Llama sub-agents do the implementation. See [CHANGELOG.md](CHANGELOG.md).

`BACKEND=openrouter` sends requests to `meta-llama/llama-3.1-8b-instruct` on OpenRouter instead of the Taalas demo.

## Run it

Requires macOS or Linux, Node.js 18+, [Claude Code](https://claude.com/claude-code) on your `PATH`, and [deep-claude](https://github.com/dennisonbertram/deep-claude).

```bash
git clone https://github.com/dennisonbertram/claudberghini
cd claudberghini
npm install && npm run build
deep-claude endpoints add claudberghini http://localhost:3000   # one time

cd your-project            # Claude Code limits file tools to the working directory
/path/to/claudberghini/claudberghini                          # interactive
/path/to/claudberghini/claudberghini -p "create an index.html with a Hello World heading"
```

The launcher starts the proxy if it is not running. By default it uses a real Opus coordinator, which needs `ANTHROPIC_API_KEY`. To run the whole session on Llama, set `CLAUDBERGHINI_MODEL=claude-sonnet-4-6`. Run the unit tests with `npm test`.

## Repo map

- `src/`: the proxy (`server.ts`, `transform.ts`, `tools.ts`, `handlers.ts`, `types.ts`)
- `claudberghini`: launcher script
- `llama-system-prompt.txt`: the compact prompt sent to the model
- `eval/`: eval harness, reliability eval and results, speed benchmark
- `test/`: unit tests
- `docs/`: GitHub Pages site at https://dennisonbertram.github.io/claudberghini/
- [BENCHMARK.md](BENCHMARK.md), [CHANGELOG.md](CHANGELOG.md), [eval/RELIABILITY.md](eval/RELIABILITY.md), [TOOL_FOLLOWING_GUIDE.md](TOOL_FOLLOWING_GUIDE.md)

## Configuration

| Env | Default | What |
|-----|---------|------|
| `BACKEND` | `claudberghini` | `openrouter` to use `meta-llama/llama-3.1-8b-instruct` |
| `TOOL_SAMPLE_ATTEMPTS` | `5` | best-of-N draws to get a valid tool call |
| `ANSWER_SAMPLE_ATTEMPTS` | `3` | grounded answer candidates |
| `TOOL_ALLOWLIST` | coding set | comma list, or `*` to pass all tools through |
| `MAX_SYSTEM_BYTES` | `18000` | trim the system prompt to fit the ~24 KB ceiling |
| `CLAUDBERGHINI_API_URL` | `https://chatjimmy.ai` | the Taalas demo endpoint |

## The story

We couldn't get an API key. Taalas's demo doesn't ship one — it's a chat box on a website. So we
did the only reasonable thing: **opened the browser dev tools, watched it talk, and rebuilt the
API from the network traffic.** (`POST /api/chat`, raw-text streaming, a `<|stats|>` trailer with
the juicy token-rate telemetry. You're welcome.) We didn't get access; we *made* access.

Then the hard part. An 8B model is a mediocre tool-follower out of the box — it rambles, invents
filenames, botches JSON, and occasionally tries to `sudo rm` your `/etc/hosts` when you say "hi."
So we built an **eval harness** (real Claude Code agent loops over verifiable coding tasks) and
**iteratively, recursively tuned** against it:

- a hill-climbing workflow proposed prompt variants, scored each on the eval, kept the winners, and looped **until 10 rounds passed with no improvement**;
- we **trimmed the toolset** the model sees from ~60 down to the coding essentials (the noise was making it pick the wrong tool);
- we taught the proxy to **re-sample on a botched tool call** and to **ground final answers in real tool output** (killing the "I'll just make up the filename" failure mode);
- and we added a guard so the fast-but-dim model can't be talked into anything destructive.

Net result: the core operations — read, edit, create, grep — land **5/5**, on the fastest
inference on the planet. The [eval/](eval/) directory has the whole rig.

## Acknowledgements

Inference by [Taalas](https://taalas.com). Built to work with [deep-claude](https://github.com/dennisonbertram/deep-claude), which points Claude Code at a custom endpoint while keeping your real Anthropic login untouched.

## License

MIT, see [LICENSE](LICENSE).
