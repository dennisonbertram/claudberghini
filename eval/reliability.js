/**
 * Structured RELIABILITY eval.
 *
 * Runs every categorized task EVAL_REPEATS times against the running proxy (Llama path),
 * with bounded concurrency, then reports reliability PER CATEGORY with a verdict, so we
 * get a clear map of what the proxied model can be reliably tasked with.
 *
 * Reliability is "fraction of independent attempts that succeed" — the right metric for a
 * non-deterministic model: a category you can trust is one that passes ~every time.
 *
 * Usage:
 *   # proxy on :3000 (TOOL_ALLOWLIST='*'); measures the Llama path (non-opus model)
 *   EVAL_REPEATS=12 node reliability.js                  # production prompt (llama-system-prompt.txt)
 *   EVAL_REPEATS=12 node reliability.js --config c.json  # {name, system, tools:[...]}
 *   EVAL_LABEL=baseline EVAL_REPEATS=12 node reliability.js   # also writes reliability-baseline.json
 *
 * Knobs: EVAL_REPEATS (10), EVAL_CONCURRENCY (4), EVAL_MAX_TURNS (6),
 *        EVAL_MODEL (claude-3-5-sonnet-20241022 → Llama), PROXY_URL (:3000).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgentLoop } = require('./harness');
const { getToolSchemas, makeExecutor } = require('./tools-registry');
const { TASKS } = require('./reliability-tasks');

const REPEATS = Number(process.env.EVAL_REPEATS || 10);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 4);
const MAX_TURNS = Number(process.env.EVAL_MAX_TURNS || 6);

function loadConfig() {
  const idx = process.argv.indexOf('--config');
  if (idx >= 0 && process.argv[idx + 1]) {
    const c = JSON.parse(fs.readFileSync(process.argv[idx + 1], 'utf8'));
    return { name: c.name || path.basename(process.argv[idx + 1]), system: c.system, tools: c.tools || null };
  }
  // Default: the production system prompt the launcher ships (proxy still injects the tool-call format).
  const sp = fs.readFileSync(path.join(__dirname, '..', 'llama-system-prompt.txt'), 'utf8');
  return { name: 'production', system: sp, tools: null };
}

async function runOnce(task, cfg) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `relx-${task.name}-`));
  try {
    task.setup(ws);
    const offered = cfg.tools ? (task.tools || []).filter((t) => cfg.tools.includes(t)) : (task.tools || []);
    const tools = getToolSchemas(offered.length ? offered : task.tools);
    const res = await runAgentLoop({
      system: cfg.system,
      tools,
      userPrompt: task.prompt,
      executeTool: makeExecutor(ws),
      maxTurns: MAX_TURNS,
    });
    if (res.error) return { passed: false, reason: 'backend_error' };
    if (res.timedOut) return { passed: false, reason: 'timeout' };
    const passed = task.verify({ finalText: res.finalText, workspace: ws });
    return { passed, reason: passed ? 'pass' : 'wrong_answer' };
  } catch (e) {
    return { passed: false, reason: 'exception', message: e.message };
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

// Bounded-concurrency pool: run `worker(item)` over items, at most `n` at once, preserve order.
async function pool(items, n, worker) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  await new Promise((resolve) => {
    const launch = () => {
      if (next >= items.length) { if (done === items.length) resolve(); return; }
      const idx = next++;
      Promise.resolve(worker(items[idx], idx)).then((r) => {
        results[idx] = r;
        done++;
        if (done % 10 === 0) process.stderr.write(`  …${done}/${items.length} runs\n`);
        launch();
      });
    };
    for (let i = 0; i < Math.min(n, items.length); i++) launch();
  });
  return results;
}

function verdict(rate) {
  return rate >= 0.9 ? 'RELIABLE' : rate >= 0.7 ? 'MARGINAL' : rate >= 0.4 ? 'WEAK' : 'UNRELIABLE';
}

async function main() {
  const cfg = loadConfig();
  const t0 = Date.now();

  // Build a flat job list of (task × repeat) and shuffle-free run them with concurrency.
  const jobs = [];
  for (const t of TASKS) for (let r = 0; r < REPEATS; r++) jobs.push(t);
  process.stderr.write(`Reliability eval: ${TASKS.length} tasks × ${REPEATS} repeats = ${jobs.length} runs (concurrency ${CONCURRENCY})\n`);
  const flat = await pool(jobs, CONCURRENCY, (t) => runOnce(t, cfg));

  // Aggregate per-task then per-category.
  const perTask = {};
  const perCat = {};
  let k = 0;
  for (const t of TASKS) {
    const runs = flat.slice(k, k + REPEATS); k += REPEATS;
    const pass = runs.filter((x) => x.passed).length;
    const fail = {};
    for (const x of runs) if (!x.passed) fail[x.reason] = (fail[x.reason] || 0) + 1;
    perTask[t.name] = { category: t.category, passRate: +(pass / REPEATS).toFixed(3), passed: pass, of: REPEATS, fail };
    const c = perCat[t.category] || (perCat[t.category] = { pass: 0, total: 0, tasks: 0, fail: {} });
    c.pass += pass; c.total += REPEATS; c.tasks += 1;
    for (const [r, n] of Object.entries(fail)) c.fail[r] = (c.fail[r] || 0) + n;
  }

  const categories = {};
  for (const [cat, c] of Object.entries(perCat)) {
    const rate = c.pass / c.total;
    categories[cat] = { passRate: +rate.toFixed(3), passed: c.pass, of: c.total, tasks: c.tasks, verdict: verdict(rate), fail: c.fail };
  }
  const overallPass = Object.values(perCat).reduce((a, c) => a + c.pass, 0);
  const overallTotal = Object.values(perCat).reduce((a, c) => a + c.total, 0);

  const report = {
    config: cfg.name,
    backend: process.env.BACKEND || 'claudberghini',
    model: process.env.EVAL_MODEL || 'claude-3-5-sonnet-20241022',
    toolSampleAttempts: process.env.TOOL_SAMPLE_ATTEMPTS || '(default 5)',
    answerSampleAttempts: process.env.ANSWER_SAMPLE_ATTEMPTS || '(default 3)',
    repeats: REPEATS,
    durationSec: Math.round((Date.now() - t0) / 1000),
    overall: +(overallPass / overallTotal).toFixed(3),
    categories,
    perTask,
  };

  // Machine-readable line + a human table.
  console.log('RELIABILITY_JSON ' + JSON.stringify(report));
  const lines = [];
  lines.push('');
  lines.push(`=== RELIABILITY: config=${report.config} backend=${report.backend} repeats=${REPEATS} bestOfN(tool/answer)=${report.toolSampleAttempts}/${report.answerSampleAttempts} ===`);
  lines.push(`overall: ${(report.overall * 100).toFixed(1)}%   (${report.durationSec}s)`);
  lines.push('');
  lines.push('CATEGORY        pass%   n     verdict       failure modes');
  lines.push('────────────────────────────────────────────────────────────────');
  const catOrder = Object.entries(categories).sort((a, b) => b[1].passRate - a[1].passRate);
  for (const [cat, c] of catOrder) {
    const fm = Object.entries(c.fail).map(([r, n]) => `${r}:${n}`).join(' ') || '—';
    lines.push(`${cat.padEnd(15)} ${(c.passRate * 100).toFixed(0).padStart(4)}%  ${String(c.of).padStart(3)}   ${c.verdict.padEnd(12)} ${fm}`);
  }
  lines.push('');
  lines.push('per-task:');
  for (const [name, t] of Object.entries(perTask).sort((a, b) => a[1].passRate - b[1].passRate)) {
    const fm = Object.entries(t.fail).map(([r, n]) => `${r}:${n}`).join(' ') || '';
    lines.push(`  ${(t.passRate * 100).toFixed(0).padStart(4)}%  ${name.padEnd(18)} [${t.category}] ${fm}`);
  }
  process.stderr.write(lines.join('\n') + '\n');

  if (process.env.EVAL_LABEL) {
    const out = path.join(__dirname, `reliability-${process.env.EVAL_LABEL}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    process.stderr.write(`\nwrote ${out}\n`);
  }
}

main().catch((e) => {
  console.log('RELIABILITY_JSON ' + JSON.stringify({ overall: 0, error: e.message }));
  console.error(e);
  process.exit(1);
});
