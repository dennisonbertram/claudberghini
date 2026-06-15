# Changelog

All notable changes to Claudberghini are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic-ish versioning.

## [1.1.0] - 2026-06-15

A security/correctness hardening pass, a new **hybrid Opus coordinator** mode, and a
**structured reliability eval** that drove the proxied model's measured reliability from
59% → 75%.

### Added
- **Hybrid Opus coordinator.** The proxy is now a model router: a request whose `model`
  matches `ANTHROPIC_PASSTHROUGH_MATCH` (default `opus`) is forwarded **verbatim to real
  Anthropic** using `ANTHROPIC_API_KEY` (no Llama massaging — streaming, status codes, and
  errors pass through); everything else routes to the proxied Llama 3.1 8B. The
  `claudberghini` launcher now defaults to a real-Opus coordinator with the **Workflow/Agent
  tools and slash commands (including `/clear`)** restored — Opus orchestrates fast/cheap
  Llama sub-agents (any non-opus model) for implementation. New env vars: `ANTHROPIC_API_KEY`,
  `ANTHROPIC_API_URL`, `ANTHROPIC_VERSION`, `ANTHROPIC_PASSTHROUGH_MATCH`.
- **Structured reliability eval** — `eval/reliability.js` (19 categorized tasks × N repeats,
  concurrent, per-category reliability verdicts), `eval/reliability-tasks.js`,
  `eval/debug-one.js` (turn-by-turn diagnostic), and **`eval/RELIABILITY.md`** (the
  capability/reliability map).
- **Unit test suite** (`test/`, run via `node --import tsx --test test/*.test.ts`) — 105 tests
  covering tool-call parsing, JSON repair, the safety guard, system-prompt trimming, model
  routing, and tool-input coercion. (`npm test` previously ran against zero files.)

### Fixed
- **Tool-input coercion (big reliability win).** The 8B frequently emits a single-arg tool call
  with `input` as a bare string (`Bash "echo x >> f"`) instead of `{"command": …}`, leaving the
  arg `undefined`, erroring cryptically, and looping the model to a timeout (it also silently
  bypassed the safety guard). `coerceToolInput()` now wraps a bare string into the tool's single
  required param **before** guarding. Overall eval reliability 59% → 75%; edit/count timeouts
  collapsed (29→7, 32→6).
- **Tool-call parsing.** Brace-aware `<tool_call>` extraction no longer truncates when a value
  contains an embedded `</tool_call>`; `repairJson` is string-aware (no longer deletes commas
  inside string values, and recovers single-quoted JSON with embedded double quotes).
- **Streaming.** Control-token detection matches only real Llama trailers (`<|stats|>`, etc.) so
  output containing `<|` is no longer truncated, with partial-token hold-back across chunk
  boundaries; a total backend failure now surfaces an error instead of an empty `200`.
- **System-prompt trimming** is measured in UTF-8 bytes, not UTF-16 chars — multibyte prompts no
  longer overflow the backend's input ceiling and return empty.
- **Eval sandbox.** `Grep`/`Glob`/`LS` executors use argv-based `execFileSync` (no shell
  injection); `resolveIn` rejects sibling-prefix path escapes.

### Security
- Proxy binds **`127.0.0.1`** and drops wildcard CORS (it is a local loopback API).
- Removed the dead **`/proxy` open relay** and **`/convert`** endpoints (and `src/converter.ts`).
  `/proxy` had forwarded the configured bearer token to caller-controlled paths.
- **`guardToolUse`** hardened (segment splitting, wrapper/quote stripping, command-substitution
  recursion) to block known destructive bypasses while allowing normal dev commands — best-effort
  and explicitly documented as **not** a security boundary.
- Opus passthrough sets `maxRedirects: 0` so the real `x-api-key` can never follow a cross-domain
  redirect, and aborts the upstream request on client disconnect.
- Launcher writes its proxy log to a private path instead of world-readable `/tmp`.

### Changed
- Extracted pure, side-effect-free logic into **`src/transform.ts`** (unit-testable without
  booting the server); `src/server.ts` slimmed and `src/handlers.ts` pruned to the health checks.
- `.env.example` documents every env var the code reads (and the stale `CHATJIMMY_API_URL` was
  renamed to `CLAUDBERGHINI_API_URL`).

### Reliability (measured, 20-repeat, post-fix)
`read-extract` 93% (RELIABLE) · `create-write` 81% · `search-find` 73% · `count-analyze` 69% ·
`edit-inplace` 65% · **overall 75%**. The governing rule: single-step, single-target tasks are
reliable; multi-step, multi-edit, and exact multi-line tasks are not. Full map + guidance in
`eval/RELIABILITY.md`. (Best-of-N tuning above the 5/3 default was tested and gave no gain.)

## [1.0.0]

Initial Claudberghini: an Anthropic-API proxy that runs Claude Code on Taalas's silicon-baked
Llama 3.1 8B (~14,500 tok/s) — tool-call injection/parsing, best-of-N sampling, grounded answer
selection, and the `eval/` config-optimization harness.
