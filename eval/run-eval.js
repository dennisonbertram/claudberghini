/**
 * Eval runner / scorer.
 *
 * Usage:
 *   node run-eval.js --config config.json   # config = {name, system, tools:[...]}
 *   node run-eval.js                         # uses a baseline config
 *
 * Runs every task REPEATS times against the Claudberghini proxy and reports a JSON
 * scorecard: per-task pass rate + overall score. Designed to be invoked by the
 * optimization workflow and have its stdout JSON parsed.
 *
 * The `system` in the config is the FULL system prompt the harness sends. The
 * `tools` array selects which coding tools are offered. These are the two knobs
 * being optimized.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgentLoop } = require('./harness');
const { getToolSchemas, makeExecutor } = require('./tools-registry');
// Task set selectable via EVAL_TASKS (e.g. './tasks-hard') for continuous tuning.
const { TASKS } = require(process.env.EVAL_TASKS || './tasks');

// Default to 6 repeats — 3 was too noisy for reliable config comparison.
const REPEATS = Number(process.env.EVAL_REPEATS || 6);

function loadConfig() {
  const idx = process.argv.indexOf('--config');
  if (idx >= 0 && process.argv[idx + 1]) {
    return JSON.parse(fs.readFileSync(process.argv[idx + 1], 'utf8'));
  }
  // Baseline config
  return {
    name: 'baseline',
    system:
      'You are a coding agent. You have tools. To accomplish the user\'s task you MUST call the appropriate tool — you cannot read or change files by describing it. Use one tool at a time, then continue.',
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'LS'],
  };
}

async function runTask(task, config) {
  // Each repeat gets a fresh temp workspace
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `cjeval-${task.name}-`));
  try {
    task.setup(ws);
    const offered = (task.tools || []).filter((t) => config.tools.includes(t));
    const tools = getToolSchemas(offered.length ? offered : task.tools);
    const executeTool = makeExecutor(ws);
    const res = await runAgentLoop({
      system: config.system,
      tools,
      userPrompt: task.prompt,
      executeTool,
      maxTurns: Number(process.env.EVAL_MAX_TURNS || 6),
    });
    const passed = !res.error && task.verify({ finalText: res.finalText, workspace: ws });
    return { passed, turns: res.turns, toolCalls: res.toolCalls, timedOut: !!res.timedOut, error: !!res.error };
  } catch (e) {
    return { passed: false, error: true, message: e.message };
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const config = loadConfig();
  const perTask = {};
  let totalPass = 0;
  let totalRuns = 0;

  for (const task of TASKS) {
    let pass = 0;
    let toolCalls = 0;
    let timeouts = 0;
    for (let r = 0; r < REPEATS; r++) {
      const out = await runTask(task, config);
      if (out.passed) pass += 1;
      toolCalls += out.toolCalls || 0;
      if (out.timedOut) timeouts += 1;
      totalRuns += 1;
      if (out.passed) totalPass += 1;
    }
    perTask[task.name] = {
      passRate: +(pass / REPEATS).toFixed(3),
      passed: pass,
      of: REPEATS,
      avgToolCalls: +(toolCalls / REPEATS).toFixed(2),
      timeouts,
    };
  }

  const score = +(totalPass / totalRuns).toFixed(4);
  const result = {
    configName: config.name,
    score, // overall fraction of task-runs passed (0..1)
    repeats: REPEATS,
    toolCount: config.tools.length,
    systemBytes: Buffer.byteLength(config.system, 'utf8'),
    perTask,
  };
  // Machine-readable line for the workflow to parse, plus pretty output
  console.log('EVAL_RESULT_JSON ' + JSON.stringify(result));
  console.error(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.log('EVAL_RESULT_JSON ' + JSON.stringify({ score: 0, error: e.message }));
  console.error(e);
  process.exit(1);
});
